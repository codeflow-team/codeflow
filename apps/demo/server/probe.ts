/**
 * The object the instrumenter's markers call — and the only place that decides
 * which pass through a loop an event belongs to.
 *
 * It lives apart from `worker.ts` for one reason: `worker.ts` reads
 * `workerData` at import time, so it cannot be imported by a test, and the
 * iteration rules below are exactly the part that has to be tested against real
 * instrumented programs rather than against a mock of itself.
 *
 * ## Counting passes
 *
 * `instrument()` puts `__cf.pass(loopId)` at the top of every loop body it can
 * safely reach. Each call bumps that loop's frame counter — first entry is `0`,
 * matching `IterationPath`'s "`[2]` is the third item". An event is stamped
 * with the counters of every open loop frame, outermost first, which is
 * `RunEvent.iteration`.
 *
 * A frame's iteration is captured **when it opens**, not when it closes, so the
 * `started` and `finished` of one step always agree — and a loop's own
 * `finished` belongs to the pass of its *parent*, not to the last pass of
 * itself.
 *
 * ## Why a counter stack is not always enough — and what is done about it
 *
 * A single mutable stack is correct only while execution is sequential.
 * `for...of` with `await` inside is sequential, and so is `for await...of`:
 * the body of pass *n* completes before pass *n+1* starts, so the counter is
 * right. `Promise.all` is not: its branches interleave, and a global stack
 * would hand an event from branch B the pass number branch A happened to leave
 * behind — an item index the run never established.
 *
 * The fix is **not** to wrap loop bodies in callbacks so `AsyncLocalStorage`
 * can carry the context: that changes what `break`, `continue` and `return`
 * mean, and the instrumenter's whole contract is one sentence — *the
 * instrumented program must do exactly what the original program did*.
 *
 * So this **detects and omits**. While a step that makes the stack unreliable
 * is open — a `parallel` node between its start and its finish, a loop whose
 * body could not be reached — every event is sent with **no `iteration` field
 * at all**, and numbering resumes the moment it closes. `RunEvent.iteration`'s
 * docblock asks for exactly this: a runtime that cannot count omits it, and the
 * UI must then say "latest" instead of an item number. Omitting is correct.
 * Guessing is the failure this project is organised against (07 §5).
 */

import type { RunEvent, RunPhase } from "@codeflow-team/core";

/** One open step. `preview` is filled in by whoever called a tool inside it. */
export interface ProbeFrame {
  nodeId: string;
  at: number;
  /** Result of the last tool call made while this frame was innermost. */
  preview?: unknown;
  /**
   * Pass counter, for a frame that is a loop. `undefined` until the body runs
   * once — a loop that never entered its body has no pass, which is different
   * from being on pass 0.
   */
  pass?: number;
  /** While open, nothing inside it may be given an iteration. See the header. */
  opaque?: boolean;
  /** The stack as it stood when this frame opened. */
  iteration?: number[];
}

export interface ProbeOptions {
  /** Milliseconds since the run started. */
  now: () => number;
  /** How a settled value is shortened for display. Runtime policy, not core's. */
  preview: (value: unknown) => unknown;
}

/**
 * The marker protocol, as the instrumenter emits it.
 *
 * `s`/`f`/`x`/`p` are the original four; `pass` and `unknown` are what
 * iteration numbering added. All of them are **synchronous** — an inserted
 * `await` would add a microtask boundary the original program did not have,
 * and a probe that can reorder what it observes is not a probe.
 */
export interface Probe {
  /** A step started. */
  s: (nodeId: string) => void;
  /** A step finished. */
  f: (nodeId: string) => void;
  /** Entry to a `catch` — everything still open inside the `try` failed. */
  x: (nodeId: string) => void;
  /** A step that is an expression (an element of `Promise.all`). */
  p: <T>(nodeId: string, thunk: () => T) => T;
  /** Top of a loop body: this loop just began another pass. */
  pass: (nodeId: string) => void;
  /**
   * "From here, an iteration number would be a guess."
   *
   * With a `nodeId`: while that step is open, events carry no iteration. The
   * instrumenter emits it for `parallel` nodes, whose branches interleave.
   *
   * With no argument: for the whole run. Emitted once, at the top of the file,
   * when some loop could not be given a pass marker at all — the conservative
   * answer, because a stack missing a level reads as a *different* stack rather
   * than as a missing one.
   */
  unknown: (nodeId?: string) => void;
}

export interface ProbeController extends Probe {
  /** The innermost open step, for attributing a tool call to a node. */
  current: () => ProbeFrame | undefined;
  /** The loop-index stack right now, or `undefined` if it cannot be known. */
  iterationNow: () => number[] | undefined;
  /** Close the innermost open step as failed — the one that threw. */
  failTop: (error: { message: string; stack?: string }) => void;
  /** Close everything still open. Used when the flow returns, or dies. */
  unwindAll: (phase: "finished" | "failed", error?: { message: string; stack?: string }) => void;
}

/**
 * Build a probe that reports through `send`.
 *
 * Every marker posts immediately; nothing is batched, because a trace that
 * arrives all at once at the end is the same as no trace at all.
 */
