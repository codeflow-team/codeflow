/**
 * Dropping a value onto a parameter — the one gesture the node editor exists
 * for, as pure functions.
 *
 * A drop is **not a new kind of edit**. It produces the same `changes` object a
 * typed edit produces, goes through the same `previewPatch` / `patchNode`, and
 * is refused by the same engine. That is the whole design: "connect the output
 * of step A to a parameter of step B" is a field patch that writes a TypeScript
 * expression (06 §3), so the diff preview, the validation and the refusals come
 * for free and cannot be bypassed by the new gesture.
 *
 * The decision layer lives here rather than in the component because the react
 * package's tests run in **node** — a component would be the one part of this
 * feature with no deterministic test. The component is wiring; this is the
 * behaviour.
 */

import type { FieldValue, ScopeBinding, WorkflowGraph } from "@codeflow-team/core";
import type { InspectorField } from "../inspector/fields.js";
import {
  changesFor,
  editorSpecFor,
  encodeAsTemplate,
  type FieldEditorKind,
} from "../inspector/edit.js";
import type { ScopeRow } from "./scope-rows.js";

/** What the caller needs to know to render the field after a drop, and to patch. */
export interface DropOutcome {
  ok: true;
  /** Control the field now uses — a drop can promote `text` to `template`. */
  kind: FieldEditorKind;
  /** What the control shows afterwards (display form, `{{ }}` included). */
  display: string;
  /** Where the caret lands: just after the inserted reference. */
  caret: number;
  /** The encoded value — the form `patchNode` expects (06 §3). */
  value: FieldValue;
  /** Exactly the object to hand `previewPatch` / `patchNode`. */
  changes: Record<string, unknown>;
  /**
   * True when the drop turned a plain string literal into a template literal.
   *
   * 06 §3 makes that a *deliberate* change, never an implicit one — so the UI
   * must show it happened rather than let it pass unremarked. The drop is still
   * only a draft: nothing reaches the source until the user applies it, with
   * the diff in front of them.
   */
  promotedToTemplate: boolean;
  /** Something the user should know about what just happened, or null. */
  note: string | null;
}

export interface DropRefusal {
  ok: false;
  message: string;
}

export type DropResult = DropOutcome | DropRefusal;

export interface DropOptions {
  /** Current text of the control; defaults to what the field holds now. */
  text?: string;
  /** Caret position inside `text`; defaults to the end. */
  caret?: number;
}

const NO_PATCH =
  "This setting has no edit in the patch engine, so a value cannot be dropped into it (06 §2) — edit it in the code view.";

const PROMOTED_NOTE =
  "This was plain text, so it becomes a fill-in-the-value field: the text stays, and the dropped value is filled in when the flow runs (06 §3).";

const REPLACED_NOTE = "The value that was here is replaced by the dropped reference.";

const EXPRESSION_NOTE =
  "Inserted into the expression exactly where the caret was, as typing it would — nothing is rearranged.";

/**
 * Insert one scope row into one field.
 *
 * Four shapes of field, each handled relative to the form the value already has
 * (06 §3 — the rule that keeps a string literal a string literal):
 *
 * | field holds        | after the drop                                      |
 * |--------------------|-----------------------------------------------------|
 * | nothing            | an expression — `{{ pr.title }}`                     |
 * | a string           | a template — `Security PR: {{ pr.title }}`           |
 * | a template         | the same template, one more interpolation in it      |
 * | an expression/code | the reference inserted at the caret, verbatim        |
 */
