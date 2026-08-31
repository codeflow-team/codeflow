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

import type { FieldValue, Schema } from "@codeflow-team/core";
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

export interface EncodeOptions {
  /**
   * The field being encoded. It carries the schema (so a `number` field commits
   * a number, 06 §3), whether the property can be removed at all, and the label
   * a refusal names — none of which the control's `kind` knows on its own.
   */
  field?: InspectorField;
  /**
   * The user asked for an emptied field to be saved as empty text rather than
   * removed. Two gestures, two results — never the same one (06 §3).
   */
  keepEmpty?: boolean;
}

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
  const declared = declaredTypeOf(field.schema);
  if (declared === "number") return { kind: "number", value: "", checked: false, hint: null };
  if (declared === "boolean") return { kind: "checkbox", value: "", checked: false, hint: null };
  return { kind: "text", value: "", checked: false, hint: null };
}

/* -------------------------------------------------------------------------- */
/* what the schema says the field holds — 06 §3                                */
/* -------------------------------------------------------------------------- */

/**
 * The primitive type a field's schema declares, or `null` when it declares none.
 *
 * Both shapes a `Schema` can take are read: the TypeScript ref (`"number"`, the
 * form a tool's `inputSchema: { maxTickets: "number" }` produces) and JSON
 * Schema (`{ type: "number" }`). A union, an enum of mixed types, or no schema
 * at all answers `null` — and `null` means "keep the old behaviour", never "it
 * is probably a string".
 */
export type DeclaredType = "string" | "number" | "boolean";

export function declaredTypeOf(schema: Schema | undefined): DeclaredType | null {
  if (schema === undefined || schema === null) return null;
  const name =
    typeof schema === "string"
      ? schema.trim()
      : typeof (schema as Record<string, unknown>)["type"] === "string"
        ? String((schema as Record<string, unknown>)["type"])
        : null;
  if (name === null) return null;
  if (name === "string") return "string";
  if (name === "number" || name === "integer") return "number";
  if (name === "boolean") return "boolean";
  return null;
}

