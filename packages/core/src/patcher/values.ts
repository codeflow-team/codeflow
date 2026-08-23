/**
 * Field values — the encoding of `changes`, and how a value is written back
 * **relative to the AST form it replaces** (06 §3).
 *
 * The hard rule of §3: the friendly `{{ }}` display is a *display* syntax, not
 * an encoding. The way back into the source never parses display text; it edits
 * the original AST form. A string literal stays a string literal (even when the
 * new text contains `${`), a template literal stays a template literal, a bare
 * expression stays an expression — and the kind only ever changes when the edit
 * says so **explicitly**.
 *
 * Encoding (all forms accepted anywhere a field value is expected):
 *
 * | change value                        | meaning                                                |
 * |-------------------------------------|--------------------------------------------------------|
 * | `"#engineering"`                    | new *text* of the field, written in the original form  |
 * | `42` / `true` / `null`              | numeric / boolean / null literal                        |
 * | `{ kind: "literal", value }`        | explicit literal (string/number/boolean/null)           |
 * | `{ kind: "expression", text }`      | explicit TypeScript expression, written verbatim        |
 * | `{ kind: "template", text }`        | explicit template literal; `text` is the body between   |
 * |                                     | the backticks, `${…}` interpolations included verbatim  |
 * | `{ kind: "remove" }`                | delete the property                                     |
 *
 * A bare string against a **template** field is the template *body* (so editing
 * the text around an interpolation keeps the interpolation); against a **string
 * literal** field it is the literal text (escaped, never promoted to a template);
 * against any other expression form it is refused — writing a string there would
 * be an implicit kind change, which §3 forbids.
 */

import { Node } from "ts-morph";
import { CodeFlowError } from "../errors.js";
import type { SourceStyle } from "./style.js";

export type LiteralValue = string | number | boolean | null;

export type FieldValue =
  | LiteralValue
  | { kind: "literal"; value: LiteralValue }
  | { kind: "expression"; text: string }
  | { kind: "template"; text: string }
  | { kind: "remove" };

export type ResolvedValue =
  | { kind: "literal"; value: LiteralValue }
  | { kind: "expression"; text: string }
  | { kind: "template"; text: string }
  | { kind: "remove" };

export function isFieldValue(value: unknown): value is FieldValue {
  if (value === null) return true;
  const type = typeof value;
  if (type === "string" || type === "number" || type === "boolean") return true;
  if (type !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === "literal" || kind === "expression" || kind === "template" || kind === "remove";
}

export function asFieldValue(field: string, value: unknown): FieldValue {
  if (!isFieldValue(value)) {
    throw new CodeFlowError(
      "patch-unsupported",
      `Value for "${field}" is not a supported field value — use a string/number/boolean/null, or { kind: "literal" | "expression" | "template" | "remove" } (06 §3).`,
    );
  }
  return value;
}

/** The AST form a field currently has — what an edit is applied *relative to*. */
export type OriginalForm = "string" | "template" | "expression" | "none";

export function formOf(node: Node | undefined): OriginalForm {
  if (node === undefined) return "none";
  if (Node.isStringLiteral(node)) return "string";
  if (Node.isNoSubstitutionTemplateLiteral(node) || Node.isTemplateExpression(node)) return "template";
  return "expression";
}

/**
 * Resolve a raw change value against the form it replaces. Explicit `kind`
 * always wins (an explicit kind change is a deliberate edit, §3); a bare string
 * follows the original form.
 */
export function resolveValue(field: string, value: FieldValue, form: OriginalForm): ResolvedValue {
  if (typeof value === "object" && value !== null) return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { kind: "literal", value };
  }
  switch (form) {
    case "template":
      // Editing the text around an interpolation keeps the template (§3).
      return { kind: "template", text: value };
    case "string":
    case "none":
      return { kind: "literal", value };
    default:
      throw new CodeFlowError(
        "patch-not-editable",
        `Field "${field}" currently holds a TypeScript expression — a plain string would silently turn it into a string literal. Send { kind: "expression", text } to keep it an expression, or { kind: "literal", value } to change the kind on purpose (06 §3).`,
      );
  }
}

/* -------------------------------------------------------------------------- */
/* rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Escape `text` for a string literal delimited by `quote`.
 *
 * Control characters are escaped even where the grammar would accept them raw:
 * a literal TAB (or form feed, or NUL) written into the source is invisible in
 * an editor and is exactly the kind of character a formatter or an editor's
 * "trim on save" silently rewrites \u2014 which would change the *value* of the
 * string behind the user's back. `\t` costs nothing and cannot be mangled.
 */
export function renderStringLiteral(text: string, quote: '"' | "'"): string {
  let out = quote;
  for (const character of text) {
    switch (character) {
      case "\\":
        out += "\\\\";
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      case "\b":
        out += "\\b";
        break;
      case "\f":
        out += "\\f";
        break;
      case "\v":
        out += "\\v";
        break;
      case "\u2028":
        out += "\\u2028";
        break;
      case "\u2029":
        out += "\\u2029";
        break;
      default:
        if (character === quote) {
          out += `\\${character}`;
          break;
        }
        if (character < " ") {
          out += `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`;
          break;
        }
        out += character;
    }
  }
  return out + quote;
}

/**
 * The quote character an existing literal uses, so replacing its text never
 * changes the delimiter (06 §4).
 */
export function quoteOf(node: Node | undefined, style: SourceStyle): '"' | "'" {
  if (node !== undefined && Node.isStringLiteral(node)) {
    return node.getText().startsWith("'") ? "'" : '"';
  }
  return style.quote;
}

/**
 * Render a resolved value as source text. `original` is the node being replaced
 * (used for the quote style); `undefined` when writing a brand-new property.
 */
export function renderValue(
  value: Exclude<ResolvedValue, { kind: "remove" }>,
  original: Node | undefined,
  style: SourceStyle,
): string {
  switch (value.kind) {
    case "literal":
      if (typeof value.value === "string") return renderStringLiteral(value.value, quoteOf(original, style));
      if (value.value === null) return "null";
      return String(value.value);
    case "expression":
      return value.text;
    case "template":
      // Written verbatim: the body is TypeScript, `${…}` interpolations included.
      return `\`${value.text}\``;
  }
}
