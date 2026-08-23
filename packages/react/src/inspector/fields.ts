/**
 * Which fields the inspector shows for a node, and why some of them cannot be
 * edited — 06-patch-engine.md §1 (editable fields + the conditions that void
 * them) and §3 (how values are displayed).
 *
 * Pure: the React component only renders what this returns.
 */

import type { EditableField, EditableFieldEditor, RegistryLookup, Schema, WorkflowNode } from "@codeflow/core";
import { stringData } from "../graph/index.js";
import { formatFieldValue, type FieldDisplay } from "./expression.js";

/**
 * How a field is patched back (06 §2): a plain argument property, or one of the
 * two expression operations a core construct owns. `null` means the patch engine
 * has no edit for it — the UI says so out loud instead of offering a control
 * that would do nothing (07 §5).
 */
export type FieldPatchOp = "field" | "$condition" | "$iterable";

export interface InspectorField {
  name: string;
  label: string;
  editor: EditableFieldEditor;
  /** Raw TypeScript source of the value, or null when the property is absent. */
  raw: string | null;
  display: FieldDisplay;
  schema?: Schema;
  /** Declared editable by the registry (06 §1). Independent of `blockedReason`. */
  declaredEditable: boolean;
  /** Set when this field cannot be patched — the reason is shown next to it. */
  blockedReason: string | null;
  /** Required by the schema but missing from the call — "needs configuration" (06 §2). */
  missing: boolean;
  /** Patch operation this field maps to, or null when there is none (06 §2). */
  patch: FieldPatchOp | null;
}

/** The opaque region a node can hand to Monaco as one `$code` edit (06 §2). */
export type CodeEditTarget =
  | { kind: "region"; label: string }
  | { kind: "localFunction"; functionName: string; label: string };

export interface InspectorModel {
  fields: InspectorField[];
  /** Node-level explanation shown above the fields; null when there is nothing to say. */
  notice: string | null;
  /** Verbatim source shown for `code`/`unknown` nodes. */
  code: string | null;
  /** Set when "Edit Code" applies to this node (`$code`, 06 §2). */
  codeEdit: CodeEditTarget | null;
  /** Set when the node's tool can be swapped (`$tool`, 06 §2). */
  toolChange: { current: string } | null;
}

const VARIABLE_ARGUMENT_NOTICE =
  "The argument is not a visible object literal (a variable, or several positional args) — fields are not editable; edit it in the code view (06 §1).";
const UNRESOLVED_NOTICE =
  "This call does not resolve to a tool in the registry, so its fields have no schema and no patcher (03 §11). Point it at a registered tool below, or edit the statement as code.";
const SPREAD_NOTICE =
  "This argument object contains a spread. Only properties written after the spread are editable; nothing is ever inserted after it to override a value you cannot see (06 §1).";

function argumentsOf(node: WorkflowNode): Record<string, string> | null {
  const args = node.data["arguments"];
  if (args === null || args === undefined || typeof args !== "object") return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    out[key] = typeof value === "string" ? value : String(value);
  }
  return out;
}

/**
 * Whether the schema says this property must be there.
 *
 * Only a JSON Schema can answer: it is the one shape that carries `required`.
 * A named-fields map (a library function's parameters, 05 §4) and a bare type
 * ref have no notion of optional, so every field they declare stays required —
 * which is what a positional parameter list means anyway.
 *
 * Without this, an editable field that the call simply does not pass was
 * labelled "needs a value" and "this has to be filled in before the flow can
 * run" — said in red, about `head`/`tail` on `fs.readTextFile`, which are
 * optional. Telling someone a working flow is broken is the same defect class
 * as telling them a broken one is fine (07 §5).
 */
function isRequiredField(schema: Schema | undefined, name: string): boolean {
  if (schema === undefined || typeof schema !== "object") return true;
  const required = (schema as Record<string, unknown>)["required"];
  if (!Array.isArray(required)) return true;
  return required.includes(name);
}

function schemaField(schema: Schema | undefined, name: string): Schema | undefined {
  if (schema === undefined || typeof schema === "string") return undefined;
  const value = (schema as Record<string, unknown>)[name];
  return value as Schema | undefined;
}

