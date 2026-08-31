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
 *
 * ## The value a step produced
 *
 * `instrument.ts` hands the closing marker whatever the statement declared
 * (`__cf.f("n7", rows)`) and the pass marker the loop's item
 * (`__cf.pass("n12", ticket)`). Three rules apply to what arrives:
 *
 *  - it goes through the same `preview()` shortening every tool result does.
 *    Truncation is runtime policy — core deliberately has no opinion about how
 *    much of a value is worth sending;
 *  - a **thenable** is not recorded. A binding holding a promise the statement
 *    never awaited has no settled value to show, and the two ways of getting
 *    one are to send `{}` (what `JSON.stringify` makes of a promise) or to await
 *    it, which would make the probe advance the program. It records
 *    `UNAWAITED_BINDING` instead, which says what happened;
 *  - a binding that *is* the value a tool just returned leaves the tool's
 *    envelope alone, so "live MCP" / "sample data" survives on the step that
 *    read it. See `ProbeFrame.toolValue`.
 *
 * One cost is worth naming rather than discovering: `preview` **serialises**,
 * and serialising an object runs its getters. The marker itself is free — it
 * takes the binding's name and touches no property of it — but shortening the
 * value for display reads it, once, per recorded value. That was already true
 * of every tool result and of every `Promise.all` element; recording bindings
 * widens it to any value a step declares, and there is no version of "show what
 * this produced" that does not read what it produced.
 *
 * ## A pass is a report of its own
 *
 * A loop used to send exactly two events — one `started`, one `finished` — so
 * however many times it went round, a UI had one value to show for it and no
 * way to ask for the third item. `pass` therefore reports each pass as a
 * `started` carrying that pass's iteration and that pass's item, closed by a
 * `finished` when the next pass begins (or when the loop does). Core's
 * `summarizeRun` folds those into one `NodeIterationState` per pass, which is
 * exactly what an item selector reads.
 *
 * Two consequences, both deliberate:
 *
 *  - a loop's `runs` becomes "one, plus one per pass". `runs` counts `started`
 *    events and there is no phase that adds an iteration entry without being
 *    one — a `finished` would flip the node to "done" while it is still going
 *    round, which is the larger lie of the two;
 *  - the per-pass events carry **no `durationMs`**, so `totalMs` keeps meaning
 *    the loop's own wall time instead of counting it twice.
 */

import type { RunEvent, RunPhase } from "@codeflow-team/core";

/** One open step. `preview` is filled in by whoever called a tool inside it. */
export interface ProbeFrame {
  nodeId: string;
  at: number;
  /** Result of the last tool call made while this frame was innermost. */
  preview?: unknown;
  /**
   * The raw result of that tool call, kept only to be compared by identity.
   *
   * `const file = await tools.fs.readTextFile(…)` binds *the same object* the
   * tool returned, and the tool's own envelope (`{ tool, source, value }`) says
   * where it came from — live MCP or a stub. When the binding turns out to be
   * that very value, the envelope is left alone so the provenance badge
   * survives; when it is something else, the binding is what the step produced
   * and the envelope would be attributing it to a tool that did not make it.
   */
  toolValue?: unknown;
  /** Whether `toolValue` was ever set — a tool may legitimately return `undefined`. */
  hasToolValue?: boolean;
  /**
   * Pass counter, for a frame that is a loop. `undefined` until the body runs
   * once — a loop that never entered its body has no pass, which is different
   * from being on pass 0.
   */
  pass?: number;
  /** True while a pass of this loop has been reported and not yet closed. */
  passOpen?: boolean;
  /** Iteration path of that open pass, captured when it opened. */
  passIteration?: number[];
  /** While open, nothing inside it may be given an iteration. See the header. */
  opaque?: boolean;
  /** The stack as it stood when this frame opened. */
  iteration?: number[];
}

/**
 * What is recorded for a binding holding a promise the statement never awaited.
 *
 * Storing the promise itself would send `{}` — a `Promise` has no enumerable
 * own properties, so every such step would report an empty object as if that
 * were its value. Awaiting it to find out is not available either: the probe
 * would then be advancing the program it exists to watch. So the run says what
 * it actually knows, which is that it did not look.
 */
export const UNAWAITED_BINDING = Object.freeze({
  __unobserved: "promise",
  note: "This step bound a promise it did not await, so the run has no settled value for it — awaiting it to look would have changed the program.",
});

