// Punto de entrada como LIBRERÍA (para apps Node como msg_ninesys).
// El modo SERVICIO HTTP vive en server.ts.
export { createNinesysAgent } from "./agent.js";
export type {
  NinesysAgent,
  AgentConfig,
  ChatParams,
  ChatResult,
  ChatImage,
  ChatTurn,
  ToolCallTrace,
} from "./agent.js";
