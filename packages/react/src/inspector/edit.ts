/**
 * From what the inspector shows to what `patchNode` receives — 06 §3.
 *
 * Two rules carry this whole file:
 *
 * 1. **The edit is applied relative to the form the value already has.** A
 *    string literal stays a string literal, a template stays a template, a bare
 *    expression stays an expression. The editor a field gets therefore follows
 *    the *current AST form*, not the `editor` the registry declared (that one
 *    only decides what an empty field starts as).
 * 2. **`{{ }}` is display syntax, never an encoding.** Going back to source
 *    never parses the display text of a string literal; it only re-assembles a
 *    template body, where `{{ expr }}` is literally `${expr}`. Turning a string
 *    literal into a template is a deliberate edit the user has to ask for
 *    (06 §3), so this module exposes the detection and leaves the decision to
 *    the UI.
 *
 * Pure and DOM-free — this is the unit-test surface of the editing path.
 */

import type { FieldValue } from "@codeflow-team/core";
import type { InspectorField } from "./fields.js";

/** Control the inspector renders for a field. */
export type FieldEditorKind = "text" | "number" | "checkbox" | "expression" | "template" | "code";

export interface FieldEditorSpec {
  kind: FieldEditorKind;
  /** Initial text of the control (empty for `checkbox`). */
  value: string;
  /** Initial state of a `checkbox` control. */
  checked: boolean;
  /** Why this control and not another — shown under the field. */
  hint: string | null;
}

export type EncodeResult =
  | { ok: true; value: FieldValue }
  | { ok: false; message: string };

const INTERPOLATION = /\{\{[\s\S]*?\}\}/;

/** True when `text` contains something the user typed as a `{{ }}` interpolation. */
export function hasInterpolation(text: string): boolean {
  return INTERPOLATION.test(text);
}

/**
 * Display text → template *body* (the part between the backticks).
 *
 * `Security PR: {{ pr.title }}` → `Security PR: ${pr.title}`. The inverse of the
 * `{{ }}` rendering in `expression.ts`, and the only place the friendly form is
 * ever read back — for a template, where the mapping is 1-1 by construction
 * (06 §3).
 *
 * Everything outside an interpolation is literal text, so the characters that
 * mean something inside a template literal are escaped: a backslash, a backtick,
 * and a `$` that would otherwise open an interpolation.
 */
export function templateBodyFromDisplay(display: string): string {
  let out = "";
  for (let i = 0; i < display.length; i++) {
    if (display[i] === "{" && display[i + 1] === "{") {
      const end = display.indexOf("}}", i + 2);
      if (end !== -1) {
        out += `\${${display.slice(i + 2, end).trim()}}`;
        i = end + 1;
        continue;
      }
    }
    const character = display[i];
    if (character === "\\" || character === "`") out += `\\${character}`;
    else if (character === "$" && display[i + 1] === "{") out += "\\$";
    else out += character;
  }
  return out;
}

/**
 * Which control a field gets, and what it starts with.
 *
 * The current form wins over the declared editor; a field with no value falls
 * back to the declared editor and then to the schema's type, because there is no
 * form to be relative to yet.
 */
export function editorSpecFor(field: InspectorField): FieldEditorSpec {
  if (!field.display.friendly) {
    return {
      kind: "code",
      value: field.display.raw,
      checked: false,
      hint: "Shown as code: the friendly form would be ambiguous for this value, so the box holds the expression exactly as it is written (06 §3).",
    };
  }

  switch (field.display.kind) {
    case "string":
      return { kind: "text", value: field.display.text, checked: false, hint: null };
    case "number":
      return { kind: "number", value: field.display.text, checked: false, hint: null };
    case "boolean":
      return { kind: "checkbox", value: field.display.text, checked: field.display.text === "true", hint: null };
    case "template":
      return {
        kind: "template",
        value: field.display.text,
        checked: false,
        hint: "Text mixed with values from earlier steps. Each {{ … }} is one value filled in when the flow runs (06 §3).",
      };
    case "expression":
    case "null":
      return {
        kind: "expression",
        value: field.display.raw,
        checked: false,
        hint: "A value worked out when the flow runs, written as code and saved exactly as typed (06 §3).",
      };
    case "empty":
      return emptySpec(field);
  }
}

