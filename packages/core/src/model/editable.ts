/** Editable fields — 06-patch-engine.md §1. */

export type EditableFieldEditor = "text" | "expression" | "select" | "code";

export interface EditableField {
  /** property name inside the argument object, e.g. "channel" */
  name: string;
  label?: string;
  editor?: EditableFieldEditor;
  options?: unknown[];
}

/** Shorthand: `"channel"` ≡ `{ name: "channel" }` — normalized when a definition loads. */
export type EditableFieldInput = EditableField | string;
