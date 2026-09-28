import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import { timingSafeEqual } from "node:crypto";
import { createNinesysAgent } from "./agent.js";
import { createLogger } from "./lib/logger.js";

const log = createLogger("server");

const PORT = Number(process.env.PORT || 3200);

// --- Config obligatoria ---
const MCP_URL = process.env.MCP_URL || "";
const MCP_TOKEN = process.env.MCP_TOKEN || "";
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

// --- Auth del servicio /chat (tokens de las apps que llaman a ESTE agente) ---
function parseTokens(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const part of (raw || "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const idx = entry.indexOf(":");
    if (idx > 0) map.set(entry.slice(idx + 1).trim(), entry.slice(0, idx).trim());
    else map.set(entry, "anon");
  }
  return map;
}
const CLIENT_TOKENS = parseTokens(process.env.AGENT_CLIENT_TOKENS || "");

function safeMatch(provided: string): string | null {
  const p = Buffer.from(provided);
  for (const [token, name] of CLIENT_TOKENS) {
    const t = Buffer.from(token);
    if (t.length === p.length && timingSafeEqual(t, p)) return name;
  }
  return null;
}

function requireBearer(req: Request, res: Response, next: NextFunction): void {
  const m = (req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!m || !safeMatch(m[1])) {
    res.status(401).json({ error: "unauthorized", message: "Token Bearer ausente o inválido." });
    return;
  }
  next();
}

async function main() {
  const missing = [
    !MCP_URL && "MCP_URL",
    !MCP_TOKEN && "MCP_TOKEN",
    !GEMINI_API_KEY && "GEMINI_API_KEY",
  ].filter(Boolean);
  if (missing.length) {
    log.error({ missing }, "faltan variables de entorno obligatorias");
    process.exit(1);
  }
  if (CLIENT_TOKENS.size === 0) {
    log.warn("AGENT_CLIENT_TOKENS vacío — /chat rechazará todas las peticiones (401).");
  }

  const agent = createNinesysAgent({
    mcpUrl: MCP_URL,
    mcpToken: MCP_TOKEN,
    geminiApiKey: GEMINI_API_KEY,
  });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const origins = (process.env.AGENT_CORS_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  app.use(cors({ origin: origins.length ? origins : false, methods: ["POST", "GET"] }));

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "ninesys-ai-agent" });
  });

  // POST /chat  { query, history?, id_empresa }
  app.post("/chat", requireBearer, async (req: Request, res: Response) => {
    const { query, history, id_empresa } = req.body || {};
    const idEmpresa = Number(id_empresa);
    if (!query || typeof query !== "string") {
      res.status(400).json({ error: "bad_request", message: "Falta 'query' (string)." });
      return;
    }
    if (!Number.isInteger(idEmpresa) || idEmpresa <= 0) {
      res.status(400).json({ error: "bad_request", message: "Falta 'id_empresa' (entero positivo)." });
      return;
    }
    try {
      const result = await agent.chat({
        query,
        history: Array.isArray(history) ? history : [],
        idEmpresa,
      });
      res.json({ success: true, ...result });
    } catch (e) {
      log.error({ err: (e as Error).message, idEmpresa }, "error en /chat");
      res.status(500).json({ success: false, error: "internal_error", message: "Fallo procesando la consulta." });
    }
  });

  app.listen(PORT, () => log.info({ port: PORT }, "ninesys-ai-agent (servicio /chat) escuchando"));
}

main().catch((err) => {
  log.error({ err: (err as Error).message }, "fallo al arrancar");
  process.exit(1);
});
