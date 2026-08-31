/**
 * Execution tracing — the contract only (09-future.md §1).
 *
 * Core describes what a run looks like and maps positions back to nodes. It
 * does not run anything, and adding something that does would break I7
 * (11-testing.md) — `test/no-execution.test.ts` is there to make that break
 * loud.
 */

export type {
  IterationPath,
  NodeRange,
  RunEmit,
  RunEvent,
  RunPhase,
  RunStatus,
  RunTrace,
} from "./types.js";
export {
  isSyntheticNode,
  nodeAtOffset,
  nodeForRange,
  nodeRanges,
  rangeLength,
  summarizeRun,
  summarizeTrace,
  traceIdentity,
  traceMatches,
} from "./resolve.js";
export type {
  NodeIterationState,
  NodeRunState,
  RunNodeStatus,
  SummarizeRunOptions,
  TraceMatch,
} from "./resolve.js";
