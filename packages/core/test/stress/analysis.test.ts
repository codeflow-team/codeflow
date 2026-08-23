/**
 * The graph each example produces, pinned.
 *
 * The counts below are reviewed, not snapshotted: each one was read off the
 * flow and checked against 04-analyzer.md before it was written down. They are
 * exact on purpose. A range ("between 20 and 30 tool nodes") would pass while
 * the analyzer quietly lost a step inside a `finally`, and losing a step is
 * exactly the failure O1 exists to prevent — the graph must not be missing
 * anything the code does.
 *
 * What each block asserts, in order: the node census, the edge count, that
 * nothing degraded that was not meant to, and I1 (every statement owned by
 * exactly one node).
 */

import { describe, expect, it } from "vitest";

import {
  CLEAN_EXAMPLES,
  EXAMPLES,
  assertOwnership,
  countByType,
  depthOf,
  diagnosticsOf,
  errorsOf,
  exampleById,
  nodeAt,
  nodesOfType,
  open,
  toolNodes,
} from "./helpers.js";
import { assertIntegrity } from "../harness/reanalyze.js";

interface Expectation {
  id: string;
  lines: number;
  nodes: Record<string, number>;
  edges: number;
  /** Code nodes are an `info` diagnostic each; anything else must be zero. */
  codeNodes: number;
}

const EXPECTED: Expectation[] = [
  {
    id: "canonical",
    lines: 20,
    nodes: { condition: 1, loop: 1, output: 1, tool: 3, trigger: 1 },
    edges: 11,
    codeNodes: 0,
  },
  {
    id: "code-nodes",
    lines: 17,
    nodes: { code: 1, function: 1, output: 1, tool: 2, trigger: 1 },
    edges: 10,
    codeNodes: 1,
  },
  {
    id: "try-catch",
    lines: 17,
    nodes: { condition: 1, output: 2, tool: 2, trigger: 1, try: 1 },
    edges: 11,
    codeNodes: 0,
  },
  {
    id: "memory-graph-sync",
    lines: 150,
    nodes: {
      code: 7,
      condition: 5,
      jump: 1,
      loop: 1,
      merge: 4,
      output: 4,
      tool: 11,
      trigger: 1,
      try: 1,
    },
    edges: 84,
    codeNodes: 7,
  },
  {
    id: "doc-freshness-audit",
    lines: 138,
    nodes: {
      code: 9,
      condition: 6,
      function: 1,
      jump: 1,
      loop: 1,
      merge: 4,
      output: 3,
      parallel: 1,
      tool: 11,
      trigger: 1,
      try: 1,
    },
    edges: 95,
    codeNodes: 9,
  },
  {
    id: "repo-triage-bot",
    lines: 343,
    nodes: {
      code: 20,
      condition: 13,
      function: 2,
      jump: 5,
      loop: 4,
      merge: 11,
      output: 6,
      parallel: 1,
      tool: 24,
      trigger: 1,
      try: 3,
    },
    edges: 220,
    codeNodes: 20,
  },
  {
    id: "research-agent",
    lines: 290,
    nodes: {
      code: 15,
      condition: 8,
      function: 3,
      jump: 3,
      loop: 4,
      merge: 7,
      output: 4,
      parallel: 1,
      tool: 21,
      trigger: 1,
      try: 2,
    },
    edges: 170,
    codeNodes: 15,
  },
  {
    id: "browser-qa-runner",
    lines: 345,
    nodes: {
      code: 21,
      condition: 18,
      function: 4,
      jump: 5,
      loop: 4,
      merge: 11,
      output: 5,
      parallel: 1,
      tool: 28,
      trigger: 1,
      try: 3,
    },
    edges: 286,
    codeNodes: 21,
  },
  {
    id: "data-pipeline",
    lines: 261,
    nodes: {
      code: 21,
      condition: 12,
      function: 3,
      jump: 8,
      loop: 4,
      merge: 10,
      output: 4,
      parallel: 1,
      tool: 21,
      trigger: 1,
      try: 2,
    },
    edges: 220,
    codeNodes: 21,
  },
];

