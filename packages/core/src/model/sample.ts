/**
 * Made-up values, generated from a declared schema.
 *
 * Two very different callers need this, and they must agree: the demo runner
 * answers a tool that has no server behind it with a sample value, and the UI
 * shows a sample under a binding that has not been observed yet. If those two
 * were separate implementations the picture would disagree with the run for the
 * same schema — the same class of divergence `tools.d.ts` exists to prevent
 * (05 §2: one source, several consumers). So it lives here, once.
 *
 * It belongs in core because it is a pure function of a JSON Schema: no tool is
 * named, nothing is executed, nothing imports a Node API (I7, and the rule that
 * core never hardcodes a specific tool or MCP server).
 *
 * Two properties are load-bearing and must survive any edit:
 *
 *  - **Deterministic** — same schema in, same value out, so a run can be
 *    repeated and compared, and so the UI does not reshuffle on re-render.
 *  - **Obviously synthetic on sight** (`"sample title"`, `42`) — a plausible
 *    fake is worse than an implausible one. Whatever renders these must also
 *    say they are samples (07 §5); the value itself should not argue with that
 *    label.
 */

/**
 * The subset of JSON Schema this reads. Deliberately structural rather than
 * `Schema` from schema.ts: a caller may hand over a fragment (`items`, one
 * `anyOf` branch) that is not a whole declared schema.
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
        return {};
      }
      const out: Record<string, unknown> = {};
      for (const [key, property] of Object.entries(schema.properties)) {
        out[key] = sampleFromSchema(property, key, depth + 1);
      }
      return out;
    }
  }
}
