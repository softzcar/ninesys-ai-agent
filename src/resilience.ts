import { createLogger } from "./lib/logger.js";

const log = createLogger("resilience");

// Timeout + reintentos con backoff + circuit breaker por proceso.
// Portado del patrón probado en msg_ninesys/src/services/aiService.js.

const RETRIES = Number(process.env.AI_RETRIES || 2);
const BACKOFF_BASE_MS = 500;
const CB_FAIL_THRESHOLD = Number(process.env.AI_CB_THRESHOLD || 5);
const CB_COOLDOWN_MS = Number(process.env.AI_CB_COOLDOWN_MS || 30_000);

type BreakerState = "closed" | "open" | "half-open";

interface Breaker {
  state: BreakerState;
  failures: number;
  openedAt: number;
}

// Un breaker por "canal" lógico (ej. 'gemini', 'mcp') para no acoplar fallos.
const breakers = new Map<string, Breaker>();
function getBreaker(key: string): Breaker {
  let b = breakers.get(key);
  if (!b) {
    b = { state: "closed", failures: 0, openedAt: 0 };
    breakers.set(key, b);
  }
  return b;
}

function canPass(b: Breaker): boolean {
  if (b.state === "closed") return true;
  if (b.state === "open") {
    if (Date.now() - b.openedAt >= CB_COOLDOWN_MS) {
      b.state = "half-open";
      return true;
    }
    return false;
  }
  return true;
}

function onSuccess(b: Breaker) {
  b.state = "closed";
  b.failures = 0;
  b.openedAt = 0;
}

function onFailure(b: Breaker, key: string) {
  b.failures += 1;
  if (b.state === "half-open" || b.failures >= CB_FAIL_THRESHOLD) {
    b.state = "open";
    b.openedAt = Date.now();
    log.error({ channel: key, failures: b.failures }, "circuit breaker ABIERTO");
  }
}

function isRetryable(err: unknown): boolean {
  const e = err as { code?: string; status?: number; response?: { status?: number }; message?: string };
  if (!e) return false;
  if (e.code === "ETIMEDOUT" || e.code === "ECONNRESET" || e.code === "ECONNABORTED") return true;
  if (e.message && /timeout/i.test(e.message)) return true;
  const status = e.status || e.response?.status;
  return status === 429 || status === 502 || status === 503 || status === 504;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`timeout ${ms}ms`);
      (e as { code?: string }).code = "ETIMEDOUT";
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Ejecuta fn con timeout, reintentos y circuit breaker sobre el canal `channel`.
 */
export async function withResilience<T>(
  channel: string,
  timeoutMs: number,
  fn: () => Promise<T>
): Promise<T> {
  const b = getBreaker(channel);
  if (!canPass(b)) {
    const e = new Error(`circuito ${channel} abierto`);
    (e as { code?: string }).code = "CIRCUIT_OPEN";
    throw e;
  }
  let lastErr: unknown;
  const maxAttempts = 1 + RETRIES;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await withTimeout(fn(), timeoutMs);
      onSuccess(b);
      return res;
    } catch (e) {
      lastErr = e;
      const retryable = isRetryable(e);
      log.warn({ channel, attempt, maxAttempts, retryable }, "intento falló");
      if (!retryable || attempt === maxAttempts) break;
      const base = BACKOFF_BASE_MS * Math.pow(2, attempt - 1);
      await sleep(base + Math.random() * base * 0.5);
    }
  }
  onFailure(b, channel);
  throw lastErr;
}
