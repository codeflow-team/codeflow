/**
 * `WorkflowGraph` (+ ELK boxes) → React Flow nodes/edges — 07-ui.md §1, §2.
 *
 * Nesting: a node whose `data.parentId` points at a `loop`/`try` becomes a React
 * Flow child (`parentId` + `extent: "parent"`), and its position is the
 * parent-relative one ELK produced. Parents are emitted before their children,
 * which React Flow requires.
 *
 * Folding (`flow/collapse.ts`) works on the same pass: a folded container's
 * children are not emitted at all, and every edge that ended inside one is
 * re-pointed at the box that now stands for it — so the spine stays continuous
 * and no line dangles into a node that is not on the canvas.
 *
 * Pure and DOM-free so it can be unit-tested without a browser.
 */

import type { Diagnostic, WorkflowGraph, WorkflowNode } from "@codeflow-team/core";
import { MarkerType, type Edge, type Node } from "@xyflow/react";
import {
  SLOT_PORTS,
  buildIndex,
  diagnosticsByNode,
  isContainerNode,
  isSlotEdge,
  orderedNodes,
  parentSlotOf,
  type ContainerSlot,
  type GraphIndex,
} from "../graph/index.js";
import type { DisclosureMode } from "./summary.js";
import type { LayoutBox } from "../layout/elk-graph.js";
import { measureNode, type Measurer } from "../layout/measure.js";
import {
  EMPTY_DATA_LINKS,
  buildDataLinks,
  type DataEdgeMode,
  type NodeDataLinks,
} from "./data-links.js";
import { EMPTY_COLLAPSE, standIn, type CollapseView } from "./collapse.js";

export const NODE_TYPE_LEAF = "codeflowNode";
export const NODE_TYPE_CONTAINER = "codeflowContainer";

export interface CodeFlowNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  mode: DisclosureMode;
  diagnostics: Diagnostic[];
  /** Slot this node sits in inside its parent container: body / catch / finally. */
  slot: string | null;
  container: boolean;
  /**
   * The size layout worked out for this node.
   *
   * A container can be dragged bigger to give a cramped body room to breathe;
   * this is the floor it can never go under, because anything smaller would clip
   * the very structure the box exists to show. Purely visual, like position
   * (03 §8) — the next layout run replaces it.
   */
  autoWidth: number;
  autoHeight: number;
  /**
   * The values this step takes from other steps and hands to them.
   *
   * Carried on the node because the dashed data edges are hidden by default:
   * the card restates every hidden line in words (`Takes  rows ← Read Text
   * File`), which is what makes hiding them a decluttering rather than a
   * deletion of information.
   */
  links: NodeDataLinks;
  /**
   * Steps folded inside this container, or `null` when nothing is folded here.
   *
   * The number is the truth — every descendant, counted recursively — because
   * the whole bargain of folding is that the box says how much it is standing
   * for. `0` never appears: an empty container is not worth folding.
   */
  collapsedInner: number | null;
}

export interface CodeFlowEdgeData extends Record<string, unknown> {
  kind: "control" | "data";
  sourcePort?: string;
  targetPort?: string;
  /**
   * The value a data edge carries, kept here rather than only on `label`.
   *
   * The label is *shown* only while the edge is focused, and focus changes on
   * every click without re-mapping the graph — so the name has to live
   * somewhere the re-application can read it back from.
   */
  value?: string;
}

export type CodeFlowRFNode = Node<CodeFlowNodeData>;
export type CodeFlowRFEdge = Edge<CodeFlowEdgeData>;

export interface ToReactFlowOptions {
  mode: DisclosureMode;
  boxes?: Map<string, LayoutBox> | null;
  diagnostics?: Map<string, Diagnostic[]>;
  index?: GraphIndex;
  selectedNodeId?: string | null;
  /** How much of the data layer to draw. Defaults to `selected` (07 §4). */
  dataEdges?: DataEdgeMode;
  dataLinks?: Map<string, NodeDataLinks>;
  /** Folded containers — see `flow/collapse.ts`. Nothing folded by default. */
  collapse?: CollapseView;
  /**
   * How a node is sized when ELK has not produced a box for it yet.
   *
   * Defaults to `measureNode`. The canvas passes `rendererMeasurer(registry)`
   * so a node drawn by a registered renderer (`flow/renderer.ts`) gets the same
   * size here that layout gave it — one measurer, two callers, no drift.
   */
  measure?: Measurer;
}

