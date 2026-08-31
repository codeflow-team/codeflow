/**
 * What a step produced — the half of a run the editor could not show.
 *
 * A run used to have a value for exactly two kinds of step: a call to an MCP
 * tool, and an element of a `Promise.all`. Everything else — every library
 * function, every decision, the loop item itself — reported "this pass reported
 * no value", because the closing marker `__cf.f("n7")` was inserted *after* the
 * statement and had no way to see what the statement made. On a flow built out
 * of the twelve everyday library functions that is almost every node.
 *
 * The fix is to hand the marker the binding, which is in scope at exactly that
 * point (`__cf.f("n7", rows)`), and to hand the loop's pass marker the item
 * (`__cf.pass("n12", ticket)`). These tests pin what that makes true, and what
 * it must still refuse to pretend:
 *
 *  - a declared binding is recorded, per pass, addressable by `iteration`;
 *  - a destructuring statement records every name it bound;
 *  - the loop item is recorded per pass, with that pass's item;
 *  - an **un-awaited promise** is not recorded as a promise object — the run
 *    says it did not look, rather than sending `{}`;
 *  - the shapes that cannot work are skipped *and named*, so a UI can say "this
 *    step declares nothing to show" instead of leaving "no value" to mean both
 *    that and "it produced nothing";
 *  - a tool's provenance envelope survives on the step that binds its answer.
 *
 * `instrument.test.ts` owns the other half of the claim — that none of this
 * changed what the program does — and its behaviour cases cover the new markers
 * in every loop shape.
 */

import { describe, expect, it } from "vitest";
import { summarizeRun, type RunEvent } from "@codeflow-team/core";

import { instrument } from "../server/instrument.ts";
import { createProbe, UNAWAITED_BINDING } from "../server/probe.ts";
import { preview } from "../server/sample.ts";
import { execute, graphFor, instrumentFor, nodeIdOf, rangesFor } from "./harness.ts";

/** Previews for one node, in the order the run reported them. */
function previewsOf(events: readonly RunEvent[], nodeId: string): unknown[] {
  return events.filter((event) => event.nodeId === nodeId && event.preview !== undefined).map((event) => event.preview);
}

/** `iteration` → preview, as `summarizeRun` folds it for an item selector. */
function byIteration(events: readonly RunEvent[], nodeId: string): { iteration: number[]; preview: unknown }[] {
  return (summarizeRun(events).get(nodeId)?.iterations ?? []).map((entry) => ({
    iteration: entry.iteration,
    preview: entry.preview,
  }));
}

/* -------------------------------------------------------------------------- */
/* a step that declares a binding                                              */
/* -------------------------------------------------------------------------- */

const STRAIGHT_LINE = `
function shorten(list: number[]) {
  return list.slice(0, 2);
}

export default async function flow(input: {}, tools: any) {
  const rows = [1, 2, 3, 4];
  const short = shorten(rows);
  const { head, size } = { head: short[0], size: short.length };
  const pending = tools.slow.load({});
  const settled = await pending;
  return { short, head, size, settled };
}
`;

