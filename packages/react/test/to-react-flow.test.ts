import { describe, expect, it } from "vitest";
import { NODE_TYPE_CONTAINER, NODE_TYPE_LEAF, slotHandleId, toReactFlow } from "../src/flow/to-react-flow.js";
import { buildIndex, diagnosticsByNode, nodeAtOffset } from "../src/graph/index.js";
import { canonicalGraph, tryGraph } from "./fixtures.js";

describe("toReactFlow — nodes", () => {
  it("maps loop/try children to React Flow parent/child with extent", () => {
    const { nodes } = toReactFlow(canonicalGraph(), { mode: "expanded" });
    const byId = new Map(nodes.map((n) => [n.id, n]));

    expect(byId.get("n_getFiles")?.parentId).toBe("n_loop");
    expect(byId.get("n_getFiles")?.extent).toBe("parent");
    expect(byId.get("n_slack")?.parentId).toBe("n_loop");
    expect(byId.get("n_loop")?.parentId).toBeUndefined();
    expect(byId.get("n_trigger")?.parentId).toBeUndefined();
  });

  it("emits parents before their children — React Flow requires it", () => {
    const { nodes } = toReactFlow(canonicalGraph(), { mode: "expanded" });
    const order = nodes.map((n) => n.id);
    for (const child of ["n_getFiles", "n_condition", "n_slack"]) {
      expect(order.indexOf("n_loop")).toBeLessThan(order.indexOf(child));
    }
  });

  it("uses the container node type only for nodes that hold children", () => {
    const { nodes } = toReactFlow(canonicalGraph(), { mode: "expanded" });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    expect(byId.get("n_loop")?.type).toBe(NODE_TYPE_CONTAINER);
    expect(byId.get("n_condition")?.type).toBe(NODE_TYPE_LEAF);
    expect(byId.get("n_slack")?.type).toBe(NODE_TYPE_LEAF);
  });

  it("carries slot, mode and diagnostics into node data", () => {
    const graph = tryGraph();
    const { nodes } = toReactFlow(graph, { mode: "compact", diagnostics: diagnosticsByNode(graph) });
    const byId = new Map(nodes.map((n) => [n.id, n]));

    expect(byId.get("n_charge")?.data.slot).toBe("body");
    expect(byId.get("n_alert")?.data.slot).toBe("catch");
    expect(byId.get("n_charge")?.data.mode).toBe("compact");
    expect(byId.get("n_alert")?.data.diagnostics).toHaveLength(1);
    expect(byId.get("n_charge")?.data.diagnostics).toHaveLength(0);
  });

  it("takes positions and sizes from the ELK boxes when given", () => {
    const boxes = new Map([["n_loop", { x: 12, y: 34, width: 400, height: 260 }]]);
    const { nodes } = toReactFlow(canonicalGraph(), { mode: "expanded", boxes });
    const loop = nodes.find((n) => n.id === "n_loop");
    expect(loop?.position).toEqual({ x: 12, y: 34 });
    expect(loop?.width).toBe(400);
    expect(loop?.height).toBe(260);
  });

  it("falls back to measured sizes before layout finishes", () => {
    const { nodes } = toReactFlow(canonicalGraph(), { mode: "expanded", boxes: null });
    for (const node of nodes) {
      expect(node.position).toEqual({ x: 0, y: 0 });
      expect(node.width).toBeGreaterThan(0);
      expect(node.height).toBeGreaterThan(0);
    }
  });

  it("marks the selected node", () => {
    const { nodes } = toReactFlow(canonicalGraph(), { mode: "expanded", selectedNodeId: "n_slack" });
    expect(nodes.find((n) => n.id === "n_slack")?.selected).toBe(true);
    expect(nodes.find((n) => n.id === "n_loop")?.selected).toBe(false);
  });
});