function editableFieldsFor(node: WorkflowNode, registry: RegistryLookup | null): EditableField[] | null {
  if (registry === null) return null;
  if (node.type === "tool" || node.type === "unknown") {
    const name = stringData(node, "toolName");
    return name === null ? null : registry.getTool(name)?.editableFields ?? null;
  }
  if (node.type === "function") {
    const name = stringData(node, "functionName");
    return name === null ? null : registry.getFunction(name)?.editableFields ?? null;
  }
  return null;
}

function inputSchemaFor(node: WorkflowNode, registry: RegistryLookup | null): Schema | undefined {
  if (registry === null) return undefined;
  if (node.type === "tool" || node.type === "unknown") {
    const name = stringData(node, "toolName");
    return name === null ? undefined : registry.getTool(name)?.inputSchema;
  }
  if (node.type === "function") {
    const name = stringData(node, "functionName");
    return name === null ? undefined : registry.getFunction(name)?.inputSchema;
  }
  return undefined;
}

function callFields(node: WorkflowNode, registry: RegistryLookup | null): InspectorModel {
  const args = argumentsOf(node);
  const editableFields = editableFieldsFor(node, registry);
  const inputSchema = inputSchemaFor(node, registry);
  const argumentsEditable = node.data["argumentsEditable"] === true;
  const hasSpread = node.data["argumentsHaveSpread"] === true;

  // An `unknown` node is a call that *looks* like a tool but resolves to
  // nothing (03 §3), so there is no schema to validate a field against and no
  // patcher for it (03 §11, capabilities: editable=false). Said here rather
  // than letting Apply come back with `patch-not-editable` (07 §5).
  const blocked = !argumentsEditable
    ? VARIABLE_ARGUMENT_NOTICE
    : node.type === "unknown"
      ? UNRESOLVED_NOTICE
      : null;
  const notice = blocked ?? (hasSpread ? SPREAD_NOTICE : null);

  const names: string[] = [];
  for (const field of editableFields ?? []) names.push(field.name);
  for (const name of Object.keys(args ?? {})) if (!names.includes(name)) names.push(name);

  const fields = names.map<InspectorField>((name) => {
    const declared = editableFields?.find((field) => field.name === name);
    const raw = args?.[name] ?? null;
    return {
      name,
      label: declared?.label ?? name,
      editor: declared?.editor ?? inferEditor(raw),
      raw,
      display: formatFieldValue(raw),
      ...(schemaField(inputSchema, name) === undefined ? {} : { schema: schemaField(inputSchema, name) }),
      declaredEditable: editableFields === null ? args !== null : declared !== undefined,
      blockedReason: blocked,
      missing: raw === null && isRequiredField(inputSchema, name),
      patch: blocked === null ? "field" : null,
    };
  });

  const toolName = stringData(node, "toolName");
  const local = node.type === "function" && stringData(node, "functionSource") === "local";
  const library = node.type === "function" && stringData(node, "functionSource") === "library";

  return {
    fields,
    notice: notice ?? (library ? LIBRARY_FUNCTION_NOTICE : null),
    code: null,
    codeEdit: local
      ? { kind: "localFunction", functionName: stringData(node, "functionName") ?? "", label: "Edit function body" }
      : node.type === "unknown"
        ? { kind: "region", label: "Edit statement as code" }
        : null,
    toolChange:
      (node.type === "tool" || node.type === "unknown") && toolName !== null ? { current: toolName } : null,
  };
}

function inferEditor(raw: string | null): EditableFieldEditor {
  if (raw === null) return "text";
  const display = formatFieldValue(raw);
  if (!display.friendly) return "code";
  return display.kind === "string" || display.kind === "number" || display.kind === "boolean"
    ? "text"
    : "expression";
}

function simpleField(
  name: string,
  label: string,
  raw: string | null,
  editor: EditableFieldEditor,
  patch: FieldPatchOp | null = null,
  blockedReason: string | null = null,
): InspectorField {
  return {
    name,
    label,
    editor,
    raw,
    display: formatFieldValue(raw),
    declaredEditable: raw !== null,
    blockedReason,
    missing: raw === null,
    patch,
  };
}

