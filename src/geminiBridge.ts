import { Type } from "@google/genai";
import type { FunctionDeclaration, Schema } from "@google/genai";

// Convierte un JSON Schema (draft-07, tal como lo emite el MCP a partir de Zod)
// al subset de Schema que acepta Gemini para functionDeclarations. Ignora claves
// no soportadas ($schema, additionalProperties, etc.) y mapea tipos.

const TYPE_MAP: Record<string, Type> = {
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
  object: Type.OBJECT,
};

interface JsonSchema {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  [k: string]: unknown;
}

function convertSchema(js: JsonSchema | undefined): Schema {
  if (!js || typeof js !== "object") return { type: Type.OBJECT };

  // type puede venir como ['string','null'] → tomar el primer no-null y marcar nullable.
  let rawType = js.type;
  let nullable = false;
  if (Array.isArray(rawType)) {
    nullable = rawType.includes("null");
    rawType = rawType.find((t) => t !== "null");
  }
  const type = rawType ? TYPE_MAP[rawType as string] : undefined;

  const out: Schema = {};
  if (type) out.type = type;
  if (nullable) out.nullable = true;
  if (js.description) out.description = js.description;
  if (Array.isArray(js.enum)) out.enum = js.enum.map((v) => String(v));

  if (type === Type.OBJECT && js.properties) {
    out.properties = {};
    for (const [key, val] of Object.entries(js.properties)) {
      out.properties[key] = convertSchema(val);
    }
    if (Array.isArray(js.required) && js.required.length) out.required = js.required;
  }
  if (type === Type.ARRAY && js.items) {
    out.items = convertSchema(js.items);
  }
  return out;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: JsonSchema;
}

/**
 * Mapea las tools listadas por el MCP a functionDeclarations de Gemini.
 */
export function toGeminiFunctionDeclarations(tools: McpToolDef[]): FunctionDeclaration[] {
  return tools.map((t) => {
    const params = convertSchema(t.inputSchema);
    // Gemini exige que parameters sea un OBJECT; si la tool no tiene propiedades,
    // igual mandamos un object vacío válido.
    if (params.type !== Type.OBJECT) {
      return { name: t.name, description: t.description, parameters: { type: Type.OBJECT, properties: {} } };
    }
    if (!params.properties) params.properties = {};
    return { name: t.name, description: t.description, parameters: params };
  });
}
