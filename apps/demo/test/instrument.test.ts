/**
 * The instrumenter must not change what the program does. Full stop.
 *
 * This is the test that earns the feature the right to exist. Everything else
 * about a run — the SSE frames, the badges, the pulsing node — is decoration on
 * top of one claim: *what you watched is what your code does*. If inserting
 * markers can alter behaviour, the picture is a lie, and a convincing one.
 *
 * So the method here is not "assert the output text looks right". It is: run
 * the original, run the instrumented copy, and require that they produced the
 * same effects in the same order and returned the same value. The cases are
 * chosen from the shapes that actually break naive instrumentation, led by the
 * one this codebase has already been bitten by from the other direction — the
 * unbraced body:
 *
 *     if (pr.draft) continue;
 *
 * Insert a marker before that `continue` without a block and the `if` starts
 * guarding the marker instead of the jump. Same parse, same types, different
 * program.
 */

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { analyzeSource, createRegistry, nodeRanges } from "@codeflow/core";
import { EXAMPLES, registryFor } from "@codeflow/examples";

import { instrument } from "../server/instrument.ts";
import { execute, rangesFor, type Outcome } from "./harness.ts";

/**
 * Instrument `source`, run both copies, and require them to agree.
 *
 * `@flows/lib` is never imported by these cases, so nothing is rewritten; the
 * `import type` line is blanked exactly as it is at runtime.
 */
async function expectSameBehaviour(source: string, input: unknown = {}): Promise<Outcome> {
  const ranges = rangesFor(source);
  expect(ranges.length, "the analyzer found no nodes to probe").toBeGreaterThan(0);
  const instrumented = instrument(source, ranges);

  const before = await execute(source, input);
  const after = await execute(instrumented.code, input);

  expect(after.error, `instrumented copy threw: ${String(after.error)}`).toEqual(before.error);
  expect(after.effects).toEqual(before.effects);
  expect(after.result).toEqual(before.result);
  expect(after.probes.length, "nothing was probed at all").toBeGreaterThan(0);
  return after;
}

/* -------------------------------------------------------------------------- */
/* the shapes that break naive instrumentation                                 */
/* -------------------------------------------------------------------------- */

