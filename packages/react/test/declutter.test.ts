/**
 * The decluttering rules, and the promises that make them safe.
 *
 * Two of them are honesty guarantees rather than looks:
 *
 *  - hiding a data edge must not lose what it said, so every hidden edge has to
 *    come back as words on the node it arrived at;
 *  - a friendlier decision title must never be a *different* claim, so the
 *    translator refuses everything it cannot render exactly.
 *
 * The second is the one worth being paranoid about: a wrong-but-readable label
 * on a branch is worse than an unreadable-but-true one, because the user has no
 * way to tell it is wrong.
 */

import { describe, expect, it } from "vitest";
import type { WorkflowNode } from "@codeflow/core";
import { buildDataLinks, resolveDataEdgeMode, takesLines } from "../src/flow/data-links.js";
import { nodeTitle, plainCondition, takesRows, rowsForMode } from "../src/flow/summary.js";
import { buildIndex } from "../src/graph/index.js";
import { measureNode } from "../src/layout/measure.js";
import { canonicalGraph } from "./fixtures.js";

function conditionNode(expression: string): WorkflowNode {
  return {
    id: "n",
    type: "condition",
    label: expression,
    inputs: [],
    outputs: [],
    data: { expression, labelSource: "expression" },
    capabilities: { deletable: true, editable: true, insertableAfter: true },
    source: {
      semanticPath: "flow/if#0",
      start: { offset: 0, line: 1, column: 1 },
      end: { offset: 1, line: 1, column: 2 },
    },
  } as unknown as WorkflowNode;
}

describe("plainCondition — only exact translations", () => {
  it("renders the shapes it can render exactly", () => {
    expect(plainCondition('stat.content.includes("size: 0")')).toBe("stat.content contains “size: 0”");
    expect(plainCondition('!name.startsWith("_")')).toBe("name does not start with “_”");
    expect(plainCondition("drops.length === 0")).toBe("drops is empty");
    expect(plainCondition("headers.length > 0")).toBe("headers is not empty");
    expect(plainCondition("record === undefined")).toBe("record is undefined");
    expect(plainCondition("status !== 'open'")).toBe("status is not “open”");
    expect(plainCondition("!outcome.ok")).toBe("not outcome.ok");
    // A call in the subject is still an exact reading of the same test.
    expect(plainCondition("planFile.content.trim().length === 0")).toBe(
      "planFile.content.trim() is empty",
    );
  });

  it("refuses anything whose English would imply a precedence the code has not", () => {
    expect(plainCondition("a === 1 && b === 2")).toBeNull();
    expect(plainCondition("a || b")).toBeNull();
    expect(plainCondition("a ? b : c")).toBeNull();
    expect(plainCondition("a?.b")).toBeNull();
    expect(plainCondition("!(a === b)")).toBeNull();
    expect(plainCondition("a === b === c")).toBeNull();
  });

  it("leaves an expression it has no exact reading for completely alone", () => {
    expect(plainCondition("rejects.length > input.maxRejects")).toBeNull();
    expect(plainCondition("compute(a, b)")).toBeNull();
    expect(plainCondition(null)).toBeNull();
  });

  it("only ever softens the title at the beginner level", () => {
    const node = conditionNode("drops.length === 0");
    expect(nodeTitle(node, "compact")).toBe("drops is empty");
    expect(nodeTitle(node, "expanded")).toBe("drops.length === 0");
    expect(nodeTitle(node, "developer")).toBe("drops.length === 0");
  });

  it("never touches a label the analyzer already made human (registry sugar)", () => {
    const node = conditionNode("isDraft(pr)");
    node.label = "Pull request is a draft";
    node.data["labelSource"] = "registry";
    expect(nodeTitle(node, "compact")).toBe("Pull request is a draft");
  });
});

/**
 * The one rule the first decluttering pass got wrong.
 *
 * It read "progressive disclosure" as "the beginner level shows less of
 * everything" and turned select-to-reveal off at Simple. That inverted the
 * point: the question a beginner asks first is "where does this step get its
 * input from", and pointing at a step is how they ask it. Four to seven lines
 * answer it and clutter nothing; the hundred and seventy at once are what
 * clutter, and those are what the toggle is for — at every level equally.
 */
describe("select-to-reveal is the rule at every level", () => {
  it("reveals the selected step's values whatever the disclosure level", () => {
    expect(resolveDataEdgeMode(false)).toBe("selected");
  });

  it("still puts every edge behind the toggle", () => {
    expect(resolveDataEdgeMode(true)).toBe("all");
  });

  it("never resolves to the spine-only view — that would drop select-reveal", () => {
    expect([resolveDataEdgeMode(false), resolveDataEdgeMode(true)]).not.toContain("none");
  });
});

describe("data links — a hidden edge becomes words", () => {
  it("indexes every data edge from both ends, by step name", () => {
    const graph = canonicalGraph();
    const links = buildDataLinks(graph, buildIndex(graph));
    const condition = links.get("n_condition");
    expect(condition?.incoming.some((link) => link.value === "files")).toBe(true);
    // The name of the step, never its id — that is the whole point of the row.
    expect(condition?.incoming.every((link) => !link.nodeLabel.startsWith("n_"))).toBe(true);

    const source = links.get("n_getFiles");
    expect(source?.outgoing.some((link) => link.nodeId === "n_condition")).toBe(true);
  });

  it("folds two values from one step onto one line", () => {
    const lines = takesLines({
      incoming: [
        { edgeId: "a", nodeId: "n1", nodeLabel: "Read Text File", value: "rows" },
        { edgeId: "b", nodeId: "n1", nodeLabel: "Read Text File", value: "headers" },
        { edgeId: "c", nodeId: "n2", nodeLabel: "Trigger", value: "input.path" },
      ],
      outgoing: [],
    });
    expect(lines).toEqual(["rows, headers ← Read Text File", "input.path ← Trigger"]);
  });

  it("counts what it cannot fit instead of dropping it", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      edgeId: `e${String(i)}`,
      nodeId: `n${String(i)}`,
      nodeLabel: `Step ${String(i)}`,
      value: `v${String(i)}`,
    }));
    const rows = takesRows({ incoming: many, outgoing: [] });
    expect(rows).toHaveLength(4);
    expect(rows[0].key).toBe("Takes");
    expect(rows[3].value).toContain("+3 more");
    // Every row has its own React key even though only the first is labelled.
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  it("puts the provenance on the card at the level that shows settings", () => {
    const graph = canonicalGraph();
    const links = buildDataLinks(graph, buildIndex(graph)).get("n_condition") ?? null;
    const rows = rowsForMode(graph.nodes.find((n) => n.id === "n_condition")!, "expanded", links);
    expect(rows.some((row) => row.kind === "takes" && row.value.includes("←"))).toBe(true);
    expect(rowsForMode(graph.nodes[0], "compact", links)).toHaveLength(0);
  });

  it("sizes the card for the rows it will actually draw", () => {
    const graph = canonicalGraph();
    const node = graph.nodes.find((n) => n.id === "n_condition")!;
    const links = buildDataLinks(graph, buildIndex(graph)).get("n_condition") ?? null;
    expect(measureNode(node, "expanded", links).height).toBeGreaterThan(
      measureNode(node, "expanded", null).height,
    );
  });
});
