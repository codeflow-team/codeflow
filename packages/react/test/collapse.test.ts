/**
 * Folding a big flow down to something a non-developer can read — and the
 * promises that stop it becoming a way of hiding things.
 *
 * The change this file guards is a trade: the canvas stopped fitting every step
 * on screen (101 nodes at zoom 0.41, where a 13px name renders at five pixels
 * and nothing is legible) and started showing fewer, bigger, readable boxes.
 * That is only honest if three things hold, and each has a test here:
 *
 *  1. **the count is true** — "75 steps inside" is every descendant, counted
 *     recursively, not the direct children;
 *  2. **nothing is trapped** — anything that can address a step (the outline,
 *     the caret, a diagnostic, a failed run, a patch) opens the folds between
 *     that step and the canvas;
 *  3. **no edge dangles** — an edge that ended inside a folded box is
 *     re-pointed at the box, never dropped and never left pointing at a node
 *     that is not on the canvas.
 *
 * The fourth test is about judgement rather than mechanics: which boxes a flow
 * arrives folded. Folding the outer `try` of `browser-qa-runner` would hide 80
 * of its 101 steps behind a box labelled "Try", which is an overview of
 * nothing. That case is locked here explicitly.
 */

import { describe, expect, it } from "vitest";
import type { WorkflowEdge, WorkflowGraph, WorkflowNode } from "@codeflow/core";
import {
  FOLD_ABOVE,
  ancestorsOf,
  autoCollapse,
  buildCollapseView,
  expandFor,
  innerCounts,
  insideLabel,
  isSameFlow,
  standIn,
} from "../src/flow/collapse.js";
import { buildIndex } from "../src/graph/index.js";
import { toReactFlow } from "../src/flow/to-react-flow.js";
import { toElkGraph } from "../src/layout/elk-graph.js";
import { measureNode } from "../src/layout/measure.js";
import { canonicalGraph, edge, graphOf, node } from "./fixtures.js";

/**
 * The shape `browser-qa-runner` really has, scaled down but with its ratios
 * intact: one outer `try` holding almost everything, a loop inside it holding
 * almost all of that, and detail loops nested under the loop.
 */
function nestedGraph(bodyPerLoop = 6): WorkflowGraph {
  const nodes: WorkflowNode[] = [
    node({ id: "n_trigger", type: "trigger", label: "Trigger", path: "flow#trigger" }),
    node({ id: "n_try", type: "try", label: "Try", path: "flow/try[0]", data: { hasCatch: true, catchParam: "e" } }),
    node({ id: "n_loop", type: "loop", label: "For Each case in cases", path: "flow/try[0]/for[0]", parentId: "n_try", parentSlot: "body", data: { kind: "forOf", variable: "case", iterable: "cases" } }),
    node({ id: "n_inner", type: "loop", label: "For Each step in steps", path: "flow/try[0]/for[0]/for[0]", parentId: "n_loop", parentSlot: "body", data: { kind: "forOf", variable: "step", iterable: "steps" } }),
    node({ id: "n_out", type: "output", label: "End Flow", path: "flow#output", data: { explicit: false } }),
  ];
  const edges: WorkflowEdge[] = [
    edge("n_trigger", "n_try", "control"),
    edge("n_try", "n_loop", "control", { sourcePort: "body", label: "body" }),
    edge("n_loop", "n_inner", "control", { sourcePort: "body", label: "body" }),
    edge("n_try", "n_out", "control"),
  ];

  // Filler steps in each loop body, chained, with a data edge out to the tail.
  for (const [parent, prefix] of [["n_loop", "c"], ["n_inner", "s"]] as const) {
    let previous: string | null = null;
    for (let i = 0; i < bodyPerLoop; i++) {
      const id = `n_${prefix}${String(i)}`;
      nodes.push(
        node({
          id,
          type: "tool",
          label: `Step ${prefix}${String(i)}`,
          path: `flow/${parent}/call:x[${String(i)}]`,
          parentId: parent,
          parentSlot: "body",
          outputs: [{ id: "v", label: "v" }],
          data: { toolName: "x.y", resolved: true, arguments: {}, argumentsEditable: true, argumentsHaveSpread: false },
        }),
      );
      if (previous !== null) edges.push(edge(previous, id, "control"));
      // Every filler step hands a value to the step *after the whole try*.
      edges.push(edge(id, "n_out", "data", { label: `v${prefix}${String(i)}` }));
      previous = id;
    }
  }
  return graphOf(nodes, edges);
}

