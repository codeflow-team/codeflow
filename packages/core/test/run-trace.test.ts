/**
 * Iteration context, mid-step emits, and trace↔graph identity — 09 §1.
 *
 * Three things are pinned here, and all three exist to stop the UI stating
 * something the run never said (07 §5, I6).
 *
 * 1. **Iterations.** A step inside a loop runs many times, and a node card that
 *    can only show "the last one" cannot show the third image of five. The fold
 *    keeps one entry per observed `iteration`, in observation order — and keeps
 *    *no* entry when the runtime did not number the pass, because a number core
 *    invented would look exactly like a number the runtime measured.
 *
 * 2. **Emits.** An image arriving mid-step is not a lifecycle transition. If it
 *    folded in as one, a node would look finished (or restarted) because it
 *    printed a log line. That is the important test in this file.
 *
 * 3. **Identity.** A trace is only about the graph it ran against. Node ids are
 *    stable across patches by design (I5), so an unattached trace re-attaches
 *    its stale values to the very node whose code just changed. `traceMatches`
 *    answers `unknown` rather than guessing when the runtime told us nothing.
 */

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/analyzer/index.js";
import {
  summarizeRun,
  summarizeTrace,
  traceIdentity,
  traceMatches,
  type RunEmit,
  type RunEvent,
  type RunTrace,
} from "../src/run/index.js";
import { loadFixture } from "./harness/fixture.js";

const canonical = loadFixture("01-canonical");
const graph = analyzeSource(canonical.source, canonical.registry, canonical.options);

const event = (
  nodeId: string,
  phase: RunEvent["phase"],
  at: number,
  extra: Partial<RunEvent> = {},
): RunEvent => ({ nodeId, phase, at, ...extra });

const emit = (nodeId: string, kind: string, at: number, payload: unknown, iteration?: number[]): RunEmit =>
  iteration === undefined ? { nodeId, kind, at, payload } : { nodeId, kind, at, payload, iteration };

describe("iteration context", () => {
  it("folds nested loops into one entry per iteration, in observation order", () => {
    // An outer loop of two items; the first item runs an inner loop twice.
    const events: RunEvent[] = [
      event("body", "started", 0, { iteration: [0] }),
      event("body", "finished", 1, { iteration: [0], durationMs: 1, preview: "outer-0" }),
      event("body", "started", 2, { iteration: [0, 0] }),
      event("body", "finished", 3, { iteration: [0, 0], durationMs: 1, preview: "inner-0-0" }),
      event("body", "started", 4, { iteration: [0, 1] }),
      event("body", "finished", 5, { iteration: [0, 1], durationMs: 1, preview: "inner-0-1" }),
      event("body", "started", 6, { iteration: [1] }),
      event("body", "finished", 7, { iteration: [1], durationMs: 1, preview: "outer-1" }),
    ];
    const state = summarizeRun(events).get("body");

    expect(state?.iterations?.map((entry) => entry.iteration)).toEqual([[0], [0, 0], [0, 1], [1]]);
    expect(state?.iterations?.map((entry) => entry.preview)).toEqual([
      "outer-0",
      "inner-0-0",
      "inner-0-1",
      "outer-1",
    ]);
    expect(state?.iterations?.every((entry) => entry.status === "ok")).toBe(true);
  });

  it("keeps [1, 0] and [10] apart — the key is a path, not a concatenation", () => {
    const state = summarizeRun([
      event("n", "finished", 0, { iteration: [1, 0], preview: "a" }),
      event("n", "finished", 1, { iteration: [10], preview: "b" }),
    ]).get("n");
    expect(state?.iterations).toHaveLength(2);
    expect(state?.iterations?.[1]?.preview).toBe("b");
  });

  it("does not alias the caller's array — a runtime may reuse its index stack", () => {
    const stack = [0];
    const events = [event("n", "started", 0, { iteration: stack })];
    const state = summarizeRun(events).get("n");
    stack[0] = 9;
    expect(state?.iterations?.[0]?.iteration).toEqual([0]);
  });

  it("a node that runs three times: runs, iterations and the unchanged preview all agree", () => {
    const events: RunEvent[] = [];
    for (let i = 0; i < 3; i++) {
      events.push(event("body", "started", i * 10, { iteration: [i] }));
      events.push(
        event("body", "finished", i * 10 + 4, {
          iteration: [i],
          durationMs: 4,
          preview: { item: i },
        }),
      );
    }
    const state = summarizeRun(events).get("body");

    expect(state?.runs).toBe(3);
    expect(state?.iterations).toHaveLength(3);
    expect(state?.totalMs).toBe(12);
    // `preview` keeps its documented meaning: the most recent completed run.
    expect(state?.preview).toEqual({ item: 2 });
    expect(state?.iterations?.[0]?.preview).toEqual({ item: 0 });
  });

  it("records a failed iteration in the middle without losing the ones after it", () => {
    const state = summarizeRun([
      event("body", "started", 0, { iteration: [0] }),
      event("body", "finished", 1, { iteration: [0], durationMs: 1, preview: "ok-0" }),
      event("body", "started", 2, { iteration: [1] }),
      event("body", "failed", 3, { iteration: [1], durationMs: 1, error: { message: "boom" } }),
      event("body", "started", 4, { iteration: [2] }),
      event("body", "finished", 5, { iteration: [2], durationMs: 1, preview: "ok-2" }),
    ]).get("body");

    expect(state?.iterations?.map((entry) => entry.status)).toEqual(["ok", "failed", "ok"]);
    expect(state?.iterations?.[2]?.preview).toBe("ok-2");
    expect(state?.runs).toBe(3);
    // The node-level status is still the fold of every event, unchanged.
    expect(state?.status).toBe("ok");
    expect(state?.error?.message).toBe("boom");
  });

  it("marks an iteration that started and never ended as running", () => {
    const state = summarizeRun([
      event("body", "started", 0, { iteration: [0] }),
      event("body", "finished", 1, { iteration: [0], durationMs: 1 }),
      event("body", "started", 2, { iteration: [1] }),
    ]).get("body");
    expect(state?.iterations?.map((entry) => entry.status)).toEqual(["ok", "running"]);
  });

  it("a skipped pass is skipped, not missing", () => {
    const state = summarizeRun([event("body", "skipped", 0, { iteration: [3] })]).get("body");
    expect(state?.iterations).toEqual([{ iteration: [3], status: "skipped" }]);
  });
});

