import pino from "pino";

const level = process.env.LOG_LEVEL || "info";
const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level,
  redact: {
    paths: [
      "authorization",
      "req.headers.authorization",
      "*.token",
      "*.MCP_TOKEN",
      "*.GEMINI_API_KEY",
    ],
    censor: "[redacted]",
  },
  ...(isDev
    ? { transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } } }
    : {}),
});

export function createLogger(name: string) {
  return logger.child({ mod: name });
}