describe("innerCounts — the number on a folded box is the true one", () => {
  it("counts every descendant, not the direct children", () => {
    const graph = nestedGraph();
    const index = buildIndex(graph);
    const counts = innerCounts(index);
    // 6 in the inner loop, 6 in the outer loop, plus the inner loop itself.
    expect(counts.get("n_inner")).toBe(6);
    expect(counts.get("n_loop")).toBe(13);
    expect(counts.get("n_try")).toBe(14);
    // And that is exactly what the label says.
    expect(insideLabel(counts.get("n_loop") ?? 0)).toBe("13 steps inside");
    expect(insideLabel(1)).toBe("1 step inside");
  });

  it("agrees with the graph: folded steps + drawn steps = every step", () => {
    const graph = nestedGraph();
    const index = buildIndex(graph);
    const view = buildCollapseView(index, new Set(["n_loop"]));
    const { nodes } = toReactFlow(graph, { mode: "expanded", collapse: view });
    expect(view.innerCount.get("n_loop")).toBe(view.hidden.size);
    expect(nodes.length + view.hidden.size).toBe(graph.nodes.length);
  });
});

describe("autoCollapse — which boxes a flow arrives folded", () => {
  it("folds nothing at all on a flow small enough to read whole", () => {
    const graph = canonicalGraph();
    expect(graph.nodes.length).toBeLessThanOrEqual(FOLD_ABOVE);
    expect(autoCollapse(buildIndex(graph)).size).toBe(0);
  });

  it("refuses to fold the `try` that wraps most of the flow", () => {
    // 41 nodes: past the threshold, with a try holding 39 of them.
    const graph = nestedGraph(18);
    const index = buildIndex(graph);
    expect(graph.nodes.length).toBeGreaterThan(FOLD_ABOVE);
    expect(innerCounts(index).get("n_try")).toBeGreaterThan(graph.nodes.length * 0.5);

    const folded = autoCollapse(index);
    // "Try — 38 steps inside" is an overview of nothing; the loop inside it is
    // the box that reads as a sentence, so that is the one that folds.
    expect(folded.has("n_try")).toBe(false);
    expect(folded.has("n_loop")).toBe(true);

    const view = buildCollapseView(index, folded);
    // The spine survives: trigger, try, the folded loop, and the tail.
    const visible = graph.nodes.filter((candidate) => !view.hidden.has(candidate.id));
    expect(visible.map((candidate) => candidate.id)).toContain("n_trigger");
    expect(visible.map((candidate) => candidate.id)).toContain("n_try");
    expect(visible.map((candidate) => candidate.id)).toContain("n_out");
    expect(visible.length).toBeLessThan(graph.nodes.length / 2);
  });

  it("pre-folds the boxes nested inside a fold, so opening one is a step and not a dump", () => {
    const folded = autoCollapse(buildIndex(nestedGraph(18)));
    expect(folded.has("n_loop")).toBe(true);
    expect(folded.has("n_inner")).toBe(true);
  });

  it("leaves a container too small to be worth folding alone", () => {
    const graph = nestedGraph(18);
    const index = buildIndex(graph);
    expect(autoCollapse(index, { minInner: 100 }).size).toBe(0);
  });
});

describe("nothing is trapped behind a fold", () => {
  it("opens exactly the folds between a step and the canvas, and no others", () => {
    const index = buildIndex(nestedGraph());
    const collapsed = new Set(["n_loop", "n_inner"]);
    const opened = expandFor("n_s0", index, collapsed);
    expect(opened).not.toBeNull();
    expect([...(opened ?? [])]).toEqual([]);

    // A step that is already on the canvas costs nothing — `null` means "no
    // change", which is what keeps a selection from re-running the layout.
    expect(expandFor("n_trigger", index, collapsed)).toBeNull();
  });

  it("opens only the ancestors it has to", () => {
    const index = buildIndex(nestedGraph());
    const opened = expandFor("n_c0", index, new Set(["n_try", "n_loop", "n_inner"]));
    // `n_c0` sits in the outer loop: the inner loop stays folded.
    expect([...(opened ?? [])].sort()).toEqual(["n_inner"]);
  });

  it("knows the chain a step sits inside", () => {
    const index = buildIndex(nestedGraph());
    expect(ancestorsOf("n_s0", index)).toEqual(["n_inner", "n_loop", "n_try"]);
    expect(ancestorsOf("n_trigger", index)).toEqual([]);
  });

  it("keeps folds across a re-analysis of the same flow, and drops them for a different one", () => {
    const graph = nestedGraph();
    expect(isSameFlow(graph, graph)).toBe(true);
    expect(isSameFlow(null, graph)).toBe(false);
    expect(isSameFlow(undefined, graph)).toBe(false);
    // Two different flows that happen to share their synthetic trigger/end.
    expect(isSameFlow(canonicalGraph(), graph)).toBe(false);
  });
});

