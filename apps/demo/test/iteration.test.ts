/**
 * Which pass of which loop an event belongs to — and when the honest answer is
 * to say nothing at all.
 *
 * `RunEvent.iteration` is what lets a node card offer "item 3 of 5" instead of
 * only ever the latest value. Its docblock in core is blunt about the failure
 * mode: a runtime that cannot count **omits** the field, and must never send
 * `[0]` as a stand-in, because `[0]` means "the first item" and a UI is
 * entitled to believe it.
 *
 * So these tests are in two halves. The first checks the numbers are right
 * where they can be known. The second checks that where they cannot — inside a
 * `Promise.all`, inside a loop whose body the marker could not reach — the
 * field is *absent*, and that numbering resumes afterwards rather than staying
 * broken. The second half is the one that matters: a wrong number is worse than
 * no number, because nothing on screen distinguishes it from a right one.
 *
 * Everything runs the real instrumenter against the real probe (see
 * `harness.ts`); nothing here mocks the marker protocol it is checking.
 */

import { describe, expect, it } from "vitest";
import { summarizeRun } from "@codeflow/core";

import { instrument } from "../server/instrument.ts";
import { execute, graphFor, instrumentFor, iterationsOf, nodeIdOf, rangesFor } from "./harness.ts";

/* -------------------------------------------------------------------------- */
/* where the number is knowable                                                */
/* -------------------------------------------------------------------------- */

const NESTED = `
export default async function flow(input: {}, tools: any) {
  const out: string[] = [];
  for (const a of ["x", "y"]) {
    for (const b of [1, 2]) {
      const r = await tools.pair.make({ a, b });
      out.push(a + b + r.ok);
    }
  }
  return out;
}
`;

