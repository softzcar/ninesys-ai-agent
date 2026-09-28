# ninesys-ai-agent

Capa **Node reutilizable** del ecosistema Ninesys que corre el bucle de IA sobre
el **servidor MCP** (`mcp_ninesys`). Encapsula, **una sola vez**, la conexión al
MCP, el mapeo de sus tools a `functionDeclarations` de Gemini y el bucle de
tool-use. Reemplaza el `contextEnricher` especulativo de `msg_ninesys` y el chat
PHP (`GeminiChatAssistant`) de `app_multi`.

## Dos modos de consumo (mismo código)

1. **Librería** — para apps Node (p.ej. `msg_ninesys`):

   ```ts
   import { createNinesysAgent } from "ninesys-ai-agent";

   const agent = createNinesysAgent({
     mcpUrl: "http://127.0.0.1:3100/mcp",
     mcpToken: process.env.MCP_TOKEN!,
     geminiApiKey: process.env.GEMINI_API_KEY!,
     model: "gemini-2.5-flash",
     systemPrompt: "…",
   });

   const { text, toolCalls } = await agent.chat({
     query: "¿precio de franelas para 20?",
     history: [],
     idEmpresa: 208,
   });
   ```

2. **Servicio HTTP** — para SPAs sin backend (p.ej. `app_multi`) y futuras apps:

   `POST /chat` (auth `Authorization: Bearer <AGENT_CLIENT_TOKENS>`, CORS por
   origen), body `{ query, history?, id_empresa }` → `{ success, text, toolCalls, steps }`.
   `npm start` levanta el servicio (ver `.env.example`).

## Seguridad / multi-empresa

- El agente **nunca** deja que el LLM maneje la empresa. `idEmpresa` se pasa por
  conversación y viaja al MCP en la cabecera `X-Ninesys-Empresa`; el MCP la exige
  y la inyecta a sus tools. Sin empresa no hay acceso.
- Dos fronteras de token: las apps se autentican ante el agente
  (`AGENT_CLIENT_TOKENS`), y el agente se autentica ante el MCP (`MCP_TOKEN`).

## Desarrollo

```bash
npm install
cp .env.example .env   # completar MCP_URL, MCP_TOKEN, GEMINI_API_KEY, AGENT_CLIENT_TOKENS
npm run dev            # servicio con recarga
npm run build          # compila a dist/ (librería + servicio)
```

## Despliegue

PM2 + reverse-proxy HTTPS (OLS/Nginx), mismo patrón que el resto del ecosistema.
Pensado para un subdominio propio (p.ej. `ai.nineteengreen.com` en Dev) al que
apuntan las SPAs; las apps Node pueden además embeberlo como librería.
