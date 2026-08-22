/**
 * Schema union — 03-data-model.md §11.
 *
 * Three shapes share one union:
 *  1. JSON Schema object      — MCP origin; inspector can render + validate a form
 *  2. TS type ref string      — "File[]", "boolean"; inspector falls back to the
 *                               expression editor
 *  3. Named-fields map        — { files: "File[]" }; shorthand for an object input,
 *                               keys are parameter/property names
 */

/** Standard JSON Schema draft — deliberately not redefined here. */
export type JsonSchema = Record<string, unknown>;

/** A TypeScript type reference, used verbatim in generated `.d.ts`. */
export type TsTypeRef = string;

export type NamedFieldsSchema = Record<string, JsonSchema | TsTypeRef>;

export type Schema = JsonSchema | TsTypeRef | NamedFieldsSchema;

/** Keys that only ever appear in a JSON Schema, never as a named field. */
const JSON_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$ref",
  "$defs",
  "type",
  "properties",
  "items",
  "prefixItems",
  "required",
  "enum",
  "const",
  "oneOf",
  "anyOf",
  "allOf",
  "not",
  "additionalProperties",
  "format",
  "nullable",
  "definitions",
]);

export function isTsTypeRef(schema: Schema): schema is TsTypeRef {
  return typeof schema === "string";
}

/**
 * Discriminates shape 1 from shape 3. A record carrying any JSON Schema keyword
 * at the top level is a JSON Schema; anything else is a named-fields map.
 * Ambiguity (a field literally named `type`) resolves to JSON Schema — documented
 * limitation, matches the union's intent.
 */
export function isJsonSchema(schema: Schema): schema is JsonSchema {
  if (typeof schema !== "object" || schema === null) return false;
  return Object.keys(schema).some((key) => JSON_SCHEMA_KEYWORDS.has(key));
}

export function isNamedFieldsSchema(schema: Schema): schema is NamedFieldsSchema {
  return typeof schema === "object" && schema !== null && !isJsonSchema(schema);
}
