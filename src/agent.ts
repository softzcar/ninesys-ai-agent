import { GoogleGenAI, FunctionCallingConfigMode } from "@google/genai";
import type { Content } from "@google/genai";
import { McpConnection } from "./mcpClient.js";
import { toGeminiFunctionDeclarations } from "./geminiBridge.js";
import { withResilience } from "./resilience.js";
import { createLogger } from "./lib/logger.js";

const log = createLogger("agent");

const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 15000);

export interface AgentConfig {
  mcpUrl: string;
  mcpToken: string;
  geminiApiKey: string;
  model?: string;
  systemPrompt?: string;
  maxSteps?: number;
}

export interface ChatTurn {
  role: "user" | "model";
  text: string;
}

export interface ChatParams {
  query: string;
  history?: ChatTurn[];
  idEmpresa: number;
  // Permite sobreescribir el system prompt por conversación (opcional).
  systemPrompt?: string;
}

export interface ToolCallTrace {
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCallTrace[];
  steps: number;
}

export interface NinesysAgent {
  chat(params: ChatParams): Promise<ChatResult>;
}

/**
 * Gemini a veces llama las funciones recortando el prefijo (p.ej. "search_customers"
 * en vez de "ninesys_search_customers"). Resuelve el nombre pedido contra las tools
 * reales: exacto, luego con prefijo "ninesys_", luego coincidencia única por sufijo.
 * Devuelve null si no hay una resolución inequívoca.
 */
function resolveToolName(requested: string, toolNames: string[]): string | null {
  if (toolNames.includes(requested)) return requested;
  const prefixed = `ninesys_${requested}`;
  if (toolNames.includes(prefixed)) return prefixed;
  const bySuffix = toolNames.filter((t) => t.endsWith(`_${requested}`));
  return bySuffix.length === 1 ? bySuffix[0] : null;
}

function historyToContents(history: ChatTurn[]): Content[] {
  return history
    .filter((h) => h.text && h.text.trim())
    .map((h) => ({ role: h.role, parts: [{ text: h.text }] }));
}

/**
 * Crea un agente reutilizable que corre el bucle de tool-use de Gemini contra el
 * MCP de Ninesys. La empresa se pasa por conversación (chat({ idEmpresa })) y
 * viaja al MCP en la cabecera de la conexión — el LLM nunca la maneja.
 */
export function createNinesysAgent(config: AgentConfig): NinesysAgent {
  const model = config.model || process.env.AI_MODEL || "gemini-2.5-flash";
  const defaultSystemPrompt =
    config.systemPrompt ||
    process.env.AI_SYSTEM_PROMPT ||
    "Eres el asistente de Ninesys. Usa las herramientas para obtener datos reales; si una herramienta no devuelve datos, dilo. Sé breve.";
  const maxSteps = config.maxSteps || Number(process.env.AI_MAX_STEPS || 6);
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });

  async function chat({ query, history = [], idEmpresa, systemPrompt }: ChatParams): Promise<ChatResult> {
    if (!Number.isInteger(idEmpresa) || idEmpresa <= 0) {
      throw new Error("idEmpresa es obligatorio y debe ser un entero positivo.");
    }

    const mcp = new McpConnection({ mcpUrl: config.mcpUrl, mcpToken: config.mcpToken, idEmpresa });
    const toolCalls: ToolCallTrace[] = [];
    try {
      const tools = await mcp.listTools();
      const toolNames = tools.map((t) => t.name);
      const functionDeclarations = toGeminiFunctionDeclarations(tools);

      const contents: Content[] = [...historyToContents(history), { role: "user", parts: [{ text: query }] }];

      const genConfig = {
        systemInstruction: systemPrompt || defaultSystemPrompt,
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } },
        thinkingConfig: { thinkingBudget: 0 },
      };

      let steps = 0;
      while (steps < maxSteps) {
        steps++;
        const response = await withResilience("gemini", GEMINI_TIMEOUT_MS, () =>
          ai.models.generateContent({ model, contents, config: genConfig })
        );

        const calls = response.functionCalls || [];
        if (!calls.length) {
          return { text: (response.text || "").trim(), toolCalls, steps };
        }

        // Turno del modelo: incluir las llamadas a función tal como las pidió.
        contents.push({
          role: "model",
          parts: calls.map((c) => ({ functionCall: { name: c.name, args: c.args || {} } })),
        });

        // Ejecutar cada tool contra el MCP y devolver las respuestas.
        const responseParts = [];
        for (const call of calls) {
          // `name` es el que pidió el modelo (se devuelve tal cual en functionResponse);
          // `resolved` es el nombre real en el MCP.
          const name = call.name || "";
          const resolved = resolveToolName(name, toolNames);
          const args = (call.args || {}) as Record<string, unknown>;
          let text = "";
          let isError = false;
          if (!resolved) {
            text =
              `La herramienta "${name}" no existe. Herramientas disponibles: ${toolNames.join(", ")}. ` +
              `Vuelve a intentarlo usando el nombre exacto.`;
            isError = true;
          } else {
            if (resolved !== name) {
              log.warn({ pedido: name, resuelto: resolved }, "nombre de tool corregido");
            }
            try {
              const r = await mcp.callTool(resolved, args);
              text = r.text;
              isError = r.isError;
            } catch (e) {
              text = `Error ejecutando la herramienta: ${(e as Error).message}`;
              isError = true;
            }
          }
          toolCalls.push({ name: resolved || name, args, isError });
          responseParts.push({
            functionResponse: { name, response: { result: text, isError } },
          });
        }
        contents.push({ role: "user", parts: responseParts });
      }

      log.warn({ idEmpresa, maxSteps }, "límite de pasos alcanzado sin respuesta final");
      return {
        text: "No pude completar la consulta en el número de pasos permitido. Intenta reformular.",
        toolCalls,
        steps,
      };
    } finally {
      await mcp.close();
    }
  }

  return { chat };
}