function emptySpec(field: InspectorField): FieldEditorSpec {
  if (field.editor === "expression") {
    return { kind: "expression", value: "", checked: false, hint: "A value worked out when the flow runs, written as code (06 §3)." };
  }
  if (field.editor === "code") {
    return { kind: "code", value: "", checked: false, hint: "Code, saved into the file exactly as typed." };
  }
  const schema = typeof field.schema === "string" ? field.schema : null;
  if (schema === "number") return { kind: "number", value: "", checked: false, hint: null };
  if (schema === "boolean") return { kind: "checkbox", value: "", checked: false, hint: null };
  return { kind: "text", value: "", checked: false, hint: null };
}

/**
 * Encode one control's state as a `changes` value (06 §3).
 *
 * | control      | sent                                                         |
 * |--------------|--------------------------------------------------------------|
 * | `text`       | the raw string — written in the form the field already has    |
 * | `number`     | a number literal; empty clears the property                   |
 * | `checkbox`   | a boolean literal                                            |
 * | `expression` | `{ kind: "expression", text }` — verbatim TypeScript          |
 * | `template`   | `{ kind: "template", text }` — `{{ e }}` becomes `${e}`       |
 * | `code`       | `{ kind: "expression", text }` — the box *is* the source      |
 *
 * Clearing a field is `{ kind: "remove" }`: the property goes away and the node
 * says it needs configuration, which is what 06 §3 prescribes — never a silent
 * empty string in place of a value.
 */
export function encodeFieldValue(
  kind: FieldEditorKind,
  input: string,
  checked = false,
): EncodeResult {
  switch (kind) {
    case "text":
      // A bare string is resolved against the original form by the patcher:
      // string literal → string literal, template → template body.
      return { ok: true, value: input };

    case "number": {
      if (input.trim().length === 0) return { ok: true, value: { kind: "remove" } };
      const parsed = Number(input);
      if (!Number.isFinite(parsed)) {
        return { ok: false, message: `"${input}" is not a number — clear the field to remove it instead.` };
      }
      return { ok: true, value: parsed };
    }

    case "checkbox":
      return { ok: true, value: checked };

    case "expression":
    case "code": {
      if (input.trim().length === 0) return { ok: true, value: { kind: "remove" } };
      return { ok: true, value: { kind: "expression", text: input.trim() } };
    }

    case "template":
      return { ok: true, value: { kind: "template", text: templateBodyFromDisplay(input) } };
  }
}

/**
 * Encode a friendly text field the user typed `{{ }}` into, *after* they asked
 * for the conversion. Promoting a string literal to a template literal changes
 * the kind of the value, so it never happens implicitly (06 §3).
 */
export function encodeAsTemplate(input: string): FieldValue {
  return { kind: "template", text: templateBodyFromDisplay(input) };
}

export const IMPLICIT_TEMPLATE_REFUSAL =
  "This field holds plain text, so {{ … }} would be saved as those exact characters rather than as a value from an earlier step. Turning it into a fill-in-the-value field is a deliberate change (06 §3).";

/**
 * The `changes` object for one node edit. Argument fields go in flat (the shape
 * 06 §4 shows); `$condition` / `$iterable` are operations and own the call.
 */
export function changesFor(
  field: InspectorField,
  value: FieldValue,
): Record<string, unknown> {
  switch (field.patch) {
    case "$condition":
      return { $condition: expressionTextOf(value) };
    case "$iterable":
      return { $iterable: expressionTextOf(value) };
    default:
      return { [field.name]: value };
  }
}

/**
 * `$condition` / `$iterable` take the expression text itself — the construct
 * always holds an expression, so there is no other form to be relative to.
 */
function expressionTextOf(value: FieldValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "text" in value) return value.text;
  return String(value);
}

/** Merge per-field `changes` into the single `patchNode` call the UI applies. */
export function mergeChanges(all: Record<string, unknown>[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const changes of all) Object.assign(out, changes);
  return out;
}
