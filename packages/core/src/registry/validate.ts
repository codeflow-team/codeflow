/** Definition validation — 05-registry.md §1, §4, §5. */

import { CodeFlowError } from "../errors.js";
import type { EditableField, EditableFieldInput } from "../model/editable.js";
import { isJsonSchema, isNamedFieldsSchema, isTsTypeRef, type Schema } from "../model/schema.js";
import type { CoreNodeType } from "../model/graph.js";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Reserved words cannot be used as an import binding, so they cannot name a function. */
const RESERVED = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default", "delete", "do",
  "else", "enum", "export", "extends", "false", "finally", "for", "function", "if", "import",
  "in", "instanceof", "new", "null", "return", "super", "switch", "this", "throw", "true", "try",
  "typeof", "var", "void", "while", "with", "implements", "interface", "let", "package",
  "private", "protected", "public", "static", "yield", "await",
]);

const CORE_NODE_TYPES: ReadonlySet<string> = new Set<CoreNodeType>([
  "trigger", "tool", "function", "condition", "loop", "try", "jump", "parallel", "merge",
  "code", "output", "unknown",
]);

export function isValidTsIdentifier(name: string): boolean {
  return IDENTIFIER.test(name) && !RESERVED.has(name);
}

/** Tool names are namespaced: `namespace.method` (at least two segments). */
export function validateToolName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new CodeFlowError("invalid-tool-name", "Tool name must be a non-empty string.");
  }
  const segments = name.split(".");
  if (segments.length < 2) {
    throw new CodeFlowError(
      "invalid-tool-name",
      `Tool name "${name}" must be namespaced as "namespace.method" — a bare name cannot be reached through the generated \`Tools\` interface.`,
    );
  }
  for (const segment of segments) {
    if (!isValidTsIdentifier(segment)) {
      throw new CodeFlowError(
        "invalid-tool-name",
        `Tool name "${name}" has an invalid segment "${segment}" — each segment must be a valid TypeScript identifier.`,
      );
    }
  }
}

export function validateFunctionName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new CodeFlowError("invalid-function-name", "Function name must be a non-empty string.");
  }
  if (name.includes(".")) {
    throw new CodeFlowError(
      "invalid-function-name",
      `Function name "${name}" must not contain a dot — a namespaced name like "github.getFiles" belongs to a TOOL, not a library function.`,
    );
  }
  if (!isValidTsIdentifier(name)) {
    throw new CodeFlowError(
      "invalid-function-name",
      `Function name "${name}" is not a valid TypeScript identifier.`,
    );
  }
}

export function validateNodeType(type: string): void {
  if (typeof type !== "string" || type.length === 0) {
    throw new CodeFlowError("invalid-node-type", "Node type must be a non-empty string.");
  }
  if (CORE_NODE_TYPES.has(type)) {
    throw new CodeFlowError(
      "invalid-node-type",
      `Node type "${type}" is a core node type — plugins must register a new type (03 §3).`,
    );
  }
}

export function validateModulePath(modulePath: string): void {
  if (typeof modulePath !== "string" || modulePath.trim().length === 0) {
    throw new CodeFlowError(
      "invalid-module-path",
      "Function `modulePath` must be a non-empty module specifier (MVP: \"@flows/lib\").",
    );
  }
}

/**
 * A function's input schema names positional parameters, so it must be a
 * named-fields map (or a JSON Schema object whose `properties` play that role).
 * A bare TS type ref carries no parameter names and is rejected.
 */
export function validateFunctionInputSchema(functionName: string, schema: Schema): void {
  if (isTsTypeRef(schema)) {
    throw new CodeFlowError(
      "invalid-schema",
      `Function "${functionName}": inputSchema must be a named-fields map like { files: "File[]" } — a bare type reference carries no parameter names.`,
    );
  }
  const keys = inputSchemaFieldNames(schema);
  if (keys === null) {
    throw new CodeFlowError(
      "invalid-schema",
      `Function "${functionName}": inputSchema must be a named-fields map or a JSON Schema object with \`properties\`.`,
    );
  }
  for (const key of keys) {
    if (!isValidTsIdentifier(key)) {
      throw new CodeFlowError(
        "invalid-schema",
        `Function "${functionName}": inputSchema key "${key}" must be a valid TypeScript identifier (it must match a parameter name in \`code\`).`,
      );
    }
  }
}

/** Field names of an input schema, in declaration order. `null` when it has none. */
export function inputSchemaFieldNames(schema: Schema): string[] | null {
  if (isTsTypeRef(schema)) return null;
  if (isNamedFieldsSchema(schema)) return Object.keys(schema);
  if (isJsonSchema(schema)) {
    const properties = schema["properties"];
    if (typeof properties === "object" && properties !== null) {
      return Object.keys(properties as Record<string, unknown>);
    }
    return null;
  }
  return null;
}

/**
 * Whether an input schema says a field is required — with a third answer.
 *
 * Only JSON Schema can state this, and only when it carries a `required` array.
 * A named-fields map (`{ channel: "string" }`) and a TypeScript type ref have
 * no notion of requiredness at all, and a JSON Schema with no `required` key
 * has simply not said.
 *
 * The third answer is the point. Collapsing "unknown" into "optional" would let
 * a UI stay silent while a user removes the one property a call cannot work
 * without; collapsing it into "required" would cry on a correct edit until
 * people learn to skip the warning, and then it is not there for the one that
 * matters. Callers are expected to say something different in each case.
 */
export type Requiredness = "required" | "optional" | "unknown";

export function fieldRequiredness(schema: Schema, field: string): Requiredness {
  if (isTsTypeRef(schema) || isNamedFieldsSchema(schema)) return "unknown";
  if (!isJsonSchema(schema)) return "unknown";
  const required = schema["required"];
  if (!Array.isArray(required)) return "unknown";
  return required.includes(field) ? "required" : "optional";
}

/** `"channel"` ≡ `{ name: "channel" }` — 06 §1. */
export function normalizeEditableField(input: EditableFieldInput): EditableField {
  if (typeof input === "string") {
    if (input.length === 0) {
      throw new CodeFlowError("invalid-editable-field", "Editable field name must not be empty.");
    }
    return { name: input };
  }
  if (typeof input !== "object" || input === null || typeof input.name !== "string" || input.name.length === 0) {
    throw new CodeFlowError(
      "invalid-editable-field",
      "Editable field must be a non-empty string or an object with a non-empty `name`.",
    );
  }
  const field: EditableField = { name: input.name };
  if (input.label !== undefined) field.label = input.label;
  if (input.editor !== undefined) field.editor = input.editor;
  if (input.options !== undefined) field.options = [...input.options];
  return field;
}

export function normalizeEditableFields(inputs?: EditableFieldInput[]): EditableField[] {
  if (inputs === undefined) return [];
  if (!Array.isArray(inputs)) {
    throw new CodeFlowError("invalid-editable-field", "`editableFields` must be an array.");
  }
  const fields = inputs.map(normalizeEditableField);
  const seen = new Set<string>();
  for (const field of fields) {
    if (seen.has(field.name)) {
      throw new CodeFlowError(
        "invalid-editable-field",
        `Duplicate editable field "${field.name}".`,
      );
    }
    seen.add(field.name);
  }
  return fields;
}
