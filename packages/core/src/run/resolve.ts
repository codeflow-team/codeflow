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
import type { IterationPath, NodeRange, RunEmit, RunEvent, RunTrace } from "./types.js";

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

/** The lifecycle status of one node, or of one pass through it. */
export type RunNodeStatus = "running" | "ok" | "failed" | "skipped";

/**
 * One observed pass through a node, so a UI can offer an item selector on the
 * node card ("item 3 of 5") instead of only ever showing the last value.
 *
 * There is one of these per **distinct `RunEvent.iteration`** seen for the
 * node, in first-observation order. Events that carry no `iteration` produce no
 * entry at all: core has no way to number them, and numbering them anyway would
 * put an item index on the screen that nothing in the run supports (07 §5). A
 * node whose events are all un-numbered therefore has no `iterations` array,
 * and the UI shows what it has always shown — the latest value.
 */
export interface NodeIterationState {
  /** Loop-index stack, outermost first — see `IterationPath`. */
  iteration: IterationPath;
  status: RunNodeStatus;
  /** Wall time of this pass, once it completed. */
  durationMs?: number;
  /** Preview from this pass — the value this item produced, not the latest. */
  preview?: unknown;
}

/** What a trace says about one node, folded across every time it ran. */
export interface NodeRunState {
  nodeId: string;
  /** How many times the node started — a step inside a loop runs many times. */
  runs: number;
  /** `running` while a `started` has no matching end yet. */
  status: RunNodeStatus;
  /** Duration of the most recent completed run. */
  durationMs?: number;
  /** Summed duration of every completed run — what a loop body really cost. */
  totalMs: number;
  /** Preview from the most recent completed run. */
  preview?: unknown;
  error?: { message: string; stack?: string };
  /** `at` of the most recent event, for ordering. */
  lastAt: number;
  /**
   * Per-iteration detail, in observation order — absent when no event for this
   * node carried an `iteration`. See `NodeIterationState`.
   *
   * `preview` above keeps its original meaning exactly (the most recent
   * completed run), so a caller that ignores this field behaves as before.
   */
  iterations?: NodeIterationState[];
  /**
   * Everything this node emitted mid-step, in the order given.
   *
   * An emit never moves `status`, `runs`, `durationMs` or `preview`: an image
   * arriving is not a step finishing, and a node card that showed "done"
   * because a log line appeared would be stating something the run never said.
   */
  emits?: RunEmit[];
  /**
   * Set only when a cap in `SummarizeRunOptions` actually dropped something.
   *
   * There is no silent dropping in core — if a list is short, either the
   * runtime sent that much or this flag is here to say otherwise.
   */
  truncated?: { iterations?: boolean; emits?: boolean };
}

/**
 * Caps for the per-node lists. **Both default to no cap.**
 *
 * Core does not decide how much of a run is worth keeping — that is the
 * runtime's policy, the same policy that already decides how big a `preview`
 * is. A cap applied here without the caller asking would make a UI show a
 * partial list as if it were the whole one, so the only capping available is
 * explicit, and whatever it drops is reported in `NodeRunState.truncated`.
 */
export interface SummarizeRunOptions {
  /** Mid-step output to fold in alongside the events. */
  emits?: readonly RunEmit[];
  /** Max `iterations` entries per node. Default: unlimited. */
  maxIterationsPerNode?: number;
  /** Max `emits` entries per node. Default: unlimited. */
  maxEmitsPerNode?: number;
}

/** Stable key for an iteration path — `[1, 0]` and `[10]` must not collide. */
function iterationKey(iteration: IterationPath): string {
  return iteration.join(".");
}

function blankState(nodeId: string, at: number): NodeRunState {
  return { nodeId, runs: 0, status: "running", totalMs: 0, lastAt: at };
}

/**
 * Fold a list of events into per-node state.
 *
 * Pure and order-dependent only on the list given, so a UI can call it on every
 * SSE frame and get the same answer it would get from the finished trace. That
 * still holds with emits: they are folded in the order given, and folding them
 * changes nothing else about the node.
 */
