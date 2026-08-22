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
  /** Set when this field cannot be patched even once the patch engine lands. */
  blockedReason: string | null;
  /** Required by the schema but missing from the call — "needs configuration" (06 §2). */
  missing: boolean;
}

export interface InspectorModel {
  fields: InspectorField[];
  /** Node-level explanation shown above the fields; null when there is nothing to say. */
  notice: string | null;
  /** Verbatim source shown for `code`/`unknown` nodes. */
  code: string | null;
}

const VARIABLE_ARGUMENT_NOTICE =
  "The argument is not a visible object literal (a variable, or several positional args) — fields are not editable; edit it in the code view (06 §1).";
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

  const blocked = !argumentsEditable ? VARIABLE_ARGUMENT_NOTICE : null;
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
      missing: raw === null,
    };
  });

  return {
    fields,
    notice,
    code: null,
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
): InspectorField {
  return {
    name,
    label,
    editor,
    raw,
    display: formatFieldValue(raw),
    declaredEditable: raw !== null,
    blockedReason: null,
    missing: raw === null,
  };
}

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
        fields: [simpleField("expression", "Condition", stringData(node, "expression"), "expression")],
        notice: null,
        code: null,
      };

    case "loop": {
      if (stringData(node, "kind") === "while") {
        return {
          fields: [simpleField("condition", "While", stringData(node, "condition"), "expression")],
          notice:
            node.data["bounded"] === false
              ? "No stopping condition was recognised for this loop (04 §2.8)."
              : null,
          code: null,
        };
      }
      return {
        fields: [
          simpleField("variable", "Item", stringData(node, "variable"), "text"),
          simpleField("iterable", "Iterable", stringData(node, "iterable"), "expression"),
        ],
        notice: null,
        code: null,
      };
    }

    case "output":
      return {
        fields: [simpleField("expression", "Return", stringData(node, "expression"), "expression")],
        notice:
          node.data["explicit"] === true
            ? null
            : "Synthetic output — the flow has no explicit `return` (04 §2.10). Not editable.",
        code: null,
      };

    case "code":
      return {
        fields: [],
        notice: "Custom code is kept verbatim — it is edited as code, not as fields (05 §4b).",
        code: stringData(node, "text"),
      };

    case "trigger":
      return {
        fields: [simpleField("inputType", "Input type", stringData(node, "inputType"), "code")],
        notice: "Trigger is synthetic — built from the flow signature plus host metadata (03 §9).",
        code: null,
      };

    case "jump":
      return {
        fields: [simpleField("kind", "Jump", stringData(node, "kind"), "text")],
        notice: null,
        code: null,
      };

    case "try":
      return {
        fields: [simpleField("catchParam", "Catch binding", stringData(node, "catchParam"), "text")],
        notice: "Adding or removing a `try` wrapper is a structural edit — not supported at MVP (06 §2).",
        code: null,
      };

    case "merge":
      return { fields: [], notice: "Synthetic convergence point — not editable (03 §4).", code: null };

    default:
      return { fields: [], notice: null, code: null };
  }
}
