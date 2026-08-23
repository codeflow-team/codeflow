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

/**
 * Conversion state. `$ref` is resolved **inline** against the root schema's
 * `$defs`/`definitions` rather than emitted as a bare type name: the generated
 * `.d.ts` declares no such name, so `{ issue: Issue }` would be a dangling
 * reference — a file that does not type-check, which is worse than a widened
 * type. `expanding` breaks reference cycles (a `$ref` that reaches itself
 * resolves to `unknown`, since an inline expansion of it has no fixed point).
 */
interface Ctx {
  defs: Record<string, Schema>;
  expanding: ReadonlySet<string>;
}

const EMPTY_CTX: Ctx = { defs: {}, expanding: new Set() };

function definitionsOf(schema: JsonSchema): Record<string, Schema> {
  const collected: Record<string, Schema> = {};
  for (const key of ["$defs", "definitions"] as const) {
    const bucket = schema[key];
    if (typeof bucket === "object" && bucket !== null && !Array.isArray(bucket)) {
      Object.assign(collected, bucket as Record<string, Schema>);
    }
  }
  return collected;
}

/**
 * Resolve a local JSON pointer (`#/$defs/Issue`, `#/definitions/Issue`) against
 * the definitions collected so far. Remote refs and pointers into anything other
 * than a definition bucket are not resolvable here and widen to `unknown`.
 */
function resolveRef(ref: string, ctx: Ctx): string {
  const segments = ref.split("/");
  const name = segments.pop() ?? "";
  const bucket = segments.pop() ?? "";
  const target =
    ref.startsWith("#/") && (bucket === "$defs" || bucket === "definitions")
      ? ctx.defs[name]
      : undefined;
  if (target === undefined || ctx.expanding.has(ref)) return "unknown";
  return convert(target, { defs: ctx.defs, expanding: new Set([...ctx.expanding, ref]) });
}

function objectType(schema: JsonSchema, ctx: Ctx): string {
  const properties = schema["properties"];
  const required = new Set(
    Array.isArray(schema["required"]) ? (schema["required"] as unknown[]).map(String) : [],
  );

  if (typeof properties === "object" && properties !== null) {
    const entries = Object.entries(properties as Record<string, Schema>);
    if (entries.length === 0) return "Record<string, unknown>";
    const fields = entries.map(([key, value]) => {
      const optional = required.has(key) ? "" : "?";
      return `${propertyKey(key)}${optional}: ${convert(value, ctx)}`;
    });
    return `{ ${fields.join("; ")} }`;
  }

  const additional = schema["additionalProperties"];
  if (typeof additional === "object" && additional !== null) {
    return `Record<string, ${convert(additional as Schema, ctx)}>`;
  }
  return "Record<string, unknown>";
}

function jsonSchemaToTs(schema: JsonSchema, parent: Ctx): string {
  // Definitions can be declared at any level, and inner ones shadow outer ones.
  const local = definitionsOf(schema);
  const ctx: Ctx =
    Object.keys(local).length === 0
      ? parent
      : { defs: { ...parent.defs, ...local }, expanding: parent.expanding };

  const ref = schema["$ref"];
  if (typeof ref === "string") return resolveRef(ref, ctx);

  if ("const" in schema) return JSON.stringify(schema["const"] ?? null);

  const enumValues = schema["enum"];
  if (Array.isArray(enumValues)) {
    return union(enumValues.map((value) => JSON.stringify(value ?? null)));
  }

  for (const key of ["oneOf", "anyOf"] as const) {
    const branches = schema[key];
    if (Array.isArray(branches)) {
      return union((branches as Schema[]).map((branch) => convert(branch, ctx)));
    }
  }

  const allOf = schema["allOf"];
  if (Array.isArray(allOf)) {
    const parts = (allOf as Schema[]).map((branch) => wrap(convert(branch, ctx)));
    return parts.length > 0 ? parts.join(" & ") : "unknown";
  }

  const type = schema["type"];
  const types = Array.isArray(type) ? type.map(String) : typeof type === "string" ? [type] : [];

  const rendered = types.map((entry) => {
    if (entry === "object") return objectType(schema, ctx);
    if (entry === "array") {
      const items = schema["items"];
      if (typeof items === "object" && items !== null && !Array.isArray(items)) {
        return `${wrap(convert(items as Schema, ctx))}[]`;
      }
      if (typeof items === "string") return `${wrap(items)}[]`;
      return "unknown[]";
    }
    return primitive(entry);
  });

  const base = rendered.length > 0 ? union(rendered) : "unknown";
  return schema["nullable"] === true ? union([base, "null"]) : base;
}

function convert(schema: Schema, ctx: Ctx): string {
  if (isTsTypeRef(schema)) return schema;
  if (isJsonSchema(schema)) return jsonSchemaToTs(schema, ctx);
  if (isNamedFieldsSchema(schema)) {
    const entries = Object.entries(schema as NamedFieldsSchema);
    if (entries.length === 0) return "{}";
    const fields = entries.map(([key, value]) => `${propertyKey(key)}: ${convert(value, ctx)}`);
    return `{ ${fields.join("; ")} }`;
  }
  return "unknown";
}

/** Convert any of the three `Schema` shapes to TypeScript type text. */
export function schemaToTs(schema: Schema): string {
  return convert(schema, EMPTY_CTX);
}
