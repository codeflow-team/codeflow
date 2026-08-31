/**
 * The text an opaque-region edit starts from (06 §2).
 *
 * `$code` replaces a range the patch engine locates itself; the UI only needs
 * the *current* text of that range to put in the editor. For a `code`/`unknown`
 * node that is the node's own source range. For a local function it is the body
 * between the braces of its declaration — found here by scanning, because the
 * graph maps a function node to the **call**, not to the declaration.
 *
 * The scan is prefill only: if it cannot find the body it says so, and the UI
 * refuses to open an editor over text it is not sure about rather than showing
 * a plausible guess (I6).
 */

import type { WorkflowGraph, WorkflowNode } from "@codeflow-team/core";

/** Verbatim source of the node's own range — exactly what `$code` replaces. */
export function nodeRegionText(graph: WorkflowGraph, node: WorkflowNode): string {
  return graph.source.content.slice(node.source.start.offset, node.source.end.offset);
}

/**
 * Body of `function <name>(…) { … }` in `source`, without the braces — the text
 * `$code` replaces for a local function node. `null` when the declaration is not
 * a plain block-bodied function in this file.
 */
export function localFunctionBody(source: string, name: string): string | null {
  const declaration = new RegExp(`(^|[^\\w$])function\\s*\\*?\\s+${escapeIdentifier(name)}\\s*[(<]`);
  const match = declaration.exec(source);
  if (match === null) return null;

  const open = findBodyBrace(source, match.index + match[0].length - 1);
  if (open === -1) return null;
  const close = matchBrace(source, open);
  if (close === -1) return null;
  return source.slice(open + 1, close);
}

function escapeIdentifier(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The `{` that opens the function body: the first one after the parameter list
 * and any return-type annotation, skipping over nested brackets in both.
 */
function findBodyBrace(source: string, from: number): number {
  let depth = 0;
  for (let i = from; i < source.length; i++) {
    const character = source[i];
    if (character === "(" || character === "[" || character === "<") depth += 1;
    else if (character === ")" || character === "]" || character === ">") depth -= 1;
    else if (character === "{") {
      // A `{` while brackets are still open belongs to a destructured parameter
      // or an inline object type, not to the body.
      if (depth <= 0) return i;
      depth += 1;
    } else if (character === "}") depth -= 1;
  }
  return -1;
}

/** Index of the `}` closing the block opened at `open`, or -1. */
function matchBrace(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const character = source[i];
    if (character === "'" || character === '"' || character === "`") {
      i = skipString(source, i);
      if (i === -1) return -1;
      continue;
    }
    if (character === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      if (end === -1) return -1;
      i = end;
      continue;
    }
    if (character === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the closing quote of the literal starting at `start`, or -1. */
function skipString(source: string, start: number): number {
  const quote = source[start];
  for (let i = start + 1; i < source.length; i++) {
    const character = source[i];
    if (character === "\\") {
      i += 1;
      continue;
    }
    if (character === quote) return i;
    if (quote !== "`" && character === "\n") return -1;
  }
  return -1;
}