const CASES: { name: string; source: string; input?: unknown }[] = [
  {
    name: "unbraced `if` body holding a `continue` — the shape that has bitten this repo",
    source: `
export default async function flow(input: { n: number }, tools: any) {
  const seen: number[] = [];
  for (const item of [1, 2, 3, 4]) {
    if (item % 2 === 0) continue;
    seen.push(item);
    await tools.log.write({ item });
  }
  return seen;
}
`,
  },
  {
    name: "unbraced `if` body holding a `break`",
    source: `
export default async function flow(input: {}, tools: any) {
  const seen: number[] = [];
  for (const item of [1, 2, 3]) {
    if (item === 2) break;
    seen.push(item);
  }
  return seen;
}
`,
  },
  {
    name: "unbraced `if` body holding a `return`",
    source: `
export default async function flow(input: { skip: boolean }, tools: any) {
  if (input.skip) return "skipped";
  await tools.work.run({});
  return "done";
}
`,
    input: { skip: true },
  },
  {
    name: "else-if chain — the `else` also has no braces",
    source: `
export default async function flow(input: { kind: string }, tools: any) {
  if (input.kind === "a") {
    await tools.a.run({});
  } else if (input.kind === "b") {
    await tools.b.run({});
  } else {
    await tools.c.run({});
  }
  return input.kind;
}
`,
    input: { kind: "b" },
  },
  {
    name: "labelled loops with `continue label`",
    source: `
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
`,
  },
  {
    name: "unbraced `for` body",
    source: `
export default async function flow(input: {}, tools: any) {
  const seen: number[] = [];
  for (const item of [1, 2, 3]) seen.push(item);
  return seen;
}
`,
  },
  {
    name: "unbraced `while` body",
    source: `
export default async function flow(input: {}, tools: any) {
  let n = 0;
  while (n < 3) n = n + 1;
  return n;
}
`,
  },
  {
    name: "try / catch / finally with an early return in the try",
    source: `
export default async function flow(input: { fail: boolean }, tools: any) {
  const trail: string[] = [];
  try {
    trail.push("try");
    if (input.fail) throw new Error("boom");
    return trail;
  } catch (err) {
    trail.push("catch");
    await tools.alert.send({ message: String(err) });
  } finally {
    trail.push("finally");
  }
  return trail;
}
`,
    input: { fail: true },
  },
  {
    name: "an error that escapes the flow entirely",
    source: `
export default async function flow(input: {}, tools: any) {
  await tools.first.step({});
  throw new Error("escaped");
}
`,
  },
  {
    name: "nested loops with a tool call in the innermost body",
    source: `
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
`,
  },
  {
    name: "declarations whose bindings must stay in the enclosing block",
    source: `
export default async function flow(input: {}, tools: any) {
  const first = await tools.a.run({});
  let count = 0;
  count = count + 1;
  const second = await tools.b.run({ first, count });
  return { first, second, count };
}
`,
  },
  {
    name: "Promise.all — the steps are expressions in an array, not statements",
    source: `
export default async function flow(input: {}, tools: any) {
  const [a, b, c] = await Promise.all([
    tools.first.load({ n: 1 }),
    tools.second.load({ n: 2 }),
    tools.third.load({ n: 3 })
  ]);
  return [a.of, b.of, c.of];
}
`,
  },
  {
    name: "Promise.all where one element rejects",
    source: `
export default async function flow(input: {}, tools: any) {
  try {
    const [a, b] = await Promise.all([
      tools.ok.load({}),
      tools.bad.explode({})
    ]);
    return [a, b];
  } catch (err) {
    await tools.alert.send({ message: String(err) });
    return "recovered";
  }
}
`,
  },
  {
    // The pass marker has to reach inside a body that has no braces, by the
    // same wrap the step markers use — two nested wraps around one statement.
    name: "unbraced `for` body that also has to carry a loop pass marker",
    source: `
export default async function flow(input: {}, tools: any) {
  const seen: number[] = [];
  for (const item of [1, 2, 3]) seen.push(item * 2);
  return seen;
}
`,
  },
  {
    // A `var` used as a body binds in the enclosing scope, so no block may
    // appear around it — neither for the step marker nor for the pass marker.
    name: "`var` as a loop body, which no wrap may touch",
    source: `
export default async function flow(input: {}, tools: any) {
  for (const item of [1, 2, 3]) var seen = item;
  await tools.report.write({ seen });
  return seen;
}
`,
  },
  {
    name: "`do…while` with an unbraced body",
    source: `
export default async function flow(input: {}, tools: any) {
  let n = 0;
  do n = n + 1; while (n < 3);
  return n;
}
`,
  },
  {
    name: "`for await…of` over an async iterable",
    source: `
export default async function flow(input: {}, tools: any) {
  async function* pages() { yield 1; yield 2; }
  const seen: number[] = [];
  for await (const page of pages()) {
    const r = await tools.page.load({ page });
    seen.push(page);
  }
  return seen;
}
`,
  },
  {
    name: "a `Promise.all` inside a loop body",
    source: `
export default async function flow(input: {}, tools: any) {
  const out: any[] = [];
  for (const region of ["east", "west"]) {
    const [a, b] = await Promise.all([
      tools.first.load({ region }),
      tools.second.load({ region })
    ]);
    out.push(a.of + b.of + region);
  }
  return out;
}
`,
  },
  {
    name: "switch with fallthrough",
    source: `
export default async function flow(input: { kind: string }, tools: any) {
  const trail: string[] = [];
  switch (input.kind) {
    case "a":
      trail.push("a");
    case "b":
      trail.push("b");
      break;
    default:
      trail.push("other");
  }
  return trail;
}
`,
    input: { kind: "a" },
  },
];