/**
 * Whether one data edge is drawn, and whether it is the one being looked at.
 *
 * Exported because the canvas re-applies it on selection change without
 * re-mapping the whole graph — a click must not cost a full remap of 101 nodes.
 */
export function dataEdgeState(
  edge: { source: string; target: string },
  mode: DataEdgeMode,
  selectedNodeId: string | null,
): { hidden: boolean; focused: boolean } {
  const touchesSelection =
    selectedNodeId !== null && (edge.source === selectedNodeId || edge.target === selectedNodeId);
  if (mode === "all") return { hidden: false, focused: touchesSelection };
  if (mode === "none") return { hidden: true, focused: false };
  return { hidden: !touchesSelection, focused: touchesSelection };
}

/** Class list for a data edge in a given state — kept next to `dataEdgeState`. */
export function dataEdgeClassName(focused: boolean): string {
  return `cf-rf-edge cf-rf-edge--data${focused ? " cf-rf-edge--data-focus" : ""}`;
}

/**
 * Everything about a data edge that changes when focus does.
 *
 * One function, used both when the graph is first mapped and when a click moves
 * the focus — two copies of this would drift, and the drift would show as an
 * edge that is visible but styled as if it were not.
 *
 * The label only rides along when the edge is focused: in the "show everything"
 * view there are 172 of these, and 172 value names printed across the diagram is
 * a second thicket on top of the one being cleared.
 */
export function dataEdgeVisuals(
  value: string | undefined,
  state: { hidden: boolean; focused: boolean },
): Pick<CodeFlowRFEdge, "hidden" | "className" | "animated" | "zIndex" | "label" | "markerEnd"> {
  return {
    hidden: state.hidden,
    className: dataEdgeClassName(state.focused),
    // A marching dash on every value in the flow is motion with nothing to say.
    animated: state.focused,
    // A focused edge has to clear the translucent container frames it crosses,
    // but still pass under the leaf cards (zIndex 20) so no line is ever drawn
    // over a step's name.
    zIndex: state.focused ? 10 : 0,
    label: state.focused ? value : undefined,
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: state.focused ? 13 : 9,
      height: state.focused ? 13 : 9,
      color: state.focused ? "var(--cf-accent)" : "var(--cf-border)",
    },
  };
}

export interface ToReactFlowResult {
  nodes: CodeFlowRFNode[];
  edges: CodeFlowRFEdge[];
  index: GraphIndex;
}

/** Container source handle id for a slot — must match what the container renders. */
export function slotHandleId(slot: ContainerSlot): string {
  return `slot:${slot}`;
}

