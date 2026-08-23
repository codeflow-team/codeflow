/**
 * Source position → node, and graph → probe plan.
 *
 * Both directions of the tracing join live here, and both are pure functions of
 * a `WorkflowGraph`. This is projection work — core's actual job — and it is
 * the whole of core's contribution to running a flow: a runtime asks "which
 * node owns this offset" or "where are the statements I should report on", gets
 * an answer, and does its own executing somewhere core cannot see.
 */

import type { WorkflowGraph, WorkflowNode } from "../model/graph.js";
import type { NodeRange, RunEvent } from "./types.js";

/** Width of a node's source range, in characters. */
export function rangeLength(node: WorkflowNode): number {
  return node.source.end.offset - node.source.start.offset;
}

/**
 * True for a node that has no AST subtree of its own — the trigger, a merge,
 * an implicit trailing output.
 *
 * These share (or borrow) somebody else's range, so they can never *own* an
 * offset and must never be probed: `mappingForSynthetic` marks them by putting
 * a role qualifier on the semantic path (`flow/if[0]#merge`, `flow#trigger` —
 * 03 §5.1), which is the one place the distinction survives into the graph.
 */
export function isSyntheticNode(node: WorkflowNode): boolean {
  return node.source.semanticPath.includes("#");
}

function contains(node: WorkflowNode, offset: number): boolean {
  return offset >= node.source.start.offset && offset <= node.source.end.offset;
}

function innermostAt(graph: WorkflowGraph | null | undefined, offset: number): WorkflowNode | null {
  let best: WorkflowNode | null = null;
  for (const node of graph?.nodes ?? []) {
    if (!contains(node, offset)) continue;
    if (best === null || rangeLength(node) < rangeLength(best)) best = node;
  }
  return best;
}

/**
 * Innermost node whose source range covers `offset`.
 *
 * Smallest range wins, so a tool call inside a loop is preferred over the loop
 * that contains it. This is the resolver behind two-way selection sync in the
 * UI (07 §2) and behind "which node is this runtime event about" (09 §1) — one
 * rule for both, because they are the same question.
 *
 * A caret sitting in the **indentation** of a line is treated as a caret on
 * that line's statement. Taken literally, column 1 of an indented line is
 * outside every statement on it — the containing `for`/`try` is the innermost
 * node that covers it — so pressing Home would jump the selection from the step
 * the user is reading to its container, and on an unindented statement it would
 * select nothing at all. The line is what a reader means by "here", so leading
 * whitespace resolves forward to the first thing on it, never to something
 * larger than the literal answer.
 */
export function nodeAtOffset(
  graph: WorkflowGraph | null | undefined,
  offset: number,
): WorkflowNode | null {
  const direct = innermostAt(graph, offset);
  const content = graph?.source.content;
  if (content === undefined) return direct;

  const lineStart = content.lastIndexOf("\n", Math.max(offset - 1, 0)) + 1;
  if (offset > lineStart && content.slice(lineStart, offset).trim().length > 0) return direct;

  let scan = offset;
  while (scan < content.length && (content[scan] === " " || content[scan] === "\t")) scan++;
  if (scan === offset) return direct;

  const snapped = innermostAt(graph, scan);
  if (snapped === null) return direct;
  if (direct === null) return snapped;
  // Never let the snap widen the answer: it only ever refines it.
  return rangeLength(snapped) <= rangeLength(direct) ? snapped : direct;
}

/**
 * Innermost node whose range fully contains `[start, end)`.
 *
 * A runtime that reports a *span* rather than a point (a statement, a call
 * expression) resolves through here. Falls back to `nodeAtOffset(start)` when
 * nothing contains the whole span, so a slightly-wrong span still lands on a
 * plausible node instead of nowhere.
 */
export function nodeForRange(
  graph: WorkflowGraph | null | undefined,
  start: number,
  end: number,
): WorkflowNode | null {
  let best: WorkflowNode | null = null;
  for (const node of graph?.nodes ?? []) {
    if (node.source.start.offset > start) continue;
    if (node.source.end.offset < end) continue;
    if (best === null || rangeLength(node) < rangeLength(best)) best = node;
  }
  return best ?? nodeAtOffset(graph, start);
}

/**
 * The nodes a runtime can meaningfully report on, with their source offsets.
 *
 * Synthetic nodes are left out (they own no code), and so is the trigger (its
 * range is the whole function signature). Ordering is outermost-first at equal
 * starts, which is the order an instrumenter wants: a container's marker goes
 * outside the markers of its own children.
 */
export function nodeRanges(graph: WorkflowGraph | null | undefined): NodeRange[] {
  const out: NodeRange[] = [];
  for (const node of graph?.nodes ?? []) {
    if (node.type === "trigger") continue;
    if (isSyntheticNode(node)) continue;
    const start = node.source.start.offset;
    const end = node.source.end.offset;
    if (end <= start) continue;
    out.push({ nodeId: node.id, start, end, type: String(node.type), label: node.label });
  }
  out.sort((a, b) => (a.start === b.start ? b.end - a.end : a.start - b.start));
  return out;
}

/** What a trace says about one node, folded across every time it ran. */
export interface NodeRunState {
  nodeId: string;
  /** How many times the node started — a step inside a loop runs many times. */
  runs: number;
  /** `running` while a `started` has no matching end yet. */
  status: "running" | "ok" | "failed" | "skipped";
  /** Duration of the most recent completed run. */
  durationMs?: number;
  /** Summed duration of every completed run — what a loop body really cost. */
  totalMs: number;
  /** Preview from the most recent completed run. */
  preview?: unknown;
  error?: { message: string; stack?: string };
  /** `at` of the most recent event, for ordering. */
  lastAt: number;
}

/**
 * Fold a list of events into per-node state.
 *
 * Pure and order-dependent only on the list given, so a UI can call it on every
 * SSE frame and get the same answer it would get from the finished trace.
 */
export function summarizeRun(events: readonly RunEvent[]): Map<string, NodeRunState> {
  const out = new Map<string, NodeRunState>();
  for (const event of events) {
    const current = out.get(event.nodeId) ?? {
      nodeId: event.nodeId,
      runs: 0,
      status: "running" as const,
      totalMs: 0,
      lastAt: event.at,
    };
    const next: NodeRunState = { ...current, lastAt: event.at };
    if (event.phase === "started") {
      next.runs = current.runs + 1;
      next.status = "running";
    } else if (event.phase === "skipped") {
      next.status = "skipped";
    } else {
      next.status = event.phase === "failed" ? "failed" : "ok";
      if (event.durationMs !== undefined) {
        next.durationMs = event.durationMs;
        next.totalMs = current.totalMs + event.durationMs;
      }
      if (event.preview !== undefined) next.preview = event.preview;
      if (event.error !== undefined) next.error = event.error;
    }
    out.set(event.nodeId, next);
  }
  return out;
}
