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
    const { edges } = toReactFlow(graph, { mode: "expanded" });
    expect(edges).toHaveLength(graph.edges.length);

    const trueEdge = edges.find((e) => e.id === "n_condition->n_slack:control:true");
    expect(trueEdge?.label).toBe("true");
    expect(trueEdge?.className).toContain("cf-rf-edge--true");
    expect(trueEdge?.animated).toBe(false);

    const dataEdge = edges.find((e) => e.id === "n_getFiles->n_condition:data:files");
    expect(dataEdge?.label).toBe("files");
    expect(dataEdge?.animated).toBe(true);
    expect(dataEdge?.data?.kind).toBe("data");
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