describe("iteration numbering", () => {
  it("stamps nested loops with the whole stack, outermost first", async () => {
    const graph = graphFor(NESTED);
    const outer = nodeIdOf(graph, "loop", 0);
    const inner = nodeIdOf(graph, "loop", 1);
    const call = nodeIdOf(graph, "unknown", 0);

    const { events } = await execute(instrumentFor(NESTED).code, {});

    // The outer loop is outside every loop, so it has no iteration of its own —
    // absent, not `[]`, and certainly not `[0]`.
    expect(iterationsOf(events, outer)).toEqual([
      { phase: "started", iteration: null },
      { phase: "finished", iteration: null },
    ]);

    // The inner loop belongs to a pass of the outer one. Both ends of one
    // occurrence carry the same number: the frame's iteration is captured when
    // it opens, so a loop's `finished` belongs to its parent's pass rather than
    // to its own last pass.
    expect(iterationsOf(events, inner)).toEqual([
      { phase: "started", iteration: [0] },
      { phase: "finished", iteration: [0] },
      { phase: "started", iteration: [1] },
      { phase: "finished", iteration: [1] },
    ]);

    expect(iterationsOf(events, call).map((entry) => entry.iteration)).toEqual([
      [0, 0], [0, 0],
      [0, 1], [0, 1],
      [1, 0], [1, 0],
      [1, 1], [1, 1],
    ]);
  });

  it("gives the node one folded entry per pass, in observation order", async () => {
    const graph = graphFor(NESTED);
    const call = nodeIdOf(graph, "unknown", 0);
    const { events } = await execute(instrumentFor(NESTED).code, {});

    const state = summarizeRun(events).get(call);
    expect(state?.runs).toBe(4);
    expect(state?.iterations?.map((entry) => entry.iteration)).toEqual([[0, 0], [0, 1], [1, 0], [1, 1]]);
    expect(state?.iterations?.every((entry) => entry.status === "ok")).toBe(true);
  });

  it("counts a `while` loop's passes too", async () => {
    const source = `
export default async function flow(input: {}, tools: any) {
  let n = 0;
  while (n < 3) {
    await tools.tick.next({ n });
    n = n + 1;
  }
  return n;
}
`;
    const graph = graphFor(source);
    const { events } = await execute(instrumentFor(source).code, {});
    expect(
      iterationsOf(events, nodeIdOf(graph, "unknown", 0))
        .filter((entry) => entry.phase === "started")
        .map((entry) => entry.iteration),
    ).toEqual([[0], [1], [2]]);
  });

  it("counts an unbraced loop body, which it has to wrap to reach", async () => {
    const source = `
export default async function flow(input: {}, tools: any) {
  const seen: number[] = [];
  for (const item of [1, 2, 3]) seen.push(item);
  return seen;
}
`;
    const built = instrumentFor(source);
    // Two wraps around one statement — the loop's, then the step's — and the
    // behaviour case in `instrument.test.ts` proves the program is unchanged.
    expect(built.code).toContain(".pass(");
    expect(built.blind).toBe(false);

    const graph = graphFor(source);
    const { events } = await execute(built.code, {});
    // `seen.push(item)` — the body, and the second code node in the file.
    const body = iterationsOf(events, nodeIdOf(graph, "code", 1));
    expect(body.filter((entry) => entry.phase === "started").map((entry) => entry.iteration)).toEqual([
      [0],
      [1],
      [2],
    ]);
  });

  it("counts a labelled loop by reaching into the loop the label carries", async () => {
    const source = `
export default async function flow(input: {}, tools: any) {
  const pairs: string[] = [];
  outer: for (const a of [1, 2, 3]) {
    for (const b of [1, 2, 3]) {
      if (b === 2) continue outer;
      pairs.push(a + ":" + b);
    }
  }
  return pairs;
}
`;
    const built = instrumentFor(source);
    expect(built.blind).toBe(false);
    // The label itself is untouched: `continue outer` still has a target.
    expect(built.code).toContain("outer: for");
    expect(built.counted.length).toBe(2);

    const graph = graphFor(source);
    const { events } = await execute(built.code, {});
    const inner = iterationsOf(events, nodeIdOf(graph, "loop", 1));
    expect(inner.filter((entry) => entry.phase === "started").map((entry) => entry.iteration)).toEqual([
      [0],
      [1],
      [2],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* where it is not — and is therefore left out                                 */
/* -------------------------------------------------------------------------- */

const PARALLEL_IN_LOOP = `
export default async function flow(input: {}, tools: any) {
  const out: any[] = [];
  for (const region of ["east", "west"]) {
    const [a, b] = await Promise.all([
      tools.first.load({ region }),
      tools.second.load({ region })
    ]);
    out.push(await tools.report.write({ a, b }));
  }
  return out;
}
`;

describe("iteration numbering omits rather than guesses", () => {
  it("sends no iteration while a Promise.all is in flight, and numbers again after it", async () => {
    const graph = graphFor(PARALLEL_IN_LOOP);
    const parallel = nodeIdOf(graph, "parallel", 0);
    const built = instrumentFor(PARALLEL_IN_LOOP);

    // The declaration rides beside the parallel's opening marker, so it can
    // never be separated from the step it qualifies.
    expect(built.code).toContain(`.unknown(${JSON.stringify(parallel)})`);
    expect(built.uncounted).toEqual([parallel]);

    const { events } = await execute(built.code, {});

    // The `Promise.all` statement itself sits in a pass and says so: it is one
    // step of the loop body like any other.
    expect(iterationsOf(events, parallel)).toEqual([
      { phase: "started", iteration: [0] },
      { phase: "finished", iteration: [0] },
      { phase: "started", iteration: [1] },
      { phase: "finished", iteration: [1] },
    ]);

    // Its branches do not. Two of them interleave, and a single counter stack
    // would hand one branch's event whatever number the other left behind —
    // an item index the run never established. Omitted is the correct answer;
    // the UI's half of the contract is to say "latest" rather than "item 1".
    for (const index of [0, 1]) {
      const branch = nodeIdOf(graph, "unknown", index);
      expect(iterationsOf(events, branch).every((entry) => entry.iteration === null)).toBe(true);
    }

    // …and the step after the parallel is numbered again: suppression lasts
    // exactly as long as the interleaving does.
    const after = nodeIdOf(graph, "code", 1);
    expect(iterationsOf(events, after).map((entry) => entry.iteration)).toEqual([[0], [0], [1], [1]]);
  });

  it("declares a loop body it cannot wrap, instead of silently mis-stacking it", async () => {
    // A `var` used as a loop body binds in the enclosing scope; a block around
    // it would move the binding, so the marker is refused — and the refusal is
    // announced, scoped to that loop.
    const source = `
export default async function flow(input: {}, tools: any) {
  let last = 0;
  for (const item of [1, 2, 3]) var seen = item;
  await tools.report.write({ seen, last });
  return seen;
}
`;
    const built = instrumentFor(source);
    const loop = nodeIdOf(graphFor(source), "loop", 0);
    expect(built.uncounted).toContain(loop);
    expect(built.counted).not.toContain(loop);
    expect(built.blind).toBe(false);
    expect(built.code).toContain(`.unknown(${JSON.stringify(loop)})`);

    const { events } = await execute(built.code, {});
    // Nothing inside carried a number; the step after the loop is outside every
    // countable loop and carries none either.
    expect(events.every((event) => event.iteration === undefined)).toBe(true);
  });

  it("blinds the whole run when a loop got no marker at all", () => {
    // A caller naming the loop rather than the labelled statement wrapping it:
    // the probe is refused (wrapping would break `continue outer`), which
    // leaves nothing at runtime to hang a scoped `unknown` on. A stack missing
    // a level reads as a *different* stack, so the conservative answer is that
    // this run numbers nothing.
    const source = `
export default async function flow(input: {}, tools: any) {
  outer: for (const a of [1, 2]) {
    await tools.step.run({ a });
  }
  return 1;
}
`;
    const loopStart = source.indexOf("for (const a");
    const loopEnd = source.indexOf("}\n  return 1") + 1;
    const built = instrument(source, [{ nodeId: "hypothetical", start: loopStart, end: loopEnd, type: "loop" }]);

    expect(built.probed).toEqual([]);
    expect(built.skipped[0]?.reason).toBe("labelled-statement");
    expect(built.blind).toBe(true);
    expect(built.code).toContain("__cf.unknown();");
    expect(built.code.split("\n").length).toBe(source.split("\n").length);
  });

  it("puts the blind marker in front of a first line that is itself being rewritten", () => {
    // Both edits land on offset 0 — the import is blanked in place, and the
    // marker goes before what is left of it. Applied the other way round the
    // blanking would erase the marker, and the run would number things it
    // cannot count.
    const source = `import type { Tools } from "../generated/tools";
export default async function flow(input: {}, tools: Tools) {
  outer: for (const a of [1, 2]) {
    await tools.step.run({ a });
  }
  return 1;
}
`;
    const loopStart = source.indexOf("for (const a");
    const loopEnd = source.indexOf("}\n  return 1") + 1;
    const built = instrument(source, [{ nodeId: "hypothetical", start: loopStart, end: loopEnd, type: "loop" }]);

    expect(built.blind).toBe(true);
    expect(built.droppedImports).toEqual(["../generated/tools"]);
    expect(built.code.startsWith("__cf.unknown();")).toBe(true);
    expect(built.code).not.toContain("import type");
    expect(built.code.split("\n").length).toBe(source.split("\n").length);
  });

  it("says nothing about iteration in a flow that has no loops", async () => {
    const source = `
export default async function flow(input: {}, tools: any) {
  const first = await tools.a.run({});
  const second = await tools.b.run({ first });
  return { first, second };
}
`;
    const built = instrumentFor(source);
    expect(built.counted).toEqual([]);
    expect(built.uncounted).toEqual([]);
    expect(built.blind).toBe(false);
    expect(built.code).not.toContain(".pass(");
    expect(built.code).not.toContain(".unknown(");

    const { events } = await execute(built.code, {});
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.iteration === undefined)).toBe(true);

    // …and the fold is exactly what it was before iterations existed: no node
    // grows an `iterations` list out of events that never carried one.
    for (const state of summarizeRun(events).values()) {
      expect(state.iterations).toBeUndefined();
    }
  });

  it("leaves every published example either counted or explicitly uncounted", () => {
    // Nothing may be silently mis-stacked: a loop is on one list or the other,
    // or the whole run is blind and says so.
    const source = PARALLEL_IN_LOOP;
    const ranges = rangesFor(source);
    const built = instrument(source, ranges);
    const loops = ranges.filter((range) => range.type === "loop").map((range) => range.nodeId);
    for (const loop of loops) {
      expect(built.blind || built.counted.includes(loop) || built.uncounted.includes(loop)).toBe(true);
    }
  });
});
