/**
 * What a node shows in each disclosure level — 07-ui.md §3, §4.
 *
 * One source of truth for both the rendered node body and the size the layout
 * measures it at, so ELK never lays out a box the component then overflows.
 */

import type { WorkflowNode } from "@codeflow/core";
import { formatFieldValue } from "../inspector/expression.js";
import { stringData } from "../graph/index.js";

export type DisclosureMode = "compact" | "expanded" | "developer";

export interface SummaryRow {
  key: string;
  value: string;
}

/** Icon shown in every mode — registry icon when there is one, else a type glyph. */
export function nodeIcon(node: WorkflowNode): string {
  const registryIcon = stringData(node, "icon");
  if (registryIcon !== null) return registryIcon;
  switch (node.type) {
    case "trigger":
      return "⚡";
    case "condition":
      return "◇";
    case "loop":
      return "↻";
    case "try":
      return "🛡";
    case "jump":
      return "⤴";
    case "parallel":
      return "⑃";
    case "merge":
      return "⊕";
    case "output":
      return "⏹";
    case "code":
      return "</>";
    case "unknown":
      return "?";
    case "function":
      return "ƒ";
    default:
      return "▸";
  }
}

/**
 * The line under the title.
 *
 * Beginner level shows icon + label only (07 §4), so there is none. The power
 * level gets a plain-language description of what kind of step this is — the
 * qualified tool name is a developer fact and waits for the developer level,
 * where it is exactly what is wanted.
 */
export function nodeCaption(node: WorkflowNode, mode: DisclosureMode): string | null {
  if (mode === "compact") return null;
  if (mode === "developer") return nodeKindLabel(node);

  switch (node.type) {
    case "trigger":
      return "Starts the flow";
    case "tool":
      return "Action";
    case "function":
      return stringData(node, "functionSource") === "library" ? "Shared function" : "Function in this file";
    case "condition":
      return "Decision";
    case "loop":
      return stringData(node, "kind") === "while" ? "Repeat" : "Repeats for each item";
    case "try":
      return "Handles errors";
    case "parallel":
      return "Runs at the same time";
    case "merge":
      return "Paths come back together";
    case "jump":
      return stringData(node, "kind") === "continue" ? "Skips to the next item" : "Stops the loop";
    case "output":
      return node.data["explicit"] === true ? "Finishes the flow" : "End of the flow";
    case "code":
      return "Custom code";
    case "unknown":
      return "Not recognised";
    default:
      return null;
  }
}

/** Short type caption — the machine-facing one, shown at the developer level. */
export function nodeKindLabel(node: WorkflowNode): string {
  switch (node.type) {
    case "tool":
      return stringData(node, "toolName") ?? "tool";
    case "function":
      return stringData(node, "functionSource") === "library" ? "library function" : "local function";
    case "loop":
      return stringData(node, "kind") === "while" ? "while" : "for each";
    case "unknown":
      return "unresolved";
    default:
      return node.type;
  }
}

function argumentRows(node: WorkflowNode): SummaryRow[] {
  const args = node.data["arguments"];
  if (args === null || typeof args !== "object") {
    const text = stringData(node, "argumentText");
    return text === null || text.length === 0 ? [] : [{ key: "args", value: text }];
  }
  return Object.entries(args as Record<string, unknown>).map(([key, value]) => ({
    key,
    value: formatFieldValue(typeof value === "string" ? value : String(value)).text,
  }));
}

function outputRow(node: WorkflowNode): SummaryRow[] {
  if (node.outputs.length === 0) return [];
  const value = node.outputs
    .map((port) => (typeof port.schema === "string" ? `${port.label}: ${port.schema}` : port.label))
    .join(", ");
  return [{ key: "Gives", value }];
}