export function summarizeRun(
  events: readonly RunEvent[],
  options: SummarizeRunOptions = {},
): Map<string, NodeRunState> {
  const out = new Map<string, NodeRunState>();
  /** nodeId → iteration key → index into that node's `iterations`. */
  const seen = new Map<string, Map<string, number>>();

  for (const event of events) {
    const current = out.get(event.nodeId) ?? blankState(event.nodeId, event.at);
    const next: NodeRunState = { ...current, lastAt: event.at };
    if (event.phase === "pass") {
      // Not a lifecycle transition: a container beginning another pass has not
      // started or finished anything. Touching `runs` here made a three-pass
      // loop report `×4` on the canvas — `runs` counts `started`, and a loop
      // starts once. Only `lastAt` (above) and the per-pass entry below move.
      //
      // The pass before this one is over by definition, so it stops reading as
      // still running.
      closeOpenPasses(next);
    } else if (event.phase === "started") {
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
      // The container is done, so its last pass is done with it.
      closeOpenPasses(next);
    }

    if (event.iteration !== undefined) {
      // Appended in place. The array is created by this call and only ever
      // reachable through the map this call returns, so growing it is invisible
      // from outside — and copying it per event would make a 1000-iteration
      // loop quadratic on every frame a UI folds.
      const iterations = next.iterations ?? [];
      const index = seen.get(event.nodeId) ?? new Map<string, number>();
      const key = iterationKey(event.iteration);
      const at = index.get(key);
      if (at === undefined) {
        const cap = options.maxIterationsPerNode;
        if (cap !== undefined && iterations.length >= cap) {
          next.truncated = { ...next.truncated, iterations: true };
        } else {
          index.set(key, iterations.length);
          // Created *and* folded: the first event about a pass is often the one
          // that completes it (a runtime may report only completions), and its
          // duration and preview belong to that pass, not to nothing.
          iterations.push(
            foldIteration({ iteration: [...event.iteration], status: statusOf(event) }, event),
          );
        }
      } else {
        iterations[at] = foldIteration(iterations[at], event);
      }
      seen.set(event.nodeId, index);
      if (iterations.length > 0) next.iterations = iterations;
    }

    out.set(event.nodeId, next);
  }

  for (const emit of options.emits ?? []) {
    const current = out.get(emit.nodeId) ?? blankState(emit.nodeId, emit.at);
    // An emit is evidence that the node produced something, and evidence of
    // nothing else: `status` and `runs` are copied through untouched. A node
    // that only ever emitted keeps `runs: 0`, which is how a reader tells
    // "emitted, no lifecycle reported" from "ran once".
    const next: NodeRunState = { ...current };
    const kept = current.emits ?? [];
    const cap = options.maxEmitsPerNode;
    if (cap !== undefined && kept.length >= cap) {
      next.truncated = { ...next.truncated, emits: true };
    } else {
      kept.push(emit);
    }
    next.emits = kept;
    out.set(emit.nodeId, next);
  }

  return out;
}

/** Status implied by one lifecycle event, on its own. */
function statusOf(event: RunEvent): RunNodeStatus {
  // A pass that has just been announced is under way; a later `pass`, or the
  // container finishing, is what completes it.
  if (event.phase === "started" || event.phase === "pass") return "running";
  if (event.phase === "skipped") return "skipped";
  return event.phase === "failed" ? "failed" : "ok";
}

/**
 * Mark every pass of this node that is still open as completed.
 *
 * Called when the next pass begins and when the container itself ends. A pass
 * left reading `running` after the loop is over states something the run did
 * not: nothing is executing there any more.
 */
function closeOpenPasses(state: NodeRunState): void {
  const iterations = state.iterations;
  if (iterations === undefined) return;
  for (let i = 0; i < iterations.length; i += 1) {
    if (iterations[i].status === "running") iterations[i] = { ...iterations[i], status: "ok" };
  }
}

/** Later events about the same iteration refine that iteration's entry. */
function foldIteration(entry: NodeIterationState, event: RunEvent): NodeIterationState {
  const next: NodeIterationState = { ...entry, status: statusOf(event) };
  if (event.durationMs !== undefined) next.durationMs = event.durationMs;
  if (event.preview !== undefined) next.preview = event.preview;
  return next;
}

/**
 * Fold a whole trace, events and emits together.
 *
 * Convenience only — `summarizeRun(trace.events, { emits: trace.emits })` is
 * the same thing, and this exists so a caller cannot forget the second half.
 */
export function summarizeTrace(
  trace: Pick<RunTrace, "events" | "emits">,
  options: Omit<SummarizeRunOptions, "emits"> = {},
): Map<string, NodeRunState> {
  return summarizeRun(trace.events, { ...options, emits: trace.emits });
}

/** Whether a trace's values may still be shown against a graph. */
export type TraceMatch = "current" | "stale" | "unknown";

/**
 * The two fields that tie a trace to the graph it ran against.
 *
 * Use this when starting a run so the trace carries the identity the analyzer
 * already computed, rather than a second hashing scheme that would answer a
 * subtly different question.
 */
export function traceIdentity(graph: WorkflowGraph): { graphId: string; sourceHash: string } {
  return { graphId: graph.id, sourceHash: graph.source.contentHash };
}

/**
 * Does this trace still describe this graph?
 *
 * - `current` — every identity field the trace carries matches the graph.
 * - `stale` — at least one does not. The run happened against different code
 *   (or a different registry), so its values belong to a flow that no longer
 *   exists. Node ids survive patches on purpose (I5), which is exactly why a
 *   stale value silently re-attaches to the node whose code just changed.
 * - `unknown` — the trace carries neither field, so there is nothing to
 *   compare. This is never a guess in either direction.
 *
 * **`unknown` must be rendered as uncertainty**, not as `current` (07 §5): "this
 * run may be out of date" is the honest caption; showing the value plainly says
 * "this is what your flow does now", which nothing here established. A graph
 * that is absent is `unknown` for the same reason.
 *
 * Any mismatch wins over any match: a `graphId` that agrees while the
 * `sourceHash` disagrees is contradictory evidence, and the safe reading of
 * contradictory evidence is `stale`.
 */
export function traceMatches(
  trace: Pick<RunTrace, "graphId" | "sourceHash"> | null | undefined,
  graph: WorkflowGraph | null | undefined,
): TraceMatch {
  if (trace === null || trace === undefined) return "unknown";
  if (graph === null || graph === undefined) return "unknown";

  let compared = 0;
  let allMatch = true;
  if (trace.graphId !== undefined) {
    compared++;
    if (trace.graphId !== graph.id) allMatch = false;
  }
  if (trace.sourceHash !== undefined) {
    compared++;
    if (trace.sourceHash !== graph.source.contentHash) allMatch = false;
  }
  if (compared === 0) return "unknown";
  return allMatch ? "current" : "stale";
}
