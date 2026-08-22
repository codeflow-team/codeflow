/**
 * Schema → TypeScript type text — 03-data-model.md §11.
 *
 * The three shapes of `Schema` convert as follows:
 *  - TS type ref      → used verbatim
 *  - named-fields map → object type (every field required; keys are parameter names)
 *  - JSON Schema      → basic structural conversion (object/array/string/number/
 *                       boolean/enum/const/union/intersection)
 *
 * Deliberately basic: the goal is a readable `.d.ts` for AI context and for the
 * `Tools` interface the analyzer resolves against, not a full JSON Schema compiler.
 */

import {
  isJsonSchema,
  isNamedFieldsSchema,
  isTsTypeRef,
  type JsonSchema,
  type NamedFieldsSchema,
  type Schema,
} from "../model/schema.js";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function union(parts: string[]): string {
  const unique = parts.filter((part, index) => parts.indexOf(part) === index);
  if (unique.length === 0) return "unknown";
  if (unique.length === 1) return unique[0]!;
  return unique.join(" | ");
}

function wrap(type: string): string {
  // Parenthesize unions before applying `[]`.
  return type.includes("|") || type.includes("&") ? `(${type})` : type;
}

function primitive(type: string): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    default:
      return "unknown";
  }
}

function refName(ref: string): string {
  const segment = ref.split("/").pop() ?? "";
  return IDENTIFIER.test(segment) ? segment : "unknown";
}

function objectType(schema: JsonSchema): string {
  const properties = schema["properties"];
  const required = new Set(
    Array.isArray(schema["required"]) ? (schema["required"] as unknown[]).map(String) : [],
  );

  if (typeof properties === "object" && properties !== null) {
    const entries = Object.entries(properties as Record<string, Schema>);
    if (entries.length === 0) return "Record<string, unknown>";
    const fields = entries.map(([key, value]) => {
      const optional = required.has(key) ? "" : "?";
      return `${propertyKey(key)}${optional}: ${schemaToTs(value)}`;
    });
    return `{ ${fields.join("; ")} }`;
  }

  const additional = schema["additionalProperties"];
  if (typeof additional === "object" && additional !== null) {
    return `Record<string, ${schemaToTs(additional as Schema)}>`;
  }
  return "Record<string, unknown>";
}

function jsonSchemaToTs(schema: JsonSchema): string {
  const ref = schema["$ref"];
  if (typeof ref === "string") return refName(ref);

  if ("const" in schema) return JSON.stringify(schema["const"] ?? null);

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues)) {
    return union(enumValues.map((value) => JSON.stringify(value ?? null)));
  }

  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      return union((branches as Schema[]).map((branch) => schemaToTs(branch)));
    }
  }

  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    const parts = (allOf as Schema[]).map((branch) => wrap(schemaToTs(branch)));
    return parts.length > 0 ? parts.join(" & ") : "unknown";
  }

  const type = schema["type"];
  const types = Array.isArray(type) ? type.map(String) : typeof type === "string" ? [type] : [];

  const rendered = types.map((entry) => {
    if (entry === "object") return objectType(schema);
    if (entry === "array") {
      const items = schema["items"];
      if (typeof items === "object" && items !== null && !Array.isArray(items)) {
        return `${wrap(schemaToTs(items as Schema))}[]`;
      }
      if (typeof items === "string") return `${wrap(items)}[]`;
      return "unknown[]";
    }
    return primitive(entry);
  });

  const base = rendered.length > 0 ? union(rendered) : "unknown";
  return schema["nullable"] === true ? union([base, "null"]) : base;
}

/** Convert any of the three `Schema` shapes to TypeScript type text. */
export function schemaToTs(schema: Schema): string {
  if (isTsTypeRef(schema)) return schema;
  if (isJsonSchema(schema)) return jsonSchemaToTs(schema);
  if (isNamedFieldsSchema(schema)) {
    const entries = Object.entries(schema as NamedFieldsSchema);
    if (entries.length === 0) return "{}";
    const fields = entries.map(([key, value]) => `${propertyKey(key)}: ${schemaToTs(value)}`);
    return `{ ${fields.join("; ")} }`;
  }
  return "unknown";
}
