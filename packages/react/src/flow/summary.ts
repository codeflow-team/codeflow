/**
 * What a node shows in each disclosure level — 07-ui.md §3, §4.
 *
 * One source of truth for both the rendered node body and the size the layout
 * measures it at, so ELK never lays out a box the component then overflows.
 */

import type { WorkflowNode } from "@codeflow/core";
import { formatFieldValue } from "../inspector/expression.js";
import { stringData } from "../graph/index.js";
import { MAX_TAKES_ROWS, takesLines, type NodeDataLinks } from "./data-links.js";

export type DisclosureMode = "compact" | "expanded" | "developer";

export interface SummaryRow {
  key: string;
  value: string;
  /**
   * React key, when several rows share a visible `key` — a step that takes
   * values from three others gets one `Takes` label and three lines under it.
   */
  id?: string;
  /** Marks the provenance rows, which are styled quieter than the settings. */
  kind?: "takes";
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

/**
 * Where this step's values came from, written out (07 §3 + the data-edge rule).
 *
 * These rows exist because the dashed data edges are hidden by default. They
 * carry exactly what the hidden line carried — the value's name and the step
 * that produced it — so nothing is lost by not drawing it. Capped at three
 * lines; the rest is *counted*, never dropped, and the inspector lists all of
 * them.
 */
export function takesRows(links: NodeDataLinks | null | undefined): SummaryRow[] {
  const lines = takesLines(links);
  if (lines.length === 0) return [];
  const shown = lines.slice(0, MAX_TAKES_ROWS);
  const rows: SummaryRow[] = shown.map((line, i) => ({
    id: `takes:${String(i)}`,
    key: i === 0 ? "Takes" : "",
    value: line,
    kind: "takes",
  }));
  if (lines.length > shown.length) {
    rows.push({
      id: "takes:more",
      key: "",
      value: `+${String(lines.length - shown.length)} more — see the step's details`,
      kind: "takes",
    });
  }
  return rows;
}

/** Rows rendered in the *expanded* level (07 §3). */
export function nodeSummaryRows(node: WorkflowNode, links?: NodeDataLinks | null): SummaryRow[] {
  return [...ownSummaryRows(node), ...takesRows(links)];
}

function ownSummaryRows(node: WorkflowNode): SummaryRow[] {
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
      // "Input", not "Takes": `Takes` now means "this value arrived from that
      // step", and one word must not mean two things on the same card.
      return [{ key: "Input", value: stringData(node, "inputType") ?? "unknown" }, ...outputRow(node)];
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

/* -------------------------------------------------------------------------- */
/* decision titles                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A decision's title in plain language — or nothing, which is the point.
 *
 * `stat.content.includes("size: 0")` as the title of a step is a developer fact
 * wearing a product's clothes, and at the beginner level it is the single most
 * alienating thing on the canvas. But an *invented* meaning would be far worse
 * than an ugly true one, so this only rewrites shapes whose translation is
 * exact, and returns `null` for everything else — an unreadable truth beats a
 * readable guess.
 *
 * Anything with `&&`, `||`, a ternary or a newline is refused outright: those
 * are the shapes where an English rendering starts implying a precedence the
 * source does not have.
 */
export function plainCondition(expression: string | null): string | null {
  if (expression === null) return null;
  let text = expression.trim();
  if (text.length === 0 || text.length > 90) return null;
  // `?` covers the ternary, `?.` and `??` in one go; `&&`/`||` are the shapes
  // whose English rendering would imply a precedence the source does not have.
  // A bare `:` is deliberately allowed — `stat.content.includes("size: 0")` is
  // one of the real labels this exists for, and its colon is inside a string.
  if (/[\n?]|&&|\|\|/.test(text)) return null;

  // One layer of redundant outer parens, and only when they wrap the whole
  // expression — `(a) === (b)` must not become `a) === (b`.
  while (text.startsWith("(") && text.endsWith(")") && balanced(text.slice(1, -1))) {
    text = text.slice(1, -1).trim();
  }

  let negated = false;
  if (text.startsWith("!") && !text.startsWith("!=")) {
    const inner = text.slice(1).trim();
    // `!(a === b)` is a negation of a comparison — out of scope, and rewriting
    // it by flipping the operator is exactly the kind of cleverness that lies.
    if (/[=<>]/.test(inner)) return null;
    text = inner;
    while (text.startsWith("(") && text.endsWith(")") && balanced(text.slice(1, -1))) {
      text = text.slice(1, -1).trim();
    }
    negated = true;
  }

  const method = new RegExp(
    `^(${SUBJECT})\\.(includes|startsWith|endsWith|hasOwnProperty)\\((.+)\\)$`,
  ).exec(text);
  if (method !== null && balanced(method[1]) && balanced(method[3])) {
    const [, subject, name, argument] = method;
    const verb =
      name === "includes"
        ? negated ? "does not contain" : "contains"
        : name === "startsWith"
          ? negated ? "does not start with" : "starts with"
          : name === "endsWith"
            ? negated ? "does not end with" : "ends with"
            : negated ? "does not have" : "has";
    return `${subject} ${verb} ${strip(argument)}`;
  }

  if (negated) return `not ${text}`;

  const empty = new RegExp(`^(${SUBJECT})\\.length\\s*(===|==|>|!==|!=)\\s*0$`).exec(text);
  if (empty !== null && balanced(empty[1])) {
    const [, subject, operator] = empty;
    return operator === ">" || operator.startsWith("!") ? `${subject} is not empty` : `${subject} is empty`;
  }

  const compare = /^(.+?)\s(===|!==)\s(.+)$/.exec(text);
  if (compare !== null) {
    const [, left, operator, right] = compare;
    // A second comparison anywhere means the split above may not be the top
    // level one — refuse rather than risk reading the expression wrong.
    if (/(===|!==|<|>)/.test(left) || /(===|!==|<|>)/.test(right)) return null;
    if (!balanced(left) || !balanced(right)) return null;
    return `${left.trim()} is ${operator === "!==" ? "not " : ""}${strip(right.trim())}`;
  }

  return null;
}

/**
 * What can stand on the left of `.includes(…)` or `.length === 0`.
 *
 * Call parentheses are in, because `planFile.content.trim().length === 0` is a
 * real label from a real example and "planFile.content.trim() is empty" is an
 * exact reading of it. The balance check at each use site is what keeps the
 * permissiveness safe: an unbalanced match means the split fell inside an
 * argument list, and the translation is abandoned.
 */
const SUBJECT = "[A-Za-z_$][\\w$.\\[\\]\"'`()]*";

/** Quotes carry no meaning to a reader who is not reading code. */
function strip(value: string): string {
  const text = value.trim();
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(text);
  return quoted === null ? text : `“${quoted[2]}”`;
}

function balanced(text: string): boolean {
  let depth = 0;
  for (const character of text) {
    if (character === "(") depth++;
    else if (character === ")") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

/**
 * The title a node card shows.
 *
 * Identical to `node.label` everywhere except a *decision* at the beginner
 * level, where an expression that translates exactly is shown in words instead.
 * The raw expression is never thrown away — it is the card's tooltip, and it is
 * what the Details and Code levels show.
 */
export function nodeTitle(node: WorkflowNode, mode: DisclosureMode): string {
  if (mode !== "compact" || node.type !== "condition") return node.label;
  if (node.data["labelSource"] !== "expression") return node.label;
  return plainCondition(stringData(node, "expression") ?? node.label) ?? node.label;
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

/**
 * Whether a card draws a block under its header at this level.
 *
 * The answer decides which block owes the card its bottom padding, so the
 * component and `measureNode` have to agree on it exactly — hence one function,
 * asked by both.
 */
export function hasNodeBody(
  node: WorkflowNode,
  mode: DisclosureMode,
  links?: NodeDataLinks | null,
): boolean {
  if (mode === "compact") return false;
  // The developer level always has something to show: the source verbatim.
  if (mode === "developer") return true;
  return nodeSummaryRows(node, links).length > 0;
}

/** Rows a given mode actually renders — used by both the component and `measureNode`. */
export function rowsForMode(
  node: WorkflowNode,
  mode: DisclosureMode,
  links?: NodeDataLinks | null,
): SummaryRow[] {
  // The developer level shows the source verbatim, and the source *is* the
  // provenance — `const { rows } = await parseDelimitedFile(...)` names both
  // ends. Restating it would be the same fact twice.
  if (mode === "compact" || mode === "developer") return [];
  return nodeSummaryRows(node, links);
}