describe("toReactFlow — edges", () => {
  it("keeps every graph edge, labelled and typed by kind", () => {
    const graph = canonicalGraph();
    const { edges } = toReactFlow(graph, { mode: "expanded", dataEdges: "all" });
    expect(edges).toHaveLength(graph.edges.length);

    const trueEdge = edges.find((e) => e.id === "n_condition->n_slack:control:true");
    expect(trueEdge?.label).toBe("true");
    expect(trueEdge?.className).toContain("cf-rf-edge--true");
    expect(trueEdge?.animated).toBe(false);
    expect(trueEdge?.hidden).toBeFalsy();

    /*
     * The value a data edge carries is kept on the edge; it is *printed* only
     * while the edge is focused. Off-focus there can be 172 of these on one
     * canvas, and 172 value names written across the diagram is a second
     * thicket on top of the one the hidden edges just cleared.
     */
    const dataEdge = edges.find((e) => e.id === "n_getFiles->n_condition:data:files");
    expect(dataEdge?.data?.value).toBe("files");
    expect(dataEdge?.label).toBeUndefined();
    expect(dataEdge?.animated).toBe(false);
    expect(dataEdge?.data?.kind).toBe("data");
  });

  /*
   * The decluttering rule itself — data edges are hidden until they are asked
   * for. This is the single change that turns 220 lines into 89 on the flows
   * this product exists for.
   */
  describe("the data layer", () => {
    const dataIds = (edges: { id: string; hidden?: boolean }[]): string[] =>
      edges.filter((e) => e.id.includes(":data:") && e.hidden !== true).map((e) => e.id);

    it("draws no data edge at all in the `none` view", () => {
      const { edges } = toReactFlow(canonicalGraph(), { mode: "compact", dataEdges: "none" });
      expect(dataIds(edges)).toHaveLength(0);
      // Hidden, never dropped: the edge is still in the graph the canvas holds.
      expect(edges.filter((e) => e.id.includes(":data:")).length).toBeGreaterThan(0);
    });

    it("draws only the selected step's data edges in the `selected` view", () => {
      const { edges } = toReactFlow(canonicalGraph(), {
        mode: "expanded",
        dataEdges: "selected",
        selectedNodeId: "n_condition",
      });
      const shown = dataIds(edges);
      expect(shown).toContain("n_getFiles->n_condition:data:files");
      expect(shown.every((id) => id.includes("n_condition"))).toBe(true);
      for (const edge of edges) {
        if (!edge.id.includes(":data:")) continue;
        expect(edge.className?.includes("cf-rf-edge--data-focus")).toBe(edge.hidden !== true);
      }
    });

    it("draws every data edge in the `all` view, and marks the selected one", () => {
      const graph = canonicalGraph();
      const { edges } = toReactFlow(graph, {
        mode: "expanded",
        dataEdges: "all",
        selectedNodeId: "n_condition",
      });
      const all = graph.edges.filter((e) => e.kind === "data").map((e) => e.id);
      expect(dataIds(edges).sort()).toEqual([...all].sort());
      const focused = edges.filter((e) => e.className?.includes("cf-rf-edge--data-focus"));
      expect(focused.length).toBeGreaterThan(0);
      expect(focused.every((e) => e.source === "n_condition" || e.target === "n_condition")).toBe(true);
    });

    it("hands every hidden edge to the node it arrives at, in words", () => {
      const graph = canonicalGraph();
      const { nodes } = toReactFlow(graph, { mode: "expanded", dataEdges: "none" });
      const condition = nodes.find((n) => n.id === "n_condition");
      // The line is gone from the canvas; the fact it carried is on the card,
      // naming the *step* rather than its id.
      expect(condition?.data.links.incoming.map((link) => link.value)).toContain("files");
      expect(condition?.data.links.incoming.map((link) => link.nodeLabel)).not.toContain("n_getFiles");
      expect(condition?.data.links.incoming.some((link) => link.nodeId === "n_getFiles")).toBe(true);
    });
  });

  it("attaches container→child control edges to the matching slot handle", () => {
    const { edges } = toReactFlow(tryGraph(), { mode: "expanded" });
    const body = edges.find((e) => e.id === "n_try->n_charge:control:body");
    const error = edges.find((e) => e.id === "n_try->n_alert:control:error");
    expect(body?.sourceHandle).toBe(slotHandleId("body"));
    expect(error?.sourceHandle).toBe(slotHandleId("catch"));
  });

  it("leaves ordinary edges on the default handles", () => {
    const { edges } = toReactFlow(canonicalGraph(), { mode: "expanded" });
    expect(edges.find((e) => e.id === "n_getNewPRs->n_loop:control:")?.sourceHandle).toBeUndefined();
    // A data edge into a child is not a slot edge, even though the target is nested.
    expect(edges.find((e) => e.id === "n_loop->n_getFiles:data:pr")?.sourceHandle).toBeUndefined();
  });
});

describe("graph index", () => {
  it("treats a dangling parentId as a root", () => {
    const graph = canonicalGraph();
    graph.nodes[3].data["parentId"] = "does-not-exist";
    const index = buildIndex(graph);
    expect(index.parentOf.get("n_getFiles")).toBeNull();
    expect(toReactFlow(graph, { mode: "expanded" }).nodes.find((n) => n.id === "n_getFiles")?.parentId).toBeUndefined();
  });

  it("finds the innermost node owning a source offset", () => {
    const graph = canonicalGraph();
    const loop = graph.nodes[2];
    const nested = graph.nodes[3];
    // Make the loop's range enclose the nested node's range.
    loop.source.start.offset = 0;
    loop.source.end.offset = 1000;
    nested.source.start.offset = 100;
    nested.source.end.offset = 140;

    expect(nodeAtOffset(graph, 120)?.id).toBe("n_getFiles");
    expect(nodeAtOffset(graph, 500)?.id).toBe("n_loop");
    expect(nodeAtOffset(graph, 100_000)).toBeNull();
  });
});
