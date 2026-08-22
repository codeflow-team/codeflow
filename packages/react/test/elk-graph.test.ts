import { describe, expect, it } from "vitest";
import type { ElkNode } from "elkjs/lib/elk-api.js";
import { ROOT_ID, collectLayout, toElkGraph } from "../src/layout/elk-graph.js";
import { measureNode } from "../src/layout/measure.js";
import { canonicalGraph, tryGraph } from "./fixtures.js";

function childIds(node: ElkNode | undefined): string[] {
  return (node?.children ?? []).map((child) => child.id);
}

function find(root: ElkNode, id: string): ElkNode | undefined {
  if (root.id === id) return root;
  for (const child of root.children ?? []) {
    const hit = find(child, id);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

describe("toElkGraph — hierarchy", () => {
  it("puts loop children inside the loop, not at the root", () => {
    const { root } = toElkGraph(canonicalGraph(), { mode: "expanded" });

    expect(root.id).toBe(ROOT_ID);
    expect(childIds(root)).toEqual(["n_trigger", "n_getNewPRs", "n_loop", "n_output"]);

    const loop = find(root, "n_loop");
    expect(childIds(loop)).toEqual(["n_getFiles", "n_condition", "n_slack"]);
  });

  it("nests try body and catch children under the try node", () => {
    const { root } = toElkGraph(tryGraph(), { mode: "expanded" });

    expect(childIds(root)).toEqual(["n_try", "n_out"]);
    expect(childIds(find(root, "n_try"))).toEqual(["n_charge", "n_alert"]);
  });

  it("sizes leaves from the measurer and lets ELK size containers", () => {
    const graph = canonicalGraph();
    const { root } = toElkGraph(graph, { mode: "compact" });

    const leaf = find(root, "n_getNewPRs");
    const expected = measureNode(graph.nodes[1], "compact");
    expect(leaf?.width).toBe(expected.width);
    expect(leaf?.height).toBe(expected.height);

    const loop = find(root, "n_loop");
    expect(loop?.width).toBeUndefined();
    expect(loop?.height).toBeUndefined();
    expect(loop?.layoutOptions?.["elk.padding"]).toContain("top=");
  });

  it("honours the disclosure mode when measuring", () => {
    const graph = canonicalGraph();
    const compact = find(toElkGraph(graph, { mode: "compact" }).root, "n_slack");
    const expanded = find(toElkGraph(graph, { mode: "expanded" }).root, "n_slack");
    expect((expanded?.height ?? 0)).toBeGreaterThan(compact?.height ?? 0);
  });
});

describe("toElkGraph — edges", () => {
  it("keeps same-container control edges and skips the rest", () => {
    const { root, skippedEdgeIds } = toElkGraph(canonicalGraph(), { mode: "expanded" });

    const rootEdges = (root.edges ?? []).map((e) => e.id);
    expect(rootEdges).toEqual([
      "n_trigger->n_getNewPRs:control:",
      "n_getNewPRs->n_loop:control:",
      "n_loop->n_output:control:",
    ]);

    const loopEdges = (find(root, "n_loop")?.edges ?? []).map((e) => e.id);
    expect(loopEdges).toEqual(["n_getFiles->n_condition:control:", "n_condition->n_slack:control:true"]);

    // Every data edge, plus the container→child slot edge, stays out of the layout.
    expect(skippedEdgeIds).toContain("n_loop->n_getFiles:control:body");
    expect(skippedEdgeIds).toContain("n_trigger->n_getNewPRs:data:input.repository");
    expect(skippedEdgeIds).toContain("n_loop->n_slack:data:pr.title");
    expect(rootEdges.length + loopEdges.length + skippedEdgeIds.length).toBe(canonicalGraph().edges.length);
  });

  it("can be asked to lay out data edges too", () => {
    const { root } = toElkGraph(canonicalGraph(), { mode: "expanded", edgeKinds: ["control", "data"] });
    expect((root.edges ?? []).map((e) => e.id)).toContain("n_trigger->n_getNewPRs:data:input.repository");
  });

  it("skips edges that cross a container boundary", () => {
    const { skippedEdgeIds } = toElkGraph(tryGraph(), { mode: "expanded" });
    expect(skippedEdgeIds).toContain("n_charge->n_out:control:");
  });
});

describe("collectLayout", () => {
  it("flattens a laid-out tree, keeping child coordinates parent-relative", () => {
    const laidOut: ElkNode = {
      id: ROOT_ID,
      children: [
        {
          id: "n_loop",
          x: 10,
          y: 20,
          width: 300,
          height: 200,
          children: [{ id: "n_getFiles", x: 16, y: 56, width: 180, height: 40 }],
        },
      ],
    };
    const boxes = collectLayout(laidOut);
    expect(boxes.get("n_loop")).toEqual({ x: 10, y: 20, width: 300, height: 200 });
    expect(boxes.get("n_getFiles")).toEqual({ x: 16, y: 56, width: 180, height: 40 });
  });
});