describe("a step's declared binding is its value", () => {
  it("records what a library-function step produced, and it reaches NodeRunState.preview", async () => {
    const graph = graphFor(STRAIGHT_LINE);
    const step = nodeIdOf(graph, "function", 0); // `const short = shorten(rows);`
    const { events } = await execute(instrumentFor(STRAIGHT_LINE).code, {});

    expect(previewsOf(events, step)).toEqual([[1, 2]]);
    expect(summarizeRun(events).get(step)?.preview).toEqual([1, 2]);
  });

  it("hands the marker the binding rather than wrapping the expression", () => {
    const built = instrumentFor(STRAIGHT_LINE);
    // The whole mechanism, visible in one line: an extra *argument* on a call
    // that was already there. No thunk, no `await`, no reordering.
    expect(built.code).toMatch(/const short = shorten\(rows\);__cf\.f\("[^"]+", short\);/);
  });

  it("records every name a destructuring declaration bound", async () => {
    const graph = graphFor(STRAIGHT_LINE);
    const built = instrumentFor(STRAIGHT_LINE);
    // The honest reconstruction of what the statement bound: the names, and
    // nothing about whatever else was on the right-hand side.
    expect(built.code).toMatch(/__cf\.f\("[^"]+", \{ head, size \}\);/);

    // `const { head, size } = …` — the code node after the `function` one.
    const destructuring = nodeIdOf(graph, "code", 1);
    const { events } = await execute(built.code, {});
    expect(previewsOf(events, destructuring)).toEqual([{ head: 1, size: 2 }]);
  });

  it("reads a binding that was awaited, because by the closing marker it is settled", async () => {
    const graph = graphFor(STRAIGHT_LINE);
    // `const settled = await pending;`
    const awaited = nodeIdOf(graph, "code", 2);
    const { events } = await execute(instrumentFor(STRAIGHT_LINE).code, {});
    expect(previewsOf(events, awaited)).toEqual([{ ok: true, of: "slow.load" }]);
  });
});

/* -------------------------------------------------------------------------- */
/* a promise nobody awaited                                                    */
/* -------------------------------------------------------------------------- */

describe("a binding holding a promise the statement did not await", () => {
  it("is not recorded as a promise object, and says that it was not", async () => {
    const graph = graphFor(STRAIGHT_LINE);
    // `const pending = tools.slow.load({});` — no `await`, so at the closing
    // marker the binding is a pending promise.
    const unawaited = nodeIdOf(graph, "unknown", 0);
    const { events } = await execute(instrumentFor(STRAIGHT_LINE).code, {});

    const recorded = previewsOf(events, unawaited);
    expect(recorded).toEqual([UNAWAITED_BINDING]);
    // The two wrong answers, ruled out explicitly: `{}` is what
    // `JSON.stringify` makes of a promise, and awaiting it would have moved the
    // program the probe exists to watch.
    expect(recorded[0]).not.toEqual({});
    expect(String((UNAWAITED_BINDING as { note: string }).note)).toContain("did not await");
  });

  it("treats a loop item that is a promise the same way", async () => {
    const source = `
export default async function flow(input: {}, tools: any) {
  const seen: any[] = [];
  for (const item of [Promise.resolve(1), Promise.resolve(2)]) {
    seen.push(item);
  }
  return seen.length;
}
`;
    const graph = graphFor(source);
    const loop = nodeIdOf(graph, "loop", 0);
    const { events } = await execute(instrumentFor(source).code, {});
    expect(previewsOf(events, loop)).toEqual([UNAWAITED_BINDING, UNAWAITED_BINDING]);
  });
});

/* -------------------------------------------------------------------------- */
/* one value per pass                                                          */
/* -------------------------------------------------------------------------- */

const LOOP = `
export default async function flow(input: {}, tools: any) {
  const totals: number[] = [];
  for (const item of [10, 20, 30]) {
    const doubled = item * 2;
    totals.push(doubled);
  }
  return totals;
}
`;

describe("inside a loop, every pass records its own value", () => {
  it("gives the step in the body one value per pass, addressable by iteration", async () => {
    const graph = graphFor(LOOP);
    const body = nodeIdOf(graph, "code", 1); // `const doubled = …; totals.push(…)`
    const { events } = await execute(instrumentFor(LOOP).code, {});

    expect(byIteration(events, body)).toEqual([
      { iteration: [0], preview: 20 },
      { iteration: [1], preview: 40 },
      { iteration: [2], preview: 60 },
    ]);
  });

  it("records the loop's own item per pass, with that pass's item", async () => {
    const graph = graphFor(LOOP);
    const loop = nodeIdOf(graph, "loop", 0);
    const built = instrumentFor(LOOP);
    expect(built.code).toMatch(/\{__cf\.pass\("[^"]+", item\);/);

    const { events } = await execute(built.code, {});
    expect(byIteration(events, loop)).toEqual([
      { iteration: [0], preview: 10 },
      { iteration: [1], preview: 20 },
      { iteration: [2], preview: 30 },
    ]);
  });

  it("reassembles a destructured loop item into the names the loop bound", async () => {
    const source = `
export default async function flow(input: {}, tools: any) {
  const seen: string[] = [];
  for (const { id, body } of [{ id: "a", body: "one", extra: 1 }, { id: "b", body: "two", extra: 2 }]) {
    seen.push(id + body);
  }
  return seen;
}
`;
    const graph = graphFor(source);
    const loop = nodeIdOf(graph, "loop", 0);
    const built = instrumentFor(source);
    expect(built.code).toMatch(/\{__cf\.pass\("[^"]+", \{ id, body \}\);/);

    const { events } = await execute(built.code, {});
    // `extra` is deliberately absent: the loop bound `id` and `body`, and that
    // is what the reconstruction claims — not the whole item it never named.
    expect(byIteration(events, loop)).toEqual([
      { iteration: [0], preview: { id: "a", body: "one" } },
      { iteration: [1], preview: { id: "b", body: "two" } },
    ]);
  });

  it("reads the counter of a classic `for`, which is the same fact about a pass", async () => {
    // The tool call keeps the declaration and the loop in separate nodes: a
    // code node spans a *run* of statements, and one covering both would have
    // no loop of its own to count.
    const source = `
export default async function flow(input: {}, tools: any) {
  const seen: number[] = [];
  await tools.setup.begin({});
  for (let i = 0; i < 3; i++) {
    seen.push(i);
  }
  return seen;
}
`;
    const built = instrumentFor(source);
    expect(built.code).toMatch(/\{__cf\.pass\("[^"]+", i\);/);
    const graph = graphFor(source);
    // The analyzer models a classic `for` as a code node; the instrumenter
    // counts it by syntax anyway, so its passes still carry a value.
    const loop = nodeIdOf(graph, "code", 1);
    const { events } = await execute(built.code, {});
    expect(byIteration(events, loop)).toEqual([
      { iteration: [0], preview: 0 },
      { iteration: [1], preview: 1 },
      { iteration: [2], preview: 2 },
    ]);
  });

  it("leaves a loop that names no item exactly as it was", async () => {
    const source = `
export default async function flow(input: {}, tools: any) {
  let n = 0;
  while (n < 3) {
    n = n + 1;
  }
  return n;
}
`;
    const built = instrumentFor(source);
    // A `while` binds nothing, so its pass marker takes no second argument and
    // its event stream is what it was before items existed.
    expect(built.code).toContain(".pass(");
    expect(built.code).not.toMatch(/\.pass\("[^"]+", /);

    const graph = graphFor(source);
    const loop = nodeIdOf(graph, "loop", 0);
    const { events } = await execute(built.code, {});
    expect(events.filter((event) => event.nodeId === loop).length).toBe(2);
    expect(built.unvalued.find((entry) => entry.nodeId === loop)?.reason).toBe("no-binding");
  });
});

/* -------------------------------------------------------------------------- */
/* the shapes that record nothing, and say so                                  */
/* -------------------------------------------------------------------------- */

const SKIPPABLE = `
export default async function flow(input: { go: boolean }, tools: any) {
  var legacy = 1;
  await tools.log.write({ legacy });
  const kept = 2;
  if (input.go) {
    await tools.alert.send({ kept });
  }
  return kept;
}
`;

describe("what cannot be recorded is named, not left silent", () => {
  it("puts every range on exactly one of valued / unvalued", () => {
    for (const source of [STRAIGHT_LINE, LOOP, SKIPPABLE]) {
      const ranges = rangesFor(source);
      const built = instrument(source, ranges);
      const accounted = [...built.valued, ...built.unvalued.map((entry) => entry.nodeId)];
      expect(new Set(accounted).size).toBe(ranges.length);
      expect(accounted.length).toBe(ranges.length);
    }
  });

  it("refuses a `var`, a tool call with no binding, a decision and a `return` — each for its own reason", () => {
    const graph = graphFor(SKIPPABLE);
    const built = instrument(SKIPPABLE, rangesFor(SKIPPABLE));
    const reasonOf = (nodeId: string): string | undefined =>
      built.unvalued.find((entry) => entry.nodeId === nodeId)?.reason;

    // `var legacy = 1;` — the binding outlives the step, so a value shown
    // against the step would claim ownership the language does not give it.
    expect(reasonOf(nodeIdOf(graph, "code", 0))).toBe("var-declaration");
    // `await tools.log.write({ legacy });` — declares nothing. The tools proxy
    // in `worker.ts` reports this one from the other side.
    expect(reasonOf(nodeIdOf(graph, "unknown", 0))).toBe("no-binding");
    // `if (input.go)` — its value is its test, and reading that would mean
    // evaluating the expression a second time.
    expect(reasonOf(nodeIdOf(graph, "condition", 0))).toBe("would-re-evaluate");
    // `return kept;` — both of its markers run in front of it.
    expect(reasonOf(nodeIdOf(graph, "output", 0))).toBe("no-binding");
    // …and the one statement that does declare something is on the other list.
    expect(built.valued).toContain(nodeIdOf(graph, "code", 1));
  });

  it("says `not-probed` for a step that has no marker at all", () => {
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

    expect(built.skipped[0]?.reason).toBe("labelled-statement");
    expect(built.unvalued).toEqual([
      { nodeId: "hypothetical", reason: "not-probed", detail: expect.any(String) as unknown as string },
    ]);
  });

  it("tells `recorded, and it was undefined` from `nothing was recorded`", async () => {
    const source = `
function nothing() {
  return undefined;
}

export default async function flow(input: {}, tools: any) {
  const value = nothing();
  await tools.log.write({});
  return value;
}
`;
    const graph = graphFor(source);
    const built = instrumentFor(source);
    const declaring = nodeIdOf(graph, "function", 0); // `const value = nothing();`
    const callOnly = nodeIdOf(graph, "unknown", 0); // `await tools.log.write({});`

    const { events } = await execute(built.code, {});
    const folded = summarizeRun(events);

    // Both nodes have `preview: undefined`. The difference is on the plan: one
    // was asked for its value and answered `undefined`, the other was never in
    // a position to answer at all.
    expect(folded.get(declaring)?.preview).toBeUndefined();
    expect(folded.get(callOnly)?.preview).toBeUndefined();
    expect(built.valued).toContain(declaring);
    expect(built.unvalued.map((entry) => entry.nodeId)).toContain(callOnly);
  });
});

/* -------------------------------------------------------------------------- */
/* what showing a value costs                                                  */
/* -------------------------------------------------------------------------- */

describe("shortening a value for display is the one place a probe is not free", () => {
  it("reads the value's properties exactly once, and the marker itself reads none", () => {
    const events: RunEvent[] = [];
    let reads = 0;
    const box = {
      plain: 1,
      get peek(): string {
        reads += 1;
        return "looked";
      },
    };

    // The marker takes the name; it never touches a property.
    const bare = createProbe((event) => events.push(event), { now: () => 0, preview: (value) => value });
    bare.s("n1");
    bare.f("n1", box);
    expect(reads).toBe(0);

    // Shortening does — `preview` serialises, and serialising an object runs
    // its getters. That was already true of every tool result and of every
    // `Promise.all` element; recording bindings widens it to any value a step
    // declares, and it is the honest price of showing one at all. It is paid
    // once per recorded value, not once per read of the run.
    const shortening = createProbe((event) => events.push(event), { now: () => 0, preview });
    shortening.s("n2");
    shortening.f("n2", box);
    expect(reads).toBe(1);
    expect(events.at(-1)?.preview).toEqual({ plain: 1, peek: "looked" });
  });
});

/* -------------------------------------------------------------------------- */
/* provenance                                                                  */
/* -------------------------------------------------------------------------- */

describe("a tool's provenance survives the binding that holds its answer", () => {
  const probeFor = (events: RunEvent[]) =>
    createProbe((event) => events.push(event), { now: () => 0, preview: (value) => value });

  it("keeps the `{ tool, source, value }` envelope when the binding is the tool's own answer", () => {
    const events: RunEvent[] = [];
    const probe = probeFor(events);
    const answer = { content: "hello" };

    probe.s("n1");
    const frame = probe.current();
    // Exactly what `worker.ts`'s tools proxy does on a live MCP call.
    if (frame !== undefined) {
      frame.preview = { tool: "fs.readTextFile", source: "mcp", value: answer };
      frame.toolValue = answer;
      frame.hasToolValue = true;
    }
    probe.f("n1", answer);

    // `const file = await tools.fs.readTextFile(…)` binds that very object, so
    // replacing the envelope with its contents would only lose the badge that
    // says the value came from a live server rather than from a stub.
    expect(events.at(-1)?.preview).toEqual({ tool: "fs.readTextFile", source: "mcp", value: answer });
  });

  it("lets the binding win when it is not what the tool returned", () => {
    const events: RunEvent[] = [];
    const probe = probeFor(events);
    const answer = { content: "hello" };

    probe.s("n1");
    const frame = probe.current();
    if (frame !== undefined) {
      frame.preview = { tool: "fs.readTextFile", source: "mcp", value: answer };
      frame.toolValue = answer;
      frame.hasToolValue = true;
    }
    // `const words = count(await tools.fs.readTextFile(…))` — the tool's answer
    // was an ingredient, not the outcome, and attributing the outcome to the
    // tool would be naming a producer that did not produce it.
    probe.f("n1", 5);

    expect(events.at(-1)?.preview).toBe(5);
  });
});
