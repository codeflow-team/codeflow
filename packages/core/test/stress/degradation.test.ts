/**
 * The degradation showcase, asserted diagnostic by diagnostic.
 *
 * The other stress files assert that nothing degrades unexpectedly. This one
 * asserts the opposite direction, which matters just as much: when CodeFlow
 * does not know something, it has to *say so*, in the right place, with the
 * right severity. A silently-swallowed tool call is invariant I6's failure
 * mode, and the only way to keep the vocabulary honest is to pin the whole of
 * it against a file written to trip every rule at once.
 *
 * Each case below names the statement it belongs to and the spec section that
 * decides the answer.
 */

import { describe, expect, it } from "vitest";

import { assertOwnership, countByType, diagnosticsOf, exampleById, nodesOfType, open } from "./helpers.js";
import { assertIntegrity } from "../harness/reanalyze.js";

/** The line a diagnostic points at, as text — the readable form of "where". */
function pointsAt(source: string, line: number): string {
  return (source.split("\n")[line - 1] ?? "").trim();
}

describe("degradation-showcase", () => {
  it("produces exactly the census the file was written for", async () => {
    const { graph, example } = await open(exampleById("degradation-showcase"));

    expect(countByType(graph)).toEqual({
      code: 3,
      condition: 1,
      function: 1,
      loop: 1,
      output: 1,
      tool: 4,
      trigger: 1,
      unknown: 2,
    });

    assertOwnership(example, graph);
    assertIntegrity(graph);
  });

  it("says exactly this much, and no more", async () => {
    const { graph } = await open(exampleById("degradation-showcase"));

    const census: Record<string, number> = {};
    for (const diagnostic of graph.diagnostics) {
      const key = `${diagnostic.severity}:${diagnostic.code}`;
      census[key] = (census[key] ?? 0) + 1;
    }

    expect(census).toEqual({
      "error:unresolved-tool": 2,
      "warning:hidden-call-in-expression": 6,
      "warning:unsupported-optional-chaining": 1,
      "warning:unbounded-loop-risk": 1,
      "info:unsupported-construct": 3,
    });
  });

  it("shows an unregistered tool as an `unknown` node rather than hiding the call", async () => {
    // 04 §1.2 — the call is still a step, it just could not be resolved.
    const { graph } = await open(exampleById("degradation-showcase"));

    const unknown = nodesOfType(graph, "unknown");
    expect(unknown.map((node) => node.label).sort()).toEqual([
      "fs.gitBlameEveryLine",
      "github.openIssue",
    ]);
    // An unknown node offers no editable fields — there is no schema to edit
    // against, and inventing one would be worse than saying nothing.
    for (const node of unknown) expect(node.capabilities.editable).toBe(false);

    const errors = diagnosticsOf(graph, "unresolved-tool");
    expect(errors).toHaveLength(2);
    for (const error of errors) expect(error.severity).toBe("error");
  });

  it("refuses optional chaining on `tools` and keeps the statement verbatim", async () => {
    // 01 §2 — `tools.fs?.readTextFile?.()` has no static answer.
    const { graph, example } = await open(exampleById("degradation-showcase"));

    const [optional] = diagnosticsOf(graph, "unsupported-optional-chaining");
    expect(optional.severity).toBe("warning");
    expect(pointsAt(example.source, optional.source!.start.line)).toContain("tools.fs?.readTextFile?.");
  });

  it("points each hidden call at the call, not at the head of the code node", async () => {
    // 04 §1.4 + the hardening regression §5: a merged code node can span many
    // lines, and the diagnostic has to send the reader to the expression to
    // hoist.
    const { graph, example } = await open(exampleById("degradation-showcase"));

    const hidden = diagnosticsOf(graph, "hidden-call-in-expression");
    const lines = hidden.map((diagnostic) => pointsAt(example.source, diagnostic.source!.start.line));

    // The `if` condition, the `.map()` fan-out, the classic `for`, both arms of
    // the `switch`, and the call two callbacks deep.
    expect(lines.some((line) => line.startsWith("if (await tools.fs.getFileInfo"))).toBe(true);
    expect(lines.some((line) => line.includes("input.roots.map((root) =>"))).toBe(true);
    expect(lines.some((line) => line.includes("tools.fs.listDirectory({ path: input.roots[index] })"))).toBe(true);
    expect(lines.some((line) => line.includes("tools.memory.deleteEntities"))).toBe(true);
    expect(lines.some((line) => line.includes("tools.memory.searchNodes"))).toBe(true);
    expect(lines.some((line) => line.includes("scans.map((scan) => () =>"))).toBe(true);

    for (const diagnostic of hidden) {
      expect(diagnostic.severity).toBe("warning");
      expect(diagnostic.message).toContain("hoist");
    }
  });

  it("never turns `Promise.all` over a `.map()` into a parallel node", async () => {
    // 04 §2.6 — the dynamic fan-out is outside the MVP, and a fake parallel
    // node would hide the tool call inside the callback.
    const { graph } = await open(exampleById("degradation-showcase"));
    expect(nodesOfType(graph, "parallel")).toEqual([]);
  });

  it("never turns hoisted promises into a parallel node either", async () => {
    // The regression an AI eval found (NOTES, phase 5): `Promise.all([aP, bP])`
    // has no call to make a branch out of.
    const { graph, example } = await open(exampleById("degradation-showcase"));

    expect(example.source).toContain("const [tree, graph] = await Promise.all([treePromise, memoryPromise]);");
    expect(nodesOfType(graph, "parallel")).toEqual([]);

    const owner = nodesOfType(graph, "code").find((node) =>
      example.source
        .slice(node.source.start.offset, node.source.end.offset)
        .includes("Promise.all([treePromise, memoryPromise])"),
    );
    expect(owner, "the hoisted-promise statement must belong to a code node").toBeDefined();
  });

  it("warns about a `while` whose bound it cannot see", async () => {
    // 04 §2.8 — best-effort, and a warning rather than a refusal: whether to
    // run an unbounded loop is the runtime's call, not CodeFlow's.
    const { graph } = await open(exampleById("degradation-showcase"));

    const [warning] = diagnosticsOf(graph, "unbounded-loop-risk");
    expect(warning.severity).toBe("warning");

    const loop = nodesOfType(graph, "loop")[0];
    expect(loop.data["kind"]).toBe("while");
    expect(loop.data["bounded"]).toBe(false);
    // The loop is still a real loop node with a real subgraph — degrading the
    // bound check does not degrade the projection.
    expect(graph.nodes.filter((node) => node.data["parentId"] === loop.id).length).toBeGreaterThan(0);
  });

  it("does not resolve a computed tool path", async () => {
    // Deciding what `tools["fs"]` evaluates to has no bottom (hardening
    // `degradation.test.ts` pins the same rule for `tools.slack["send"]`).
    const { graph, example } = await open(exampleById("degradation-showcase"));

    expect(example.source).toContain('await tools["fs"].createDirectory(');
    expect(graph.nodes.some((node) => node.data["toolName"] === "fs.createDirectory")).toBe(false);
  });

  it("still resolves the four tools that ARE in the registry", async () => {
    // Degradation is local: one unresolvable statement must not poison the file.
    const { graph } = await open(exampleById("degradation-showcase"));

    expect(
      nodesOfType(graph, "tool")
        .map((node) => node.data["toolName"])
        .sort(),
    ).toEqual([
      "fs.listAllowedDirectories",
      "fs.readTextFile",
      "memory.readGraph",
      "memory.searchNodes",
    ]);

    // And the library function is still a function node with its registry label.
    const [scoreRisk] = nodesOfType(graph, "function");
    expect(scoreRisk.label).toBe("Score Risk");
  });
});