describe("events without an iteration behave exactly as before", () => {
  it("never invents an iterations array", () => {
    const state = summarizeRun([
      event("a", "started", 0),
      event("a", "finished", 1, { durationMs: 1, preview: { rows: 1 } }),
    ]).get("a");
    expect(state?.iterations).toBeUndefined();
    expect(state).toMatchObject({ runs: 1, status: "ok", durationMs: 1, totalMs: 1 });
  });

  it("regression pass: counts, statuses, previews and totals are untouched", () => {
    const loop: RunEvent[] = [];
    for (let i = 0; i < 5; i++) {
      loop.push(event("body", "started", i * 10));
      loop.push(event("body", "finished", i * 10 + 4, { durationMs: 4, preview: i }));
    }
    expect(summarizeRun(loop).get("body")).toMatchObject({
      runs: 5,
      status: "ok",
      durationMs: 4,
      totalMs: 20,
      preview: 4,
      lastAt: 44,
    });

    expect(summarizeRun([event("a", "started", 0)]).get("a")).toMatchObject({
      status: "running",
      runs: 1,
    });
    expect(summarizeRun([event("a", "skipped", 0)]).get("a")?.status).toBe("skipped");
    expect(summarizeRun([]).get("a")).toBeUndefined();

    const failed = summarizeRun([
      event("a", "started", 0),
      event("a", "failed", 12, { durationMs: 12, error: { message: "boom" } }),
    ]).get("a");
    expect(failed).toMatchObject({ status: "failed", runs: 1 });
    expect(failed?.error?.message).toBe("boom");
  });

  it("mixes numbered and un-numbered events without cross-contamination", () => {
    const state = summarizeRun([
      event("n", "started", 0),
      event("n", "finished", 1, { durationMs: 1, preview: "untracked" }),
      event("n", "started", 2, { iteration: [7] }),
      event("n", "finished", 3, { durationMs: 1, iteration: [7], preview: "seven" }),
    ]).get("n");
    expect(state?.runs).toBe(2);
    expect(state?.iterations).toHaveLength(1);
    expect(state?.iterations?.[0]?.iteration).toEqual([7]);
    expect(state?.preview).toBe("seven");
  });
});