describe("the corpus itself", () => {
  it("has eleven examples across five categories", () => {
    expect(EXAMPLES).toHaveLength(11);
    expect(new Set(EXAMPLES.map((example) => example.category)).size).toBe(5);
  });

  it("has four flows over 200 lines and none over 500", () => {
    const long = EXAMPLES.filter((example) => example.lines >= 200);
    expect(long.map((example) => example.id).sort()).toEqual([
      "browser-qa-runner",
      "data-pipeline",
      "repo-triage-bot",
      "research-agent",
    ]);
    for (const example of long) expect(example.lines, example.id).toBeLessThanOrEqual(500);
  });

  it("has seven flows written against real MCP schemas", () => {
    // The `sample` registry is the specs' own github/slack one; everything else
    // comes from a captured `tools/list` payload.
    const realMcp = EXAMPLES.filter((example) => example.registryId !== "sample");
    expect(realMcp).toHaveLength(7);
  });
});

describe.each(EXPECTED.map((expectation) => [expectation.id, expectation] as const))(
  "%s",
  (id, expectation) => {
    it("matches its reviewed node census", async () => {
      const { graph, example } = await open(exampleById(id));
      expect(example.lines).toBe(expectation.lines);
      expect(countByType(graph)).toEqual(expectation.nodes);
      expect(graph.edges).toHaveLength(expectation.edges);
    });

    it("degrades only where it was meant to", async () => {
      const { graph } = await open(exampleById(id));
      // No unresolved tool, no contract violation, nothing else with severity error.
      expect(errorsOf(graph).map((diagnostic) => diagnostic.code)).toEqual([]);
      // A code node is an `info` — every other diagnostic would be a surprise.
      expect(diagnosticsOf(graph, "unsupported-construct")).toHaveLength(expectation.codeNodes);
      expect(diagnosticsOf(graph, "hidden-call-in-expression")).toEqual([]);
      expect(diagnosticsOf(graph, "unbounded-loop-risk")).toEqual([]);
      expect(diagnosticsOf(graph, "needs-configuration")).toEqual([]);
      expect(graph.diagnostics).toHaveLength(expectation.codeNodes);
    });

    it("owns every statement exactly once (I1)", async () => {
      const { graph, example } = await open(exampleById(id));
      assertOwnership(example, graph);
      assertIntegrity(graph);
    });
  },
);