describe("demo-degradation", () => {
  it("keeps the three degradations the demo shipped with", async () => {
    const { graph, example } = await open(exampleById("demo-degradation"));

    expect(diagnosticsOf(graph, "unresolved-tool")).toHaveLength(1);
    expect(diagnosticsOf(graph, "hidden-call-in-expression")).toHaveLength(1);
    expect(diagnosticsOf(graph, "unsupported-construct")).toHaveLength(2);

    expect(countByType(graph)).toEqual({
      code: 2,
      loop: 1,
      output: 1,
      trigger: 1,
      unknown: 1,
    });

    assertOwnership(example, graph);
  });

  it("treats `while (somethingUnknown(attempts))` as bounded, because the body writes `attempts`", async () => {
    // Pinned as *behaviour*, not as an aspiration: the bound check is a
    // best-effort idiom match (04 §2.8), and this file is the reminder of how
    // shallow it is. `attempts = attempts` is enough to satisfy it.
    const { graph } = await open(exampleById("demo-degradation"));
    const loop = nodesOfType(graph, "loop")[0];
    expect(loop.data["kind"]).toBe("while");
    expect(loop.data["bounded"]).toBe(true);
    expect(diagnosticsOf(graph, "unbounded-loop-risk")).toEqual([]);
  });
});
