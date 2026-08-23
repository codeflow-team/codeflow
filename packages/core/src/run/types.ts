/**
 * Execution trace contract — 09-future.md §1.
 *
 * This module is the **only** thing core has to say about running a flow, and
 * it says it in types. Core does not execute (00 §5 non-goal 1, I7 in
 * 11-testing.md): it converts source into a graph and edits it back, and a
 * runtime that happens to run the same source reports what it did in the shape
 * declared here. The join between the two is the source mapping every node
 * already carries (03 §4) — "runtime báo đang chạy statement nào → CodeFlow map
 * ngược qua source mapping → highlight node đang chạy" (09 §1).
 *
 * Nothing here imports a runtime, a transport or a Node API. A `RunEvent` is a
 * value; who produced it — a worker thread, a V8 isolate, Temporal — is not
 * core's business, and must never become it.
 */

/**
 * Where a step is in its own lifetime.
 *
 * `started`/`finished` bracket a step: a long `await` sits between them, and
 * that gap is precisely the interval a UI should render as "running". They
 * nest, so at any instant the innermost unfinished step is the one executing.
 *
 * `failed` replaces the `finished` a step never got to. `skipped` is for a step
 * the runtime knows it will never report on — a statement it could not probe
 * without changing the program's meaning, say — and exists so a UI can say
 * "not traced" instead of the lie "not reached" (07 §5 forbids the lie).
 */
export type RunPhase = "started" | "finished" | "failed" | "skipped";

export interface RunEvent {
  /** `WorkflowNode.id` this event is about. */
  nodeId: string;
  phase: RunPhase;
  /** Milliseconds since the run started — monotonic within one trace. */
  at: number;
  /** Wall time of the step, present on `finished`/`failed`. */
  durationMs?: number;
  /**
   * A summary of what the step produced, for display.
   *
   * Deliberately `unknown`: how much of a value is worth sending, and how it is
   * shortened, is a runtime policy — core neither truncates nor interprets it.
   */
  preview?: unknown;
  error?: { message: string; stack?: string };
}

export type RunStatus = "running" | "ok" | "failed" | "cancelled";

export interface RunTrace {
  runId: string;
  /** Epoch ms — `RunEvent.at` is relative to this. */
  startedAt: number;
  events: RunEvent[];
  status: RunStatus;
}

/**
 * One node's source range, addressed the way a runtime needs it.
 *
 * A runtime cannot use `WorkflowNode` — it has no graph — but it can use
 * offsets into the file it is about to run. `nodeRanges` (see `resolve.ts`)
 * projects a graph down to this, and the runtime hands back `nodeId`s.
 */
export interface NodeRange {
  nodeId: string;
  /** 0-based offset of the first character of the node's source range. */
  start: number;
  /** 0-based offset one past its last character. */
  end: number;
  /** Node type, so a runtime can treat containers differently if it wants to. */
  type: string;
  label: string;
}
