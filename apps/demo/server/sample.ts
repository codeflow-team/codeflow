/**
 * Made-up values, generated from a schema.
 *
 * Used for two things, both of which have to be labelled as fake wherever they
 * surface: the return value of a tool with no server behind it (`github.*`,
 * `slack.*`, `payment.*`, the network-backed MCP servers this runner will not
 * dial), and a default `input` for a flow nobody typed one for.
 *
 * The values are deterministic — same schema in, same value out — so a run can
 * be repeated and compared. They are also obviously synthetic on sight
 * (`"sample title"`, `42`), because a plausible-looking fake is worse than an
 * implausible one: the UI says "sample data" next to it, and the value itself
 * should not argue.
 */

export interface JsonSchemaish {
  type?: string | string[];
  properties?: Record<string, JsonSchemaish>;
  required?: string[];
  items?: JsonSchemaish;
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  format?: string;
  description?: string;
  anyOf?: JsonSchemaish[];
  oneOf?: JsonSchemaish[];
  allOf?: JsonSchemaish[];
  additionalProperties?: boolean | JsonSchemaish;
}

function isSchema(value: unknown): value is JsonSchemaish {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A stable-ish pseudo-number so repeated fields do not all read as `42`. */
function hashed(seed: string, modulo: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return Math.abs(hash) % modulo;
}

/**
 * One value that satisfies `schema`.
 *
 * `depth` guards against a self-referential schema; `name` is the property this
 * value belongs to, used only to make strings read like the field they fill.
 */
export function sampleFromSchema(schema: unknown, name = "value", depth = 0): unknown {
  if (!isSchema(schema)) return `sample ${name}`;
  if (depth > 6) return null;

  if (schema.const !== undefined) return schema.const;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches) && branches.length > 0) {
    return sampleFromSchema(branches[0], name, depth + 1);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged: Record<string, unknown> = {};
    for (const part of schema.allOf) {
      const value = sampleFromSchema(part, name, depth + 1);
      if (isSchema(value)) Object.assign(merged, value);
    }
    return merged;
  }

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;

  switch (type) {
    case "string": {
      if (schema.format === "date-time") return new Date(0).toISOString();
      if (schema.format === "uri") return "https://example.invalid/sample";
      return `sample ${name}`;
    }
    case "number":
    case "integer":
      return hashed(name, 90) + 10;
    case "boolean":
      return false;
    case "null":
      return null;
    case "array": {
      const item = sampleFromSchema(schema.items ?? {}, name, depth + 1);
      return [item, item];
    }
    case "object":
    default: {
      if (schema.properties === undefined) {
        // A schema with no shape at all — `{}` is the only honest answer.
        return type === undefined && schema.items === undefined ? {} : {};
      }
      const out: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(schema.properties)) {
        out[key] = sampleFromSchema(property, key, depth + 1);
      }
      return out;
    }
  }
}

/** Shorten anything for display, without pretending it was not shortened. */
export function preview(value: unknown, maxChars = 600): unknown {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) return String(value);
  if (text.length <= maxChars) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return { __truncated: true, chars: text.length, text: `${text.slice(0, maxChars)}…` };
}