/** The word the refusal uses — `integer` is a number to everyone but the schema. */
function typeWord(schema: Schema | undefined, declared: DeclaredType): string {
  if (schema === undefined || schema === null) return declared;
  const raw =
    typeof schema === "string" ? schema.trim() : String((schema as Record<string, unknown>)["type"] ?? declared);
  return raw === "integer" ? "whole number" : declared;
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
 * Two things the control's `kind` cannot decide on its own, and which therefore
 * come from `options.field`:
 *
 * - **the declared type.** A field whose schema says `number` commits `50`, not
 *   `"50"`; one whose schema says `boolean` commits `true`. Text that does not
 *   parse as the declared type is refused *here*, naming the type, rather than
 *   being written and reported back afterwards as a type mismatch. A field with
 *   no declared type behaves exactly as it always did;
 * - **what empty means.** Clearing a field is `{ kind: "remove" }`: the property
 *   goes away and the node says it needs configuration, which is what 06 §3
 *   prescribes — never a silent empty string in place of a value. `""` is still
 *   reachable for a `string` field, through `keepEmpty`, because it is a real
 *   value; and a positional argument, which core cannot remove without shifting
 *   every argument after it, is refused with that reason.
 */
export function encodeFieldValue(
  kind: FieldEditorKind,
  input: string,
  checked = false,
  options: EncodeOptions = {},
): EncodeResult {
  const field = options.field;
  const declared = declaredTypeOf(field?.schema);
  const empty = input.trim().length === 0;

  switch (kind) {
    case "text": {
      // A text box is where a `number`/`boolean` field ends up whenever its
      // JSON Schema is an object rather than a bare type ref, and where every
      // untyped field lives. The schema is on the field, so the type is checked
      // *here* rather than being written and reported back as a mismatch.
      if (empty) return emptied(field, options.keepEmpty === true, declared, "");
      if (declared === "number") return numberValue(input, field, declared);
      if (declared === "boolean") return booleanValue(input, field);
      // A bare string is resolved against the original form by the patcher:
      // string literal → string literal, template → template body.
      return { ok: true, value: input };
    }

    case "number": {
      if (empty) return emptied(field, options.keepEmpty === true, declared, { kind: "remove" });
      return numberValue(input, field, declared);
    }

    case "checkbox":
      return { ok: true, value: checked };

    case "expression":
    case "code": {
      if (empty) return emptied(field, options.keepEmpty === true, declared, { kind: "remove" });
      return { ok: true, value: { kind: "expression", text: input.trim() } };
    }

    case "template":
      return { ok: true, value: { kind: "template", text: templateBodyFromDisplay(input) } };
  }
}

function numberValue(input: string, field: InspectorField | undefined, declared: DeclaredType | null): EncodeResult {
  const parsed = Number(input.trim());
  if (!Number.isFinite(parsed)) {
    return { ok: false, message: mismatch(input, field, "number", declared) };
  }
  if (typeWord(field?.schema, "number") === "whole number" && !Number.isInteger(parsed)) {
    return { ok: false, message: mismatch(input, field, "whole number", declared) };
  }
  return { ok: true, value: parsed };
}

function booleanValue(input: string, field: InspectorField | undefined): EncodeResult {
  const text = input.trim().toLowerCase();
  if (text === "true" || text === "yes") return { ok: true, value: true };
  if (text === "false" || text === "no") return { ok: true, value: false };
  return { ok: false, message: mismatch(input, field, "boolean", "boolean") };
}

/**
 * Refused *before* anything is written, naming what the field expects.
 *
 * The app already flagged "Argument type mismatch" after the fact, which means
 * it knew — it just knew too late. Saying it here, with the declared type in the
 * sentence, is the same fact delivered while the user can still act on it
 * (07 §5).
 */
function mismatch(
  input: string,
  field: InspectorField | undefined,
  expected: string,
  declared: DeclaredType | null,
): string {
  const name = field === undefined ? "This setting" : `“${field.label}”`;
  const article = expected === "boolean" ? "a" : "a";
  const tail =
    expected === "boolean"
      ? " Type `true` or `false`."
      : declared === null
        ? ""
        : field?.removable === true
          ? " Type a value of that type, or clear the field to remove the setting."
          : " Type a value of that type.";
  return `${name} expects ${article} ${expected}, and “${input.trim()}” is not one.${tail}`;
}

/**
 * What an emptied control means.
 *
 * Three different things, and they must not be confused (06 §3):
 *
 * - **removed** — the property goes away; the default, because a value that is
 *   not there is what "no value" means in the source, and `""` is a value;
 * - **empty text** — a legitimate value for a `string` field, reachable only by
 *   asking for it (`keepEmpty`), so the two gestures never collapse into one;
 * - **refused** — a positional argument cannot be removed at all (core would
 *   refuse: removing one shifts every argument after it), so the UI says why
 *   instead of writing `""` in its place.
 */
function emptied(
  field: InspectorField | undefined,
  keepEmpty: boolean,
  declared: DeclaredType | null,
  /** What an empty control meant before there was a field to ask — unchanged. */
  fallback: FieldValue,
): EncodeResult {
  // No field context: the encoder knows nothing about the property, so it
  // cannot decide between removing it and blanking it. Unchanged from before.
  if (field === undefined) return { ok: true, value: fallback };
  if (keepEmpty) {
    if (declared === null || declared === "string") return { ok: true, value: "" };
    return {
      ok: false,
      message: `“${field.label}” holds a ${typeWord(field.schema, declared)}, so empty text is not a value it can take — clear it to remove the setting instead.`,
    };
  }
  if (!field.removable) {
    return { ok: false, message: field.unremovableReason ?? NOT_REMOVABLE };
  }
  return { ok: true, value: { kind: "remove" } };
}

const NOT_REMOVABLE =
  "This setting cannot be removed by the patch engine (06 §2) — give it a value, or edit the statement in the code view.";

/* -------------------------------------------------------------------------- */
/* clearing, as a gesture the UI can describe before it happens                */
/* -------------------------------------------------------------------------- */

export type EmptyOutcome =
  | { kind: "remove"; message: string }
  | { kind: "blank"; message: string }
  | { kind: "refused"; message: string };

/**
 * What will happen when this field is applied with an empty control — the text
 * the UI shows *while* the box is empty, so "cleared" and "set to empty" are
 * visibly different before either is committed.
 */
export function emptyFieldOutcome(field: InspectorField, keepEmpty = false): EmptyOutcome {
  const declared = declaredTypeOf(field.schema);
  if (keepEmpty) {
    if (declared === null || declared === "string") {
      return { kind: "blank", message: `“${field.label}” will be saved as empty text (\`""\`), not removed.` };
    }
    return {
      kind: "refused",
      message: `“${field.label}” holds a ${typeWord(field.schema, declared)}, so empty text is not a value it can take — clear it to remove the setting instead.`,
    };
  }
  if (!field.removable) {
    return { kind: "refused", message: field.unremovableReason ?? NOT_REMOVABLE };
  }
  return {
    kind: "remove",
    message: field.required
      ? `“${field.label}” will be removed from the call. It is required, so this step will come back asking to be set up (06 §3).`
      : `“${field.label}” will be removed from the call — the property goes away rather than being saved as empty text (06 §3).`,
  };
}

/**
 * Whether the field is offered an explicit "clear" control.
 *
 * Required fields are not: removing one leaves a step that cannot run, and that
 * is not something to put a button on. They can still be emptied by hand, which
 * is what 06 §3 describes, and the notice then says what it will do.
 */
export function offersUnset(field: InspectorField): boolean {
  return field.removable && !field.required && field.patch === "field" && field.blockedReason === null;
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
