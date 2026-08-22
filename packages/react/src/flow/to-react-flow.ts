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
import type { Edge, Node } from "@xyflow/react";
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

export const NODE_TYPE_LEAF = "codeflowNode";
export const NODE_TYPE_CONTAINER = "codeflowContainer";

export interface CodeFlowNodeData extends Record<string, unknown> {
  node: WorkflowNode;
  mode: DisclosureMode;
  diagnostics: Diagnostic[];
  /** Slot this node sits in inside its parent container: body / catch / finally. */
  slot: string | null;
  container: boolean;
}

export interface CodeFlowEdgeData extends Record<string, unknown> {
  kind: "control" | "data";
  sourcePort?: string;
  targetPort?: string;
}

export type CodeFlowRFNode = Node<CodeFlowNodeData>;
export type CodeFlowRFEdge = Edge<CodeFlowEdgeData>;

export interface ToReactFlowOptions {
  mode: DisclosureMode;
  boxes?: Map<string, LayoutBox> | null;
  diagnostics?: Map<string, Diagnostic[]>;
  index?: GraphIndex;
  selectedNodeId?: string | null;
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

  const nodes: CodeFlowRFNode[] = orderedNodes(graph, index).map((node) => {
    const parentId = index.parentOf.get(node.id) ?? null;
    const container = isContainerNode(node, index);
    const box = boxes?.get(node.id);
    const fallback = measureNode(node, options.mode);

    const rfNode: CodeFlowRFNode = {
      id: node.id,
      type: container ? NODE_TYPE_CONTAINER : NODE_TYPE_LEAF,
      position: { x: box?.x ?? 0, y: box?.y ?? 0 },
      width: box?.width ?? fallback.width,
      height: box?.height ?? fallback.height,
      selected: selected === node.id,
      draggable: true,
      data: {
        node,
        mode: options.mode,
        diagnostics: diagnostics.get(node.id) ?? [],
        slot: parentSlotOf(node),
        container,
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
    const rfEdge: CodeFlowRFEdge = {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: edge.kind === "data" ? "default" : "smoothstep",
      animated: edge.kind === "data",
      label: edge.label,
      zIndex: 1200,
      className: `cf-rf-edge cf-rf-edge--${edge.kind}${labelModifier(edge.label)}`,
      data: {
        kind: edge.kind,
        ...(edge.sourcePort === undefined ? {} : { sourcePort: edge.sourcePort }),
        ...(edge.targetPort === undefined ? {} : { targetPort: edge.targetPort }),
      },
    };
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
