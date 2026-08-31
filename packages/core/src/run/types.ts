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

/**
 * Which pass through the surrounding loops this event belongs to.
 *
 * The loop-index stack, outermost first: `[2]` is the third item of the outer
 * loop, `[2, 0]` its first inner item. An array rather than a number because
 * loops nest, and a single number could only ever name one of the levels —
 * which level being exactly the thing a reader could not recover afterwards.
 *
 * A step outside every loop has no iteration; so does a step inside one that a
 * runtime cannot count. **Omitting it is the correct behaviour** for such a
 * runtime — it must never send `[0]` as a stand-in, because `[0]` means "the
 * first item" and a UI is entitled to believe it.
 *
 * The other half of that contract is the UI's: with no iteration on the events,
 * a node's data browser must say **"latest"**, never "item 1". Inventing an
 * item number would be 07 §5's forbidden move — stating something the system
 * does not know.
 */
export type IterationPath = number[];

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
  /**
   * Loop-index stack for this occurrence — see `IterationPath`.
   *
   * Absent means "not known", never "iteration zero".
   */
  iteration?: IterationPath;
}

/**
 * Something a node said **during** a step — a generated image, a progress
 * tick, a log line.
 *
 * This is deliberately *not* a `RunPhase`. A phase answers "where is this step
 * in its own lifetime", and the fold uses that answer to decide which step is
 * running right now; an image arriving is not a lifetime transition, and
 * folding it in as one would make a node look finished (or restarted) because
 * it printed something. Emits therefore travel beside the lifecycle, on their
 * own list, and `summarizeRun` never lets one touch `status` or `runs`.
 */
export interface RunEmit {
  /** `WorkflowNode.id` that produced this. */
  nodeId: string;
  /** Milliseconds since the run started — same clock as `RunEvent.at`. */
  at: number;
  /**
   * What sort of thing this is: `"progress" | "log" | "artifact"` — or
   * anything else a host defines.
   *
   * An open string, not a union, on purpose. A union would be core enumerating
   * what kinds of things exist to be produced, which is one short step from
   * core enumerating which tools exist (00 §6.6b, I7). Core never interprets
   * this value: it carries it, groups by `nodeId`, and preserves order. The
   * host that defined the kind is the only party that knows what it means.
   */
  kind: string;
  /**
   * The payload, verbatim.
   *
   * `unknown` for the same reason `RunEvent.preview` is: how much of a value is
   * worth sending — the whole image, a thumbnail, a URL — is runtime policy.
   * Core neither shortens nor inspects it, so it cannot silently turn a
   * complete value into a partial one behind the UI's back.
   */
  payload: unknown;
  /** Loop-index stack, if the runtime knows it — see `IterationPath`. */
  iteration?: IterationPath;
}

export type RunStatus = "running" | "ok" | "failed" | "cancelled";

export interface RunTrace {
  runId: string;
  /** Epoch ms — `RunEvent.at` is relative to this. */
  startedAt: number;
  events: RunEvent[];
  status: RunStatus;
  /**
   * Mid-step output, in the order the runtime produced it.
   *
   * A separate list from `events` because it is a separate kind of fact; see
   * `RunEmit`.
   */
  emits?: RunEmit[];
  /**
   * `WorkflowGraph.id` of the graph this run was launched against.
   *
   * Without it a trace is unattached, and that is a real bug rather than a
   * missing nicety: node ids are stable across patches by design (I5), so after
   * the user edits the flow a stale value re-attaches to the very node whose
   * code just changed — the picture says A while the code does B. Today that
   * shows up as a wrong latency; on a node card showing a generated image it is
   * I6's worst case, a wrong meaning stated confidently.
   *
   * The graph id is already a function of (file, source content, registry)
   * — `computeGraphId` in `mapper/ids.ts` — so it moves whenever any input to
   * the graph moves. Copy `graph.id`; do not compute a second one.
   */
  graphId?: string;
  /**
   * `WorkflowGraph.source.contentHash` at launch time.
   *
   * The same hash the analyzer already put on the `SourceDocument` — copy it,
   * never re-hash the file with a different scheme, or the comparison starts
   * answering a different question than the one it looks like it answers.
   *
   * Recorded beside `graphId` because it separates "the code changed" from "the
   * registry changed": both invalidate the trace, and a UI may want to say
   * which. A runtime that has only one of the two fields should still send it.
   */
  sourceHash?: string;
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