describe("instrument() preserves behaviour", () => {
  for (const runCase of CASES) {
    it(runCase.name, async () => {
      await expectSameBehaviour(runCase.source, runCase.input ?? {});
    });
  }

  it("wraps rather than skips the unbraced `continue`, and says which node it probed", () => {
    const source = CASES[0].source;
    const ranges = rangesFor(source);
    const result = instrument(source, ranges);
    expect(result.code).toContain("if (item % 2 === 0) {__cf.s(");
    expect(result.skipped).toEqual([]);
  });

  it("probes a labelled loop by wrapping the label, not the loop inside it", () => {
    const source = CASES[4].source;
    const result = instrument(source, rangesFor(source));
    // The analyzer's range for a labelled loop is the *labelled statement*, so
    // the markers land outside the label and `continue outer` keeps its target.
    // Nothing is skipped, and the behaviour case above proves it still runs the
    // same. (Case 4 in CASES.)
    expect(result.skipped).toEqual([]);
    expect(result.code).toContain("outer: for");
  });

  it("refuses to wrap a range that points *inside* a label, and says why", () => {
    const source = CASES[4].source;
    const loopStart = source.indexOf("for (const a");
    // A hypothetical caller naming the loop rather than the labelled statement:
    // wrapping here would put `{` between `outer:` and its loop and break
    // `continue outer`, so the probe is refused instead of silently applied.
    const end = source.lastIndexOf("}\n  return pairs") + 1;
    const result = instrument(source, [{ nodeId: "hypothetical", start: loopStart, end }]);
    expect(result.probed).toEqual([]);
    expect(result.skipped[0]?.reason).toBe("labelled-statement");
  });

  it("probes the elements of a Promise.all, which are expressions", () => {
    const source = CASES.find((entry) => entry.name.startsWith("Promise.all —"))!.source;
    const result = instrument(source, rangesFor(source));
    expect(result.skipped).toEqual([]);
    expect(result.code).toContain("__cf.p(");
    // The wrap must sit around the call and nothing else: the array literal,
    // the `await` and the destructuring are all untouched.
    expect(result.code).toContain("await Promise.all([");
  });

  it("puts a loop's pass marker inside the body, never around the loop", () => {
    const source = CASES.find((entry) => entry.name.startsWith("nested loops"))!.source;
    const result = instrument(source, rangesFor(source));
    expect(result.counted.length).toBe(2);
    expect(result.blind).toBe(false);
    // Immediately after each `{` that opens a body — so a `break` on the first
    // statement still skips everything the pass would have done.
    expect(result.code).toMatch(/for \(const a of \["x", "y"\]\) \{__cf\.pass\(/);
    expect(result.code).toMatch(/for \(const b of \[1, 2\]\) \{__cf\.pass\(/);
  });

  it("refuses the pass marker where it refuses every other wrap", () => {
    const source = CASES.find((entry) => entry.name.startsWith("`var` as a loop body"))!.source;
    const result = instrument(source, rangesFor(source));
    expect(result.counted).toEqual([]);
    expect(result.uncounted.length).toBe(1);
    // Declared, not merely absent: the loop announces that nothing inside it
    // can be numbered, and the run stays numbered everywhere else.
    expect(result.code).toContain("__cf.unknown(");
    expect(result.blind).toBe(false);
    expect(result.skipped.map((entry) => entry.reason)).toEqual(["hoisted-declaration-body"]);
  });

  it("keeps every line on its own line, so a stack trace still points somewhere real", () => {
    for (const runCase of CASES) {
      const result = instrument(runCase.source, rangesFor(runCase.source));
      expect(result.code.split("\n").length).toBe(runCase.source.split("\n").length);
    }
  });

  it("blanks the imports it cannot resolve, and keeps the file's shape", () => {
    const source = `import type { Tools } from "../generated/tools";
import { helper } from "@flows/lib";

export default async function flow(input: {}, tools: Tools) {
  return helper(1);
}
`;
    const result = instrument(source, rangesFor(source), { rewriteImports: { "@flows/lib": "./lib.ts" } });
    expect(result.droppedImports).toEqual(["../generated/tools"]);
    expect(result.code).toContain('import { helper } from "./lib.ts"');
    expect(result.code.split("\n").length).toBe(source.split("\n").length);
  });
});

/* -------------------------------------------------------------------------- */
/* the real gallery                                                            */
/* -------------------------------------------------------------------------- */

describe("instrument() over every published example", () => {
  for (const example of EXAMPLES) {
    it(`${example.id} (${String(example.lines)} lines) still parses, and every node is accounted for`, () => {
      const { tools, functions } = registryFor(example);
      const graph = analyzeSource(example.source, createRegistry({ tools, functions }), {
        file: `${example.id}.flow.ts`,
      });
      const ranges = nodeRanges(graph);
      const result = instrument(example.source, ranges, { rewriteImports: { "@flows/lib": "./lib.ts" } });

      // No node may vanish: it is either probed or explicitly skipped with a
      // reason the UI can show. Silence is what 07 §5 forbids.
      const accounted = new Set([...result.probed, ...result.skipped.map((entry) => entry.nodeId)]);
      expect(accounted.size).toBe(ranges.length);

      const diagnostics = ts.transpileModule(result.code, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        reportDiagnostics: true,
      }).diagnostics;
      expect(diagnostics ?? []).toEqual([]);
      expect(result.code.split("\n").length).toBe(example.source.split("\n").length);
    });
  }
});
