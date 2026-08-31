/**
 * Which of the run states a node card is actually in — the decision, without
 * the JSX.
 *
 * It lives apart from `nodes.tsx` because this package's tests run in node: a
 * branch that decides whether a step reads as "in progress" or as "nothing was
 * reported" is exactly the kind of claim that has to be pinned by a test, and a
 * branch inside a component could not be.
 *
 * The state that motivated the split is `reported-nothing` / `emitted-only`.
 * `summarizeRun` starts a node at `runs: 0, status: "running"` and an emit
 * copies that through untouched — deliberately, so a reader can tell "emitted,
 * no lifecycle reported" from "ran once" (09 §1). The badge chain used to fall
 * through that blank state into the container case and print **in progress** on
 * a step nothing had reported starting; and any status it did not recognise —
 * `skipped` among them — fell all the way through to the duration badge and
 * read as a completed step. Both are the same defect: a card stating something
 * the run never said (07 §5).
 */

import type { NodeRunState } from "@codeflow-team/core";

export type RunBadgeKind =
  /** The one step executing right now. */
  | "running"
  /** Started, not finished, and something deeper is the active step. */
  | "container"
  | "failed"
  /** The runtime said it will not report on this step — not that it did not run. */
  | "skipped"
  /** Mid-step output arrived, but no lifecycle event ever did. */
  | "emitted-only"
  /** The run mentions the node and says nothing about its lifecycle at all. */
  | "reported-nothing"
  /** Finished. */
  | "ok";

/**
 * `state` is what `summarizeRun` folded for this node; `isActive` is whether it
 * is the run's current step.
 *
 * Order matters: the two "nothing was reported" cases are checked **first**,
 * because they are indistinguishable from a container mid-flight by status
 * alone, and getting them wrong is what put a false "in progress" on the card.
 */
export function runBadgeKind(state: NodeRunState, isActive: boolean): RunBadgeKind {
  if (state.runs === 0 && state.status === "running") {
    return (state.emits?.length ?? 0) > 0 ? "emitted-only" : "reported-nothing";
  }
  if (state.status === "skipped") return "skipped";
  if (isActive) return "running";
  if (state.status === "failed") return "failed";
  if (state.status === "running") return "container";
  return "ok";
}

/** Whether this kind says the step completed. Nothing else may imply it. */
export function isCompleted(kind: RunBadgeKind): boolean {
  return kind === "ok";
}
