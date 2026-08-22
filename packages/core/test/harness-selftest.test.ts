/**
 * The invariant harness must be able to FAIL. A checker that always returns
 * "ok" is worse than no checker, so these tests break a graph on purpose and
 * assert that the breakage is detected.
 */

import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/analyzer/index.js";
import type { WorkflowGraph } from "../src/model/index.js";
import { FIXTURE_FILE, loadFixture, normalizeGraph } from "./harness/fixture.js";
import { checkStatementOwnership } from "./harness/invariants.js";

function clone(graph: WorkflowGraph): WorkflowGraph {
  return JSON.parse(JSON.stringify(graph)) as WorkflowGraph;
}

describe("I1 checker self-test", () => {
  const fixture = loadFixture("01-canonical");
  const graph = analyzeSource(fixture.source, fixture.registry, fixture.options);

  it("passes on the real graph", () => {
    expect(checkStatementOwnership(fixture.source, graph, FIXTURE_FILE)).toEqual([]);
  });

  it("reports an uncovered statement when a node is removed", () => {
    const broken = clone(graph);
    broken.nodes = broken.nodes.filter(
      (node) => !node.source.semanticPath.endsWith("call:slack.send[0]"),
    );
    const problems = checkStatementOwnership(fixture.source, broken, FIXTURE_FILE);
    expect(problems.length).toBeGreaterThan(0);
    // The slack.send statement now falls to the enclosing `if`, which already
    // owns the if-statement — i.e. it is no longer uniquely covered.
    expect(problems[0].statement).toContain("tools.slack.send");
  });

  it("reports ambiguity when two non-synthetic nodes claim one range", () => {
    const broken = clone(graph);
    const duplicate = broken.nodes.find((node) =>
      node.source.semanticPath.endsWith("call:github.getFiles[0]"),
    );
    expect(duplicate).toBeDefined();
    broken.nodes.push({ ...duplicate!, id: `${duplicate!.id}_dup` });
    const problems = checkStatementOwnership(fixture.source, broken, FIXTURE_FILE);
    expect(problems.length).toBeGreaterThan(0);
  });

  it("sees the nested blocks, not just the flow body", () => {
    // If nested blocks were not walked, deleting a node inside the loop body
    // would go unnoticed — the test above proves it does not.
    const broken = clone(graph);
    broken.nodes = broken.nodes.filter(
      (node) => !node.source.semanticPath.endsWith("call:github.getFiles[0]"),
    );
    expect(checkStatementOwnership(fixture.source, broken, FIXTURE_FILE).length).toBeGreaterThan(0);
  });
});

describe("normalization self-test", () => {
  const fixture = loadFixture("19-adjacent-code-statements-merged");
  const graph = analyzeSource(fixture.source, fixture.registry, fixture.options);

  it("interns distinct fingerprints under distinct keys", () => {
    const normalized = normalizeGraph(graph);
    const code = normalized.nodes.find((node) => node.type === "code");
    expect(code).toBeDefined();
    const fingerprints = code!.data["statementFingerprints"] as string[];
    expect(new Set(fingerprints).size).toBe(3);
    for (const key of fingerprints) expect(key).toMatch(/^sha256#\d+$/);
  });

  it("maps node ids to semantic paths so edges stay readable", () => {
    const normalized = normalizeGraph(graph);
    for (const edge of normalized.edges) {
      expect(edge.from.startsWith("#")).toBe(true);
      expect(edge.to.startsWith("#")).toBe(true);
    }
  });
});
