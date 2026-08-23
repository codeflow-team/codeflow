/**
 * `WorkflowGraph` (+ ELK boxes) → React Flow nodes/edges — 07-ui.md §1, §2.
 *
 * Nesting: a node whose `data.parentId` points at a `loop`/`try` becomes a React
 * Flow child (`parentId` + `extent: "parent"`), and its position is the
 * parent-relative one ELK produced. Parents are emitted before their children,
 * which React Flow requires.
 *
 * Pure and DOM-free so it can be unit-tested without a browser.
 */

import type { Diagnostic, WorkflowGraph, WorkflowNode } from "@codeflow/core";
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
import { measureNode } from "../layout/measure.js";
import {
  EMPTY_DATA_LINKS,
  buildDataLinks,
  type DataEdgeMode,
  type NodeDataLinks,
} from "./data-links.js";

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

  const nodes: CodeFlowRFNode[] = orderedNodes(graph, index).map((node) => {
    const parentId = index.parentOf.get(node.id) ?? null;
    const container = isContainerNode(node, index);
    const box = boxes?.get(node.id);
    const links = dataLinks.get(node.id) ?? EMPTY_DATA_LINKS;
    const fallback = measureNode(node, options.mode, links);

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
      // left below the whole node layer instead of fighting it.
      zIndex: container ? 0 : 20,
      data: {
        node,
        mode: options.mode,
        diagnostics: diagnostics.get(node.id) ?? [],
        slot: parentSlotOf(node),
        container,
        autoWidth: box?.width ?? fallback.width,
        autoHeight: box?.height ?? fallback.height,
        links,
      },
      className: `cf-rf-node cf-rf-node--${node.type}${container ? " cf-rf-node--container" : ""}`,
    };
    if (parentId !== null) {
      rfNode.parentId = parentId;
      rfNode.extent = "parent";
    }
    return rfNode;
  });

  const edges: CodeFlowRFEdge[] = graph.edges.map((edge) => {
    const slotPort = isSlotEdge(edge, index) ? SLOT_PORTS[edge.sourcePort ?? "body"] : undefined;
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
      (index.parentOf.get(edge.source) ?? null) !== (index.parentOf.get(edge.target) ?? null);

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
      source: edge.source,
      target: edge.target,
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
      Object.assign(rfEdge, dataEdgeVisuals(rfEdge.data?.value, dataEdgeState(edge, dataEdges, selected)));
    } else if (edge.label !== undefined) {
      rfEdge.label = edge.label;
    }
    if (slotPort !== undefined) rfEdge.sourceHandle = slotHandleId(slotPort);
    return rfEdge;
  });

  return { nodes, edges, index };
}

function labelModifier(label: string | undefined): string {
  if (label === undefined) return "";
  if (label === "true" || label === "false" || label === "error" || label === "body") {
    return ` cf-rf-edge--${label}`;
  }
  return "";
}
