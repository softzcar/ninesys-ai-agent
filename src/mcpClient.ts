import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { withResilience } from "./resilience.js";
import { createLogger } from "./lib/logger.js";
import type { McpToolDef } from "./geminiBridge.js";

const log = createLogger("mcpClient");

const MCP_TIMEOUT_MS = Number(process.env.MCP_TIMEOUT_MS || 8000);

// La empresa (X-Ninesys-Empresa) es obligatoria en cada petición al MCP. Se
// abre una conexión por conversación con la empresa de ese contexto.
export interface McpConfig {
  mcpUrl: string;
  mcpToken: string;
  idEmpresa: number;
}

// El listado de tools es idéntico entre empresas (solo cambian los datos que
// devuelven), así que se cachea por URL de MCP.
const toolListCache = new Map<string, { tools: McpToolDef[]; fetchedAt: number }>();
const TOOL_LIST_TTL_MS = 10 * 60 * 1000;

export class McpConnection {
  private client: Client;
  private transport: StreamableHTTPClientTransport;
  private connected = false;

  constructor(private cfg: McpConfig) {
    this.transport = new StreamableHTTPClientTransport(new URL(cfg.mcpUrl), {
      requestInit: {
        headers: {
          Authorization: `Bearer ${cfg.mcpToken}`,
          "X-Ninesys-Empresa": String(cfg.idEmpresa),
        },
      },
    });
    this.client = new Client(
      { name: "ninesys-ai-agent", version: "0.1.0" },
      { capabilities: {} }
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await withResilience("mcp", MCP_TIMEOUT_MS, () => this.client.connect(this.transport));
    this.connected = true;
  }

  async listTools(): Promise<McpToolDef[]> {
    const cached = toolListCache.get(this.cfg.mcpUrl);
    if (cached && Date.now() - cached.fetchedAt < TOOL_LIST_TTL_MS) return cached.tools;

    await this.connect();
    const res = await withResilience("mcp", MCP_TIMEOUT_MS, () => this.client.listTools());
    const tools: McpToolDef[] = (res.tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as McpToolDef["inputSchema"],
    }));
    toolListCache.set(this.cfg.mcpUrl, { tools, fetchedAt: Date.now() });
    log.info({ mcpUrl: this.cfg.mcpUrl, count: tools.length }, "tools listadas");
    return tools;
  }

  /**
   * Llama a una tool del MCP. Devuelve el texto plano concatenado del content
   * (que es lo que se le devuelve a Gemini como functionResponse) y una bandera
   * isError. La empresa ya viaja en la cabecera de la conexión, no en args.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    await this.connect();
    const res = await withResilience("mcp", MCP_TIMEOUT_MS, () =>
      this.client.callTool({ name, arguments: args })
    );
    const content = Array.isArray(res.content) ? res.content : [];
    const text = content
      .filter((c: { type: string }) => c.type === "text")
      .map((c: { text?: string }) => c.text || "")
      .join("\n");
    return { text, isError: res.isError === true };
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.close();
    } catch {
      /* noop */
    }
    this.connected = false;
  }
}