describe("a folded box takes its edges with it", () => {
  const view = (ids: string[], graph: WorkflowGraph = nestedGraph()) =>
    buildCollapseView(buildIndex(graph), new Set(ids));

  it("re-points an edge that ended inside the box at the box", () => {
    const graph = nestedGraph();
    const collapse = view(["n_loop"], graph);
    const { nodes, edges } = toReactFlow(graph, { mode: "expanded", collapse, dataEdges: "all" });
    const ids = new Set(nodes.map((candidate) => candidate.id));

    // The promise: every drawn edge connects two boxes that are on the canvas.
    for (const drawn of edges) {
      expect(ids.has(drawn.source)).toBe(true);
      expect(ids.has(drawn.target)).toBe(true);
    }
    // And the six `v… → End Flow` data edges become one line from the box.
    const toOut = edges.filter((drawn) => drawn.target === "n_out" && drawn.data?.kind === "data");
    expect(toOut).toHaveLength(1);
    expect(toOut[0].source).toBe("n_loop");
  });

  it("drops an edge whose two ends are both inside the same folded box", () => {
    const graph = nestedGraph();
    const collapse = view(["n_loop"], graph);
    const { edges } = toReactFlow(graph, { mode: "expanded", collapse, dataEdges: "all" });
    // `n_c0 → n_c1` has nothing left to say once the box holding both is shut.
    expect(edges.some((drawn) => drawn.id.startsWith("n_c0->n_c1"))).toBe(false);
  });

  it("still reveals the folded box's own values when it is the selected step", () => {
    const graph = nestedGraph();
    const collapse = view(["n_loop"], graph);
    const { edges } = toReactFlow(graph, {
      mode: "compact",
      collapse,
      dataEdges: "selected",
      selectedNodeId: "n_loop",
    });
    const shown = edges.filter((drawn) => drawn.data?.kind === "data" && drawn.hidden !== true);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((drawn) => drawn.source === "n_loop" || drawn.target === "n_loop")).toBe(true);
  });

  it("hands ELK a leaf where the folded box is, not a subtree", () => {
    const graph = nestedGraph();
    const collapse = view(["n_loop"], graph);
    const { root } = toElkGraph(graph, { mode: "expanded", collapse });
    const find = (id: string, where = root): { children?: unknown[]; width?: number } | null => {
      for (const child of (where.children ?? []) as { id: string; children?: unknown[] }[]) {
        if (child.id === id) return child;
        const deeper = find(id, child as typeof root);
        if (deeper !== null) return deeper;
      }
      return null;
    };
    const loop = find("n_loop");
    expect(loop).not.toBeNull();
    expect(loop?.children ?? []).toHaveLength(0);
    // Sized as a card — the whole saving is that it is no longer sized by its
    // contents.
    expect(loop?.width).toBeGreaterThan(0);
    expect(find("n_c0")).toBeNull();
  });

  it("sizes a folded box with room for the line that says how much is inside", () => {
    const graph = nestedGraph();
    const loop = graph.nodes.find((candidate) => candidate.id === "n_loop") as WorkflowNode;
    const open = measureNode(loop, "expanded", null, null);
    const shut = measureNode(loop, "expanded", null, 13);
    expect(shut.height).toBeGreaterThan(open.height);
    expect(shut.width).toBeGreaterThanOrEqual(open.width);
  });
});

describe("standIn — who is on the canvas in a step's place", () => {
  it("names the outermost folded ancestor, not the nearest one", () => {
    const index = buildIndex(nestedGraph());
    const collapse = buildCollapseView(index, new Set(["n_loop", "n_inner"]));
    expect(standIn(collapse, "n_s0")).toBe("n_loop");
    expect(standIn(collapse, "n_trigger")).toBe("n_trigger");
  });

  it("ignores a fold on something that is not a container any more", () => {
    const index = buildIndex(nestedGraph());
    const collapse = buildCollapseView(index, new Set(["n_trigger", "gone"]));
    expect(collapse.collapsed.size).toBe(0);
    expect(collapse.hidden.size).toBe(0);
  });
});