/** Rows rendered in the *expanded* level (07 §3). */
export function nodeSummaryRows(node: WorkflowNode): SummaryRow[] {
  switch (node.type) {
    case "tool":
    case "unknown":
    case "function":
      return [...argumentRows(node), ...outputRow(node)];
    case "condition":
      return [{ key: "When", value: formatFieldValue(stringData(node, "expression")).text }];
    case "loop":
      // `for…of` already reads "For Each pr in prs" in the label — no second copy.
      return stringData(node, "kind") === "while"
        ? [{ key: "While", value: formatFieldValue(stringData(node, "condition")).text }]
        : [];
    case "try": {
      const rows: SummaryRow[] = [];
      if (node.data["hasCatch"] === true) rows.push({ key: "Catch", value: stringData(node, "catchParam") ?? "(no binding)" });
      if (node.data["hasFinally"] === true) rows.push({ key: "Finally", value: "yes" });
      return rows;
    }
    case "jump": {
      const label = stringData(node, "label");
      return [{ key: stringData(node, "kind") ?? "jump", value: label ?? "" }];
    }
    case "output": {
      const expression = stringData(node, "expression");
      return [
        {
          key: "Result",
          value: expression === null ? (node.data["explicit"] === true ? "(nothing)" : "(implicit end)") : formatFieldValue(expression).text,
        },
      ];
    }
    case "trigger":
      return [{ key: "Takes", value: stringData(node, "inputType") ?? "unknown" }, ...outputRow(node)];
    case "merge":
      return [{ key: "Merge", value: stringData(node, "of") ?? "" }, ...outputRow(node)];
    case "parallel":
      return [{ key: "Branches", value: String(node.data["branchCount"] ?? 0) }];
    case "code": {
      const text = stringData(node, "text") ?? "";
      const first = text.split("\n")[0] ?? "";
      return [{ key: "Code", value: first.length > 48 ? `${first.slice(0, 48)}…` : first }, ...outputRow(node)];
    }
    default:
      return outputRow(node);
  }
}

/** Verbatim source shown at the *developer* level (07 §3, third box). */
export function nodeSourceText(node: WorkflowNode): string {
  const code = stringData(node, "text");
  if (code !== null) return code;
  switch (node.type) {
    case "tool":
    case "unknown": {
      const name = stringData(node, "toolName") ?? "";
      const args = stringData(node, "argumentText") ?? "";
      const await_ = node.data["awaited"] === true ? "await " : "";
      return `${await_}tools.${name}(${args})`;
    }
    case "function": {
      const name = stringData(node, "functionName") ?? "";
      const args = stringData(node, "argumentText") ?? "";
      const await_ = node.data["awaited"] === true ? "await " : "";
      return `${await_}${name}(${args})`;
    }
    case "condition":
      return `if (${stringData(node, "expression") ?? ""})`;
    case "loop":
      return stringData(node, "kind") === "while"
        ? `while (${stringData(node, "condition") ?? ""})`
        : `for (const ${stringData(node, "variable") ?? ""} of ${stringData(node, "iterable") ?? ""})`;
    case "try":
      return "try { … }";
    case "jump": {
      const label = stringData(node, "label");
      return `${stringData(node, "kind") ?? "break"}${label === null ? "" : ` ${label}`};`;
    }
    case "output":
      return node.data["explicit"] === true ? `return ${stringData(node, "expression") ?? ""};` : "// end of flow";
    case "trigger":
      return `flow(input: ${stringData(node, "inputType") ?? "unknown"}, tools)`;
    default:
      return node.label;
  }
}

/** Lines shown at developer level, capped so one node cannot dominate the canvas. */
export const DEVELOPER_MAX_LINES = 8;

export function developerLines(node: WorkflowNode): string[] {
  const lines = nodeSourceText(node).split("\n");
  if (lines.length <= DEVELOPER_MAX_LINES) return lines;
  return [...lines.slice(0, DEVELOPER_MAX_LINES), "…"];
}

/** Rows a given mode actually renders — used by both the component and `measureNode`. */
export function rowsForMode(node: WorkflowNode, mode: DisclosureMode): SummaryRow[] {
  if (mode === "compact") return [];
  if (mode === "developer") return [];
  return nodeSummaryRows(node);
}