describe("emits — a node saying something mid-step", () => {
  it("folds per node, in order", () => {
    const emits = [
      emit("a", "log", 1, "starting"),
      emit("b", "progress", 2, 0.5),
      emit("a", "artifact", 3, { url: "img://1" }),
    ];
    const state = summarizeRun([event("a", "started", 0)], { emits });

    expect(state.get("a")?.emits?.map((one) => one.kind)).toEqual(["log", "artifact"]);
    expect(state.get("b")?.emits).toHaveLength(1);
  });

  it("an emit does NOT change status or runs — an image arriving is not a step finishing", () => {
    const lifecycle: RunEvent[] = [
      event("a", "started", 0),
      event("a", "finished", 5, { durationMs: 5, preview: "done" }),
    ];
    const bare = summarizeRun(lifecycle).get("a");
    const withEmits = summarizeRun(lifecycle, {
      emits: [emit("a", "artifact", 1, { url: "img://1" }), emit("a", "log", 2, "half way")],
    }).get("a");

    expect(withEmits?.status).toBe(bare?.status);
    expect(withEmits?.runs).toBe(bare?.runs);
    expect(withEmits?.durationMs).toBe(bare?.durationMs);
    expect(withEmits?.totalMs).toBe(bare?.totalMs);
    expect(withEmits?.preview).toBe(bare?.preview);
    // The only difference is the emits themselves.
    expect({ ...withEmits, emits: undefined }).toEqual({ ...bare, emits: undefined });
  });

  it("does not restart a running node, and does not finish one either", () => {
    const running = summarizeRun([event("a", "started", 0)], {
      emits: [emit("a", "progress", 1, 0.1), emit("a", "progress", 2, 0.9)],
    }).get("a");
    expect(running?.status).toBe("running");
    expect(running?.runs).toBe(1);
    expect(running?.emits).toHaveLength(2);
  });

  it("keeps an emit for a node that never had a lifecycle event", () => {
    const state = summarizeRun([], { emits: [emit("ghost", "log", 4, "hello")] });
    const ghost = state.get("ghost");
    expect(ghost).toBeDefined();
    expect(ghost?.emits?.[0]?.payload).toBe("hello");
    // `runs: 0` is how a reader tells "emitted, no lifecycle reported" from
    // "ran once" — core never claims a run it was not told about.
    expect(ghost?.runs).toBe(0);
  });

  it("carries an open, host-defined kind through untouched", () => {
    const state = summarizeRun([], {
      emits: [emit("a", "com.example.thumbnail/v2", 0, { bytes: 12 })],
    });
    expect(state.get("a")?.emits?.[0]?.kind).toBe("com.example.thumbnail/v2");
  });

  it("keeps an emit's own iteration, and does not turn it into an iteration entry", () => {
    const state = summarizeRun([], { emits: [emit("a", "artifact", 0, "img", [2, 1])] });
    expect(state.get("a")?.emits?.[0]?.iteration).toEqual([2, 1]);
    // An emit is not a lifecycle transition, so it cannot claim a pass ran.
    expect(state.get("a")?.iterations).toBeUndefined();
  });

  it("no emits at all leaves the field absent", () => {
    expect(summarizeRun([event("a", "started", 0)]).get("a")?.emits).toBeUndefined();
  });

  it("summarizeTrace folds both halves of a trace", () => {
    const trace: RunTrace = {
      runId: "r1",
      startedAt: 0,
      status: "ok",
      events: [event("a", "started", 0), event("a", "finished", 1, { durationMs: 1 })],
      emits: [emit("a", "log", 0, "hi")],
    };
    const state = summarizeTrace(trace).get("a");
    expect(state?.status).toBe("ok");
    expect(state?.emits).toHaveLength(1);
  });
});