export function toReactFlow(graph: WorkflowGraph, options: ToReactFlowOptions): ToReactFlowResult {
  const index = options.index ?? buildIndex(graph);
  const diagnostics = options.diagnostics ?? diagnosticsByNode(graph);
  const boxes = options.boxes ?? null;
  const selected = options.selectedNodeId ?? null;
  const dataEdges = options.dataEdges ?? "selected";
  const dataLinks = options.dataLinks ?? buildDataLinks(graph, index);
  const collapse = options.collapse ?? EMPTY_COLLAPSE;
  const measure = options.measure ?? measureNode;

  const nodes: CodeFlowRFNode[] = orderedNodes(graph, index)
    // Everything inside a folded container: not drawn, because the box it is in
    // is now standing for it. `expandFor` is how anything gets back to it.
    .filter((node) => !collapse.hidden.has(node.id))
    .map((node) => {
    const parentId = index.parentOf.get(node.id) ?? null;
    const container = isContainerNode(node, index);
    const folded = collapse.collapsed.has(node.id);
    const collapsedInner = folded ? collapse.innerCount.get(node.id) ?? 0 : null;
    const box = boxes?.get(node.id);
    const links = dataLinks.get(node.id) ?? EMPTY_DATA_LINKS;
    const fallback = measure(node, options.mode, links, collapsedInner);

    const rfNode: CodeFlowRFNode = {
      id: node.id,
      type: container ? NODE_TYPE_CONTAINER : NODE_TYPE_LEAF,
      position: { x: box?.x ?? 0, y: box?.y ?? 0 },
      width: box?.width ?? fallback.width,
      height: box?.height ?? fallback.height,
      selected: selected === node.id,
      draggable: true,
      // Stacking order is what keeps the picture readable: leaf cards sit on
      // top so no line is ever drawn across a step's title, while a container
      // stays at the bottom. A container's fill is translucent (styles.css), so
      // the edges underneath it still read through — which is why they can be
      // left below the whole node layer instead of fighting it. A *folded*
      // container has nothing on top of it any more, so it joins the card
      // layer — otherwise a data edge would be drawn across its title.
      zIndex: container && !folded ? 0 : 20,
      data: {
        node,
        mode: options.mode,
        diagnostics: diagnostics.get(node.id) ?? [],
        slot: parentSlotOf(node),
        container,
        autoWidth: box?.width ?? fallback.width,
        autoHeight: box?.height ?? fallback.height,
        links,
        collapsedInner,
      },
      className:
        `cf-rf-node cf-rf-node--${node.type}` +
        (container ? " cf-rf-node--container" : "") +
        (folded ? " cf-rf-node--collapsed" : ""),
    };
    if (parentId !== null) {
      rfNode.parentId = parentId;
      rfNode.extent = "parent";
    }
    return rfNode;
  });

  const edges: CodeFlowRFEdge[] = [];
  /*
   * Two graph edges can land on the same pair of boxes once a container is
   * folded — six steps inside it all feeding the step after it become six
   * copies of one line. Drawing them stacked would thicken the stroke and put
   * six arrowheads in one place, which reads as a heavier relationship than the
   * flow has. The first is kept; the rest are the same statement.
   *
   * A *control* edge keeps its label in the key, because `true` / `false` /
   * `error` / `body` is the one place the diagram says which way the flow goes
   * and two branches must never merge into one line. A data edge's label is
   * already dropped when the line crosses a container frame (below), so there
   * is nothing left for it to distinguish.
   */
  const drawn = new Set<string>();

  for (const edge of graph.edges) {
    const source = standIn(collapse, edge.source);
    const target = standIn(collapse, edge.target);
    // Both ends inside the same folded box: the box is the statement now.
    if (source === target) continue;
    const rerouted = source !== edge.source || target !== edge.target;
    const key = `${source} ${target} ${edge.kind} ${edge.kind === "control" ? edge.label ?? "" : ""}`;
    if (rerouted && drawn.has(key)) continue;
    drawn.add(key);

    const slotPort =
      !rerouted && isSlotEdge(edge, index) ? SLOT_PORTS[edge.sourcePort ?? "body"] : undefined;
    /**
     * A data edge that runs into (or out of) a container gets its label
     * dropped.
     *
     * Its midpoint lands on the container's frame, right over the title of the
     * `for`/`while`/`try` — and the value it names is already written on both
     * ends: the source node's "Gives" row and the target's own field. A branch
     * label (`true`, `false`, `error`, `body`) is never dropped: that one is the
     * only place the diagram says which way the flow goes.
     */
    const crossesFrame =
      edge.kind === "data" &&
      (index.parentOf.get(source) ?? null) !== (index.parentOf.get(target) ?? null);

    /*
     * The data layer is drawn on demand, not by default.
     *
     * On the flows this product exists for that is 131–172 dashed lines against
     * 89–114 control ones, and two thirds of the dashed ones cross a container
     * frame — so they are routed straight across the whole diagram and bury the
     * one thing a non-developer reads a flow for: what happens, and in what
     * order. Hidden here, restated in words on the node (`data.links`), and
     * drawn in full the moment a step is selected or the toggle is on.
     */
    const rfEdge: CodeFlowRFEdge = {
      id: edge.id,
      source,
      target,
      type: edge.kind === "data" ? "default" : "smoothstep",
      animated: false,
      zIndex: 0,
      className: `cf-rf-edge cf-rf-edge--${edge.kind}${labelModifier(edge.label)}`,
      data: {
        kind: edge.kind,
        ...(edge.sourcePort === undefined ? {} : { sourcePort: edge.sourcePort }),
        ...(edge.targetPort === undefined ? {} : { targetPort: edge.targetPort }),
        ...(edge.kind === "data" && !crossesFrame && edge.label !== undefined
          ? { value: edge.label }
          : {}),
      },
    };
    if (edge.kind === "data") {
      Object.assign(
        rfEdge,
        dataEdgeVisuals(rfEdge.data?.value, dataEdgeState({ source, target }, dataEdges, selected)),
      );
    } else if (edge.label !== undefined) {
      rfEdge.label = edge.label;
    }
    if (slotPort !== undefined) rfEdge.sourceHandle = slotHandleId(slotPort);
    edges.push(rfEdge);
  }

  return { nodes, edges, index };
}

function labelModifier(label: string | undefined): string {
  if (label === undefined) return "";
  if (label === "true" || label === "false" || label === "error" || label === "body") {
    return ` cf-rf-edge--${label}`;
  }
  return "";
}