function isThenable(value: unknown): boolean {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  return typeof (value as { then?: unknown }).then === "function";
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
  /**
   * A step finished — and, when the statement declared one, the binding it left
   * behind.
   *
   * The value is passed as a **rest parameter** rather than an optional one so
   * that `f(id)` and `f(id, undefined)` stay distinguishable: a statement whose
   * binding really is `undefined` said something, and a statement that declared
   * nothing said nothing, and those are not the same fact.
   */
  f: (nodeId: string, ...bound: unknown[]) => void;
  /** Entry to a `catch` — everything still open inside the `try` failed. */
  x: (nodeId: string) => void;
  /** A step that is an expression (an element of `Promise.all`). */
  p: <T>(nodeId: string, thunk: () => T) => T;
  /**
   * Top of a loop body: this loop just began another pass, over this item.
   *
   * The item is optional for the same reason and by the same means as `f`'s
   * binding: a `while` loop has no item, and inventing one would be worse than
   * saying nothing.
   */
  pass: (nodeId: string, ...item: unknown[]) => void;
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
  /**
   * Record what a statement bound, as this step's value.
   *
   * The binding wins over a tool result recorded earlier in the same step,
   * because the binding is what the step *produced*: in
   * `const summary = shorten(await tools.fs.read(p))` the tool's answer is an
   * ingredient, not the outcome. The one case where it does not win is the case
   * where the two are the same object, which is where the tool's provenance
   * envelope is worth more than repeating its contents.
   */
  function recordBinding(frame: ProbeFrame, value: unknown): void {
    if (isThenable(value)) {
      frame.preview = UNAWAITED_BINDING;
      return;
    }
    if (frame.hasToolValue === true && Object.is(value, frame.toolValue)) return;
    frame.preview = preview(value);
  }

  /**
   * Close the pass this loop frame has open, if it has one.
   *
   * Called from `pass` (the next pass is starting) and from `close` (the loop
   * itself is ending, however it ends), so no path can leave a pass reported as
   * started and never ended.
   */
  function closePass(
    frame: ProbeFrame,
    phase: "finished" | "failed",
    error?: { message: string; stack?: string },
  ): void {
    if (frame.passOpen !== true) return;
    frame.passOpen = false;
    // Only a *failure* needs reporting now. A pass that simply ended is closed
    // by `summarizeRun` when the next `pass` arrives or when the loop itself
    // finishes — no second event, and nothing that could be mistaken for the
    // container completing.
    if (phase !== "failed") return;
    // No `durationMs`: `summarizeRun` sums those into `totalMs`, and a loop's
    // passes plus the loop itself would count the same time twice.
    emit(frame.nodeId, phase, frame.passIteration, error === undefined ? {} : { error });
  }

  function close(frame: ProbeFrame, phase: "finished" | "failed", error?: { message: string; stack?: string }): void {
    closePass(frame, phase, error);
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

    f(nodeId: string, ...bound: unknown[]): void {
      const index = openIndexOf(nodeId);
      if (index === -1) return;
      // Anything still open above this step left early (a `break`, a
      // `continue`, a `return`). It ran; it just did not reach its own marker.
      unwindAbove(index, "finished");
      const frame = stack.pop();
      if (frame === undefined) return;
      // `bound.length` and not `bound[0] !== undefined`: a statement that bound
      // `undefined` reported a value, and one that declared nothing did not.
      if (bound.length > 0) recordBinding(frame, bound[0]);
      close(frame, "finished");
    },

    x(nodeId: string): void {
      const index = openIndexOf(nodeId);
      if (index === -1) return;
      unwindAbove(index, "failed", { message: "An error was thrown before this step finished." });
    },

    pass(nodeId: string, ...item: unknown[]): void {
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
      closePass(frame, "finished");
      frame.pass = frame.pass === undefined ? 0 : frame.pass + 1;

      // A loop that names no item — a `while`, a `for (;;)` — reports nothing
      // extra, and its event stream is exactly what it was before items existed.
      if (item.length === 0) return;
      // Read *after* the bump, so the pass event carries its own number rather
      // than the previous pass's.
      const iteration = iterationNow();
      frame.passOpen = true;
      if (iteration === undefined) delete frame.passIteration;
      else frame.passIteration = iteration;
      const shown = isThenable(item[0]) ? UNAWAITED_BINDING : preview(item[0]);
      // `pass`, not `started`. A loop that runs three times started once and
      // finished once; reporting each lap as a `started` made `runs` read 4 and
      // the canvas drew `×4` beside a three-pass loop. Core added the phase for
      // exactly this: it carries the iteration and the item without claiming
      // the node ran again (run/types.ts).
      emit(nodeId, "pass", iteration, shown === undefined ? {} : { preview: shown });
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