/** Nothing to patch and nothing to say beyond "not this way" — 07 §5. */
const NOT_PATCHABLE = {
  loopVariable:
    "Renaming the loop variable would rewrite every use of it — that is a structural edit, not supported at MVP (06 §2). Edit it in the code view.",
  output:
    "A `return` expression has no patch operation at MVP (06 §2) — edit it in the code view. The node itself can still be deleted.",
  trigger: "The trigger is synthetic: it comes from the flow signature plus host metadata (03 §9), not from an editable statement.",
  jump: "Turning `break` into `continue` changes control flow — not a supported edit (06 §2). Edit it in the code view.",
  tryCatch: "Renaming the catch binding is not a supported edit (06 §2) — edit it in the code view.",
} as const;

/**
 * A library function's source lives in the function library, not in this file
 * (05 §4), so `$code` — which replaces a region of *this* source — cannot reach
 * it. Said out loud rather than offering a button that would edit the call
 * (07 §5).
 */
const LIBRARY_FUNCTION_NOTICE =
  "This is a library function: its source lives in the function library (05 §4), not in this flow, so “Edit Code” does not apply here. Editing library sources needs a library store, which this build does not wire up.";

const EMPTY_MODEL: Omit<InspectorModel, "fields" | "notice" | "code"> = {
  codeEdit: null,
  toolChange: null,
};

/**
 * Build the inspector model for `node`.
 *
 * Registry-backed nodes (tool/function) take their fields from `editableFields`
 * (06 §1); core constructs expose the one expression the patch engine will be
 * able to touch (condition, `while` condition, `for…of` iterable — 06 §2).
 */
export function resolveInspectorFields(
  node: WorkflowNode,
  registry: RegistryLookup | null = null,
): InspectorModel {
  switch (node.type) {
    case "tool":
    case "unknown":
    case "function":
      return callFields(node, registry);

    case "condition":
      return {
        ...EMPTY_MODEL,
        fields: [simpleField("expression", "Condition", stringData(node, "expression"), "expression", "$condition")],
        notice: null,
        code: null,
      };

    case "loop": {
      if (stringData(node, "kind") === "while") {
        return {
          ...EMPTY_MODEL,
          fields: [simpleField("condition", "While", stringData(node, "condition"), "expression", "$condition")],
          notice:
            node.data["bounded"] === false
              ? "No stopping condition was recognised for this loop (04 §2.8)."
              : null,
          code: null,
        };
      }
      return {
        ...EMPTY_MODEL,
        fields: [
          simpleField("variable", "Item", stringData(node, "variable"), "text", null, NOT_PATCHABLE.loopVariable),
          simpleField("iterable", "Iterable", stringData(node, "iterable"), "expression", "$iterable"),
        ],
        notice: null,
        code: null,
      };
    }

    case "output":
      return {
        ...EMPTY_MODEL,
        fields: [
          simpleField("expression", "Return", stringData(node, "expression"), "expression", null, NOT_PATCHABLE.output),
        ],
        notice:
          node.data["explicit"] === true
            ? null
            : "Synthetic output — the flow has no explicit `return` (04 §2.10). Not editable.",
        code: null,
      };

    case "code":
      return {
        ...EMPTY_MODEL,
        fields: [],
        notice: "Custom code is kept verbatim — it is edited as code, not as fields (05 §4b).",
        code: stringData(node, "text"),
        codeEdit: { kind: "region", label: "Edit code" },
      };

    case "trigger":
      return {
        ...EMPTY_MODEL,
        fields: [simpleField("inputType", "Input type", stringData(node, "inputType"), "code", null, NOT_PATCHABLE.trigger)],
        notice: "Trigger is synthetic — built from the flow signature plus host metadata (03 §9).",
        code: null,
      };

    case "jump":
      return {
        ...EMPTY_MODEL,
        fields: [simpleField("kind", "Jump", stringData(node, "kind"), "text", null, NOT_PATCHABLE.jump)],
        notice: null,
        code: null,
      };

    case "try":
      return {
        ...EMPTY_MODEL,
        fields: [
          simpleField("catchParam", "Catch binding", stringData(node, "catchParam"), "text", null, NOT_PATCHABLE.tryCatch),
        ],
        notice: "Adding or removing a `try` wrapper is a structural edit — not supported at MVP (06 §2).",
        code: null,
      };

    case "merge":
      return { ...EMPTY_MODEL, fields: [], notice: "Synthetic convergence point — not editable (03 §4).", code: null };

    default:
      return { ...EMPTY_MODEL, fields: [], notice: null, code: null };
  }
}