export function createProbe(send: (event: RunEvent) => void, options: ProbeOptions): ProbeController {
  const { now, preview } = options;
  const stack: ProbeFrame[] = [];
  /** Set by `unknown()` with no argument — the whole run is unnumbered. */
  let blind = false;
  /** `p` frames in flight: promises running beside the sequential stack. */
  let branches = 0;

  function iterationNow(): number[] | undefined {
    if (blind || branches > 0) return undefined;
    const out: number[] = [];
    for (const frame of stack) {
      if (frame.opaque === true) return undefined;
      if (frame.pass !== undefined) out.push(frame.pass);
    }
    // Empty means "outside every loop", which `RunEvent` spells as *absent*.
    return out.length === 0 ? undefined : out;
  }

  function emit(
    nodeId: string,
    phase: RunPhase,
    iteration: number[] | undefined,
    extra: Partial<RunEvent> = {},
  ): void {
    send({
      nodeId,
      phase,
      at: now(),
      ...extra,
      ...(iteration === undefined ? {} : { iteration }),
    });
  }

  /**
   * Close `frame`, and say why.
   *
   * `unwind` covers the frames that were still open when an enclosing step
   * ended. How that reads depends on *how* it ended, and the difference is not
   * cosmetic: an exception caught by a `try` means the steps inside it failed,
   * while a `break` out of a loop means they simply stopped. The instrumenter
   * marks the entry to every `catch` (`__cf.x`) precisely so the two can be
   * told apart.
   */
  function close(frame: ProbeFrame, phase: "finished" | "failed", error?: { message: string; stack?: string }): void {
    emit(frame.nodeId, phase, frame.iteration, {
      durationMs: now() - frame.at,
      ...(frame.preview === undefined ? {} : { preview: frame.preview }),
      ...(error === undefined ? {} : { error }),
    });
  }

  function unwindAbove(index: number, phase: "finished" | "failed", error?: { message: string; stack?: string }): void {
    while (stack.length > index + 1) {
      const orphan = stack.pop();
      if (orphan !== undefined) close(orphan, phase, error);
    }
  }

  /** Innermost open frame for `nodeId`, or -1. (`findLastIndex` is ES2023.) */
  function openIndexOf(nodeId: string): number {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].nodeId === nodeId) return i;
    return -1;
  }

  return {
    s(nodeId: string): void {
      const iteration = iterationNow();
      stack.push({ nodeId, at: now(), ...(iteration === undefined ? {} : { iteration }) });
      emit(nodeId, "started", iteration);
    },

    f(nodeId: string): void {
      const index = openIndexOf(nodeId);
      if (index === -1) return;
      // Anything still open above this step left early (a `break`, a
      // `continue`, a `return`). It ran; it just did not reach its own marker.
      unwindAbove(index, "finished");
      const frame = stack.pop();
      if (frame !== undefined) close(frame, "finished");
    },

    x(nodeId: string): void {
      const index = openIndexOf(nodeId);
      if (index === -1) return;
      unwindAbove(index, "failed", { message: "An error was thrown before this step finished." });
    },

    pass(nodeId: string): void {
      const index = openIndexOf(nodeId);
      // No open frame means the loop itself was never probed. `unknown()` has
      // already made the run blind in that case, so there is nothing to fix
      // here and nothing to invent.
      if (index === -1) return;
      // A new pass means everything the previous one left open is over. Usually
      // there is nothing: each step closes itself. But `continue` — and
      // `continue label`, which walks out of an inner loop entirely — skips the
      // closing markers on the way out, and those frames would otherwise sit on
      // the stack contributing their counters to the next pass's numbers.
      unwindAbove(index, "finished");
      const frame = stack[index];
      frame.pass = frame.pass === undefined ? 0 : frame.pass + 1;
    },

    unknown(nodeId?: string): void {
      if (nodeId === undefined) {
        blind = true;
        return;
      }
      const index = openIndexOf(nodeId);
      if (index === -1) return;
      stack[index].opaque = true;
    },

    /**
     * A step that is an *expression*, not a statement — an element of
     * `Promise.all([…])`.
     *
     * Several of these are in flight at once, so they cannot use the stack:
     * each gets its own frame, closed when its own promise settles. The promise
     * is *listened to*, never chained, so what the caller gets back is the
     * identical promise with identical timing.
     */
    p<T>(nodeId: string, thunk: () => T): T {
      // Captured before the thunk runs, and used for both ends of this step.
      // Inside a `parallel` it is `undefined` by construction, which is the
      // honest answer for a branch: nothing established which pass it belongs
      // to, because branches interleave.
      const iteration = iterationNow();
      const frame: ProbeFrame = { nodeId, at: now(), ...(iteration === undefined ? {} : { iteration }) };
      emit(nodeId, "started", iteration);
      let value: T;
      try {
        value = thunk();
      } catch (cause) {
        close(frame, "failed", { message: cause instanceof Error ? cause.message : String(cause) });
        throw cause;
      }
      const thenable = value as unknown as { then?: unknown };
      if (typeof thenable?.then === "function") {
        branches += 1;
        (value as unknown as Promise<unknown>).then(
          (settled: unknown) => {
            branches -= 1;
            frame.preview = preview(settled);
            close(frame, "finished");
          },
          (cause: unknown) => {
            branches -= 1;
            close(frame, "failed", { message: cause instanceof Error ? cause.message : String(cause) });
          },
        );
      } else {
        close(frame, "finished");
      }
      return value;
    },

    current: () => stack[stack.length - 1],
    iterationNow,
    failTop(error: { message: string; stack?: string }): void {
      const innermost = stack.pop();
      if (innermost !== undefined) close(innermost, "failed", error);
    },
    unwindAll(phase, error): void {
      unwindAbove(-1, phase, error);
    },
  };
}