describe("caps are explicit, and never silent", () => {
  it("keeps everything by default", () => {
    const emits = Array.from({ length: 50 }, (_, i) => emit("a", "log", i, i));
    const events = Array.from({ length: 50 }, (_, i) => event("a", "finished", i, { iteration: [i] }));
    const state = summarizeRun(events, { emits }).get("a");
    expect(state?.emits).toHaveLength(50);
    expect(state?.iterations).toHaveLength(50);
    expect(state?.truncated).toBeUndefined();
  });

  it("flags what a cap dropped", () => {
    const emits = Array.from({ length: 5 }, (_, i) => emit("a", "log", i, i));
    const events = Array.from({ length: 5 }, (_, i) => event("a", "finished", i, { iteration: [i] }));
    const state = summarizeRun(events, {
      emits,
      maxEmitsPerNode: 2,
      maxIterationsPerNode: 3,
    }).get("a");
    expect(state?.emits).toHaveLength(2);
    expect(state?.iterations).toHaveLength(3);
    expect(state?.truncated).toEqual({ emits: true, iterations: true });
  });

  it("a cap that is never reached leaves no truncated flag", () => {
    const state = summarizeRun([event("a", "finished", 0, { iteration: [0] })], {
      emits: [emit("a", "log", 0, 1)],
      maxEmitsPerNode: 10,
      maxIterationsPerNode: 10,
    }).get("a");
    expect(state?.truncated).toBeUndefined();
  });

  it("a capped-out iteration still updates the entries it already has", () => {
    const state = summarizeRun(
      [
        event("a", "started", 0, { iteration: [0] }),
        event("a", "started", 1, { iteration: [1] }),
        event("a", "finished", 2, { iteration: [0], durationMs: 2, preview: "kept" }),
      ],
      { maxIterationsPerNode: 1 },
    ).get("a");
    expect(state?.iterations).toEqual([
      { iteration: [0], status: "ok", durationMs: 2, preview: "kept" },
    ]);
    expect(state?.truncated).toEqual({ iterations: true });
  });
});

describe("traceMatches — is this trace about this graph?", () => {
  const base: RunTrace = { runId: "r1", startedAt: 0, status: "ok", events: [] };

  it("current when the identity the analyzer computed comes back unchanged", () => {
    expect(traceMatches({ ...base, ...traceIdentity(graph) }, graph)).toBe("current");
  });

  it("stale when the graph id moved (edited code, or a changed registry)", () => {
    expect(traceMatches({ ...base, graphId: "g_somethingelse" }, graph)).toBe("stale");
  });

  it("stale when the source hash moved", () => {
    expect(traceMatches({ ...base, sourceHash: "deadbeef" }, graph)).toBe("stale");
  });

  it("stale on contradictory evidence — a mismatch outranks a match", () => {
    expect(traceMatches({ ...base, graphId: graph.id, sourceHash: "deadbeef" }, graph)).toBe("stale");
    expect(
      traceMatches({ ...base, graphId: "g_other", sourceHash: graph.source.contentHash }, graph),
    ).toBe("stale");
  });

  it("current from either field on its own — an older runtime may send only one", () => {
    expect(traceMatches({ ...base, graphId: graph.id }, graph)).toBe("current");
    expect(traceMatches({ ...base, sourceHash: graph.source.contentHash }, graph)).toBe("current");
  });

  it("unknown when the trace carries no identity at all — never a guess", () => {
    expect(traceMatches(base, graph)).toBe("unknown");
    expect(traceMatches({}, graph)).toBe("unknown");
  });

  it("unknown when there is nothing to compare against", () => {
    const identified = { ...base, ...traceIdentity(graph) };
    expect(traceMatches(identified, null)).toBe("unknown");
    expect(traceMatches(identified, undefined)).toBe("unknown");
    expect(traceMatches(null, graph)).toBe("unknown");
    expect(traceMatches(undefined, graph)).toBe("unknown");
  });

  it("an edit that keeps node ids stable still reads as stale — that is the bug this closes", () => {
    // I5 keeps ids across a patch on purpose, so identity cannot come from the
    // nodes; it has to come from the graph the run was launched against.
    const edited = analyzeSource(
      canonical.source.replace("await", "await /* touched */"),
      canonical.registry,
      canonical.options,
    );
    const trace = { ...base, ...traceIdentity(graph) };
    expect(traceMatches(trace, edited)).toBe("stale");
    expect(edited.source.contentHash).not.toBe(graph.source.contentHash);
  });
});