export function dropInto(
  field: InspectorField,
  row: Pick<ScopeRow, "path">,
  options: DropOptions = {},
): DropResult {
  if (field.blockedReason !== null) return { ok: false, message: field.blockedReason };
  if (field.patch === null) return { ok: false, message: NO_PATCH };
  if (row.path.trim().length === 0) {
    return { ok: false, message: "That row has no expression to insert." };
  }

  const spec = editorSpecFor(field);
  const text = options.text ?? spec.value;
  const caret = clampCaret(options.caret, text.length);
  const path = row.path.trim();

  switch (spec.kind) {
    case "expression":
    case "code": {
      const display = text.slice(0, caret) + path + text.slice(caret);
      const value: FieldValue = { kind: "expression", text: display.trim() };
      return outcome(field, spec.kind, display, caret + path.length, value, false, text.trim().length === 0 ? null : EXPRESSION_NOTE);
    }

    case "template": {
      const token = `{{ ${path} }}`;
      const display = text.slice(0, caret) + token + text.slice(caret);
      return outcome(field, "template", display, caret + token.length, encodeAsTemplate(display), false, null);
    }

    case "text": {
      if (text.trim().length === 0) {
        // An empty text field is not "a string" yet — nothing is being turned
        // into anything, so this is the plain expression case. The control's
        // text *is* the expression source; `{{ }}` is how it is shown back.
        return outcome(field, "expression", path, path.length, { kind: "expression", text: path }, false, null);
      }
      const token = `{{ ${path} }}`;
      const display = text.slice(0, caret) + token + text.slice(caret);
      return outcome(field, "template", display, caret + token.length, encodeAsTemplate(display), true, PROMOTED_NOTE);
    }

    case "number":
    case "checkbox": {
      // A typed literal cannot hold an interpolation, so the field becomes an
      // expression outright. Said out loud, and still only a draft: the diff is
      // shown before anything is written (06 §4).
      const value: FieldValue = { kind: "expression", text: path };
      const replaced = text.trim().length > 0 || spec.kind === "checkbox";
      return outcome(field, "expression", path, path.length, value, false, replaced ? REPLACED_NOTE : null);
    }
  }
}

function outcome(
  field: InspectorField,
  kind: FieldEditorKind,
  display: string,
  caret: number,
  value: FieldValue,
  promotedToTemplate: boolean,
  note: string | null,
): DropOutcome {
  return {
    ok: true,
    kind,
    display,
    caret,
    value,
    changes: changesFor(field, value),
    promotedToTemplate,
    note,
  };
}

function clampCaret(caret: number | undefined, length: number): number {
  if (caret === undefined || Number.isNaN(caret)) return length;
  return Math.min(Math.max(Math.trunc(caret), 0), length);
}

/* -------------------------------------------------------------------------- */
/* is this row legal at this node?                                             */
/* -------------------------------------------------------------------------- */

export type DropCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether `row` may be dropped at `nodeId`, decided from `graph.scopes`.
 *
 * This is a *pre-check* — it exists so a drop target can be disabled before the
 * user lets go, not so the UI can write its own refusal. The authoritative "no"
 * comes from the patch engine, which names the offending identifier and lists
 * what is in scope (`checkExpressionScope`); that message is surfaced verbatim
 * and this one never competes with it.
 *
 * The interesting case is the loop item: `pr` exists inside `for (const pr of
 * prs)` and nowhere before it, and no amount of UI cleverness can make it mean
 * something at an earlier step. The analyzer already knows that, which is
 * exactly why the answer is read from its table instead of recomputed here.
 */
export function canDrop(
  row: Pick<ScopeRow, "path" | "bindingName">,
  nodeId: string,
  graph: WorkflowGraph | null | undefined,
): DropCheck {
  if (graph === null || graph === undefined) {
    return { ok: false, reason: "Nothing is analyzed yet, so nothing is known to be in scope here." };
  }
  const bindings = graph.scopes[nodeId] as ScopeBinding[] | undefined;
  if (bindings === undefined) {
    return {
      ok: false,
      reason: "The analyzer reported no scope for this step, so what is available here is unknown.",
    };
  }
  const name = rootNameOf(row.bindingName.length > 0 ? row.bindingName : row.path);
  if (!bindings.some((binding) => binding.name === name)) {
    return { ok: false, reason: `\`${name}\` is not available at this step.` };
  }
  return { ok: true };
}

/** `prs[0].title` → `prs`; the name scope is actually asked about. */
export function rootNameOf(path: string): string {
  const match = /^[A-Za-z_$][\w$]*/.exec(path.trim());
  return match === null ? path.trim() : match[0];
}