describe("the shapes the long flows were written for", () => {
  it("repo-triage-bot nests a try inside three loops inside a try", async () => {
    const { graph } = await open(exampleById("repo-triage-bot"));

    const tries = nodesOfType(graph, "try");
    const depths = tries.map((node) => depthOf(graph, node)).sort();
    // The outer try at the flow's top level; the retry try one level inside the
    // `while`; and the per-file try four levels down — inside the outer try,
    // inside three nested `for...of` loops.
    expect(depths).toEqual([0, 1, 4]);

    const loops = nodesOfType(graph, "loop");
    expect(loops.map((node) => depthOf(graph, node)).sort()).toEqual([0, 1, 2, 3]);
  });

  it("repo-triage-bot names the loop on every one of its labelled jumps", async () => {
    const { graph } = await open(exampleById("repo-triage-bot"));

    const labelled = nodesOfType(graph, "jump").filter(
      (node) => node.data["label"] === "outer",
    );
    expect(labelled).toHaveLength(3);
    expect(labelled.map((node) => node.data["kind"]).sort()).toEqual([
      "break",
      "continue",
      "continue",
    ]);

    // The one that matters: a labelled `continue` written inside a `catch`,
    // four levels down, still names the loop it targets.
    const fromCatch = labelled.find((node) => depthOf(graph, node) >= 5);
    expect(fromCatch?.data["kind"]).toBe("continue");
  });

  it("repo-triage-bot reaches its finally from the loop AND from the catch's return", async () => {
    // 04 §2.7 — a `finally` that only had an edge from the body would be a
    // graph that lies about a side effect: the catch returns early, and the
    // observation still gets written.
    const { graph } = await open(exampleById("repo-triage-bot"));

    const outerTry = nodeAt(graph, "flow/try[0]");
    const inFinally = graph.nodes.filter(
      (node) => node.data["parentId"] === outerTry.id && node.data["parentSlot"] === "finally",
    );
    expect(inFinally).toHaveLength(1);

    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const incoming = graph.edges
      .filter((edge) => edge.target === inFinally[0].id && edge.kind === "control")
      .map((edge) => byId.get(edge.source)!.source.semanticPath)
      .sort();

    expect(incoming).toEqual(["flow/try[0]/catch/return[0]", "flow/try[0]/for[0]"]);
  });

  it("every long flow fans out through exactly one parallel node with four branches", async () => {
    for (const id of ["repo-triage-bot", "research-agent", "browser-qa-runner", "data-pipeline"]) {
      const { graph } = await open(exampleById(id));
      const parallel = nodesOfType(graph, "parallel");
      expect(parallel, id).toHaveLength(1);
      const branches = graph.edges.filter(
        (edge) => edge.source === parallel[0].id && edge.kind === "control",
      );
      expect(branches.length, id).toBe(4);
    }
  });

  it("browser-qa-runner drives playwright and reads its evidence back off disk", async () => {
    const { graph } = await open(exampleById("browser-qa-runner"));

    // Both servers really are in play: the browser writes, the filesystem reads.
    const playwright = graph.nodes.filter((node) =>
      String(node.data["toolName"] ?? "").startsWith("browser."),
    );
    const filesystem = graph.nodes.filter((node) =>
      String(node.data["toolName"] ?? "").startsWith("fs."),
    );
    expect(playwright.length).toBeGreaterThanOrEqual(15);
    expect(filesystem.length).toBeGreaterThanOrEqual(8);

    // The cleanup the whole flow depends on: `browser.close` lives in a finally.
    const close = toolNodes(graph, "browser.close");
    expect(close).toHaveLength(1);
    const parentId = close[0].data["parentId"];
    const parent = graph.nodes.find((node) => node.id === parentId);
    expect(parent?.type).toBe("try");
    expect(close[0].data["parentSlot"]).toBe("finally");
  });

  it("data-pipeline keeps the fold as one code node instead of inventing five", async () => {
    const { graph, example } = await open(exampleById("data-pipeline"));

    const fold = nodesOfType(graph, "code").find((node) =>
      example.source
        .slice(node.source.start.offset, node.source.end.offset)
        .includes("const bucket ="),
    );
    expect(fold, "the fold should be one merged code node").toBeDefined();
    const text = example.source.slice(fold!.source.start.offset, fold!.source.end.offset);
    // Declaration + if/else + the accepted counter, merged into one opaque run.
    // Six consecutive statements with no projection rule, merged into one
    // opaque run (04 §2.11) — six nodes here would be six lies.
    expect(text).toContain("const bucket =");
    expect(text).toContain("totals.splice(");
    expect(text).toContain("accepted = accepted + 1;");
  });

  it("research-agent bounds both of its while loops", async () => {
    const { graph } = await open(exampleById("research-agent"));
    const whiles = nodesOfType(graph, "loop").filter((node) => node.data["kind"] === "while");
    expect(whiles).toHaveLength(2);
    for (const node of whiles) expect(node.data["bounded"], String(node.data["condition"])).toBe(true);
  });
});

describe("every clean example, as a group", () => {
  it("resolves every tool call against its registry", async () => {
    for (const example of CLEAN_EXAMPLES) {
      const { graph } = await open(example);
      expect(nodesOfType(graph, "unknown"), example.id).toEqual([]);
    }
  });

  it("carries the registry hash of the registry it names", async () => {
    for (const example of CLEAN_EXAMPLES) {
      const { graph, registry } = await open(example);
      expect(graph.registryHash, example.id).toBe(registry.registryHash());
    }
  });

  it("is deterministic — a cold re-analyze reproduces every id (I2)", async () => {
    for (const example of CLEAN_EXAMPLES) {
      const first = await open(example);
      const second = await open(example);
      expect(second.graph.nodes.map((node) => node.id), example.id).toEqual(
        first.graph.nodes.map((node) => node.id),
      );
      expect(second.graph.edges.map((edge) => edge.id), example.id).toEqual(
        first.graph.edges.map((edge) => edge.id),
      );
    }
  });
});
