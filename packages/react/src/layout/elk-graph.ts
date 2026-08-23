/**
 * `WorkflowGraph` → ELK graph — 07-ui.md §1.
 *
 * ELK is used **hierarchically**: a `loop`/`try` node becomes an ELK node with
 * `children`, so ELK sizes the container from its contents and returns child
 * positions relative to the container. That is exactly React Flow's parent/child
 * model, which is why the two fit together without a coordinate pass.
 *
 * Layout never touches semantics (07 §1) and positions are never persisted
 * (03 §8) — this module only produces ELK input.
 */

import type { EdgeKind, WorkflowGraph } from "@codeflow/core";
import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api.js";
import { buildIndex, isSlotEdge, type GraphIndex } from "../graph/index.js";
import type { DisclosureMode } from "../flow/summary.js";
import { CONTAINER_MIN_SIZE, CONTAINER_PADDING, measureNode, type Measurer } from "./measure.js";

export type LayoutDirection = "DOWN" | "RIGHT";

export interface ElkGraphOptions {
  mode: DisclosureMode;
  direction?: LayoutDirection;
  /**
   * Edge kinds that influence placement. Control edges only by default: data
   * edges mostly run parallel to them and would only add crossings.
   */
  edgeKinds?: readonly EdgeKind[];
  measure?: Measurer;
  index?: GraphIndex;
}

export interface ElkGraphResult {
  root: ElkNode;
  /**
   * Edges left out of the layout because their endpoints sit in different
   * containers. React Flow still draws them; they just do not steer ELK.
   */
  skippedEdgeIds: string[];
  index: GraphIndex;
}

export const ROOT_ID = "__codeflow_root__";

function baseOptions(direction: LayoutDirection): Record<string, string> {
  return {
    "elk.algorithm": "layered",
    "elk.direction": direction,
    "elk.layered.spacing.nodeNodeBetweenLayers": "48",
    "elk.spacing.nodeNode": "32",
    "elk.layered.spacing.edgeNodeBetweenLayers": "24",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
  };
}

/**
 * A container is sized by ELK from its children, never the other way round: the
 * box grows to hold what is inside it, so a `for`/`while`/`try` can always be
 * read as a structure rather than as a lid pressed onto its contents.
 *
 * Three things keep it legible:
 *
 * - the top inset follows the container's *own* header (title, caption, and for
 *   a `while` its condition row), because a fixed inset lets the first child
 *   ride up over the header of a taller one;
 * - the inside is spaced more generously than the top level — nesting is what
 *   makes a diagram hard to read, so the deeper level gets the extra air;
 * - the minimum is the header's own size plus padding, so an empty or very
 *   small body still reads as a container and not as a label.
 */
function containerOptions(direction: LayoutDirection, own: { width: number; height: number }): Record<string, string> {
  const { left, bottom, right } = CONTAINER_PADDING;
  const top = Math.max(CONTAINER_PADDING.top, Math.round(own.height + 16));
  const minWidth = Math.max(CONTAINER_MIN_SIZE.width, Math.round(own.width + left + right));
  const minHeight = Math.max(CONTAINER_MIN_SIZE.height, Math.round(own.height + top + bottom));
  return {
    ...baseOptions(direction),
    "elk.layered.spacing.nodeNodeBetweenLayers": "54",
    "elk.spacing.nodeNode": "38",
    "elk.padding": `[top=${String(top)},left=${String(left)},bottom=${String(bottom)},right=${String(right)}]`,
    "elk.nodeSize.constraints": "MINIMUM_SIZE",
    "elk.nodeSize.minimum": `(${String(minWidth)},${String(minHeight)})`,
  };
}

/**
 * Build the ELK input tree for `graph`.
 *
 * Edge placement rule: an edge lives in the container that holds *both* of its
 * endpoints. Container→own-child edges (the `body`/`error` slot edges) and any
 * edge crossing a container boundary are reported in `skippedEdgeIds` instead of
 * being handed to ELK — hierarchy-crossing edges need `INCLUDE_CHILDREN` and buy
 * nothing here, since the children are already ordered by their internal edges.
 */
export function toElkGraph(graph: WorkflowGraph, options: ElkGraphOptions): ElkGraphResult {
  const direction = options.direction ?? "DOWN";
  const measure = options.measure ?? measureNode;
  const kinds = options.edgeKinds ?? (["control"] as const);
  const index = options.index ?? buildIndex(graph);

  const elkById = new Map<string, ElkNode>();

  const build = (parent: string | null): ElkNode[] => {
    const children = index.childrenOf.get(parent) ?? [];
    return children.map((node) => {
      const own = build(node.id);
      const elk: ElkNode =
        own.length > 0
          ? {
              id: node.id,
              children: own,
              edges: [],
              layoutOptions: containerOptions(direction, measure(node, options.mode)),
            }
          : { id: node.id, ...measure(node, options.mode) };
      elkById.set(node.id, elk);
      return elk;
    });
  };

  const root: ElkNode = {
    id: ROOT_ID,
    layoutOptions: baseOptions(direction),
    children: build(null),
    edges: [],
  };
  elkById.set(ROOT_ID, root);

  const skippedEdgeIds: string[] = [];
  for (const edge of graph.edges) {
    if (!kinds.includes(edge.kind)) {
      skippedEdgeIds.push(edge.id);
      continue;
    }
    if (isSlotEdge(edge, index)) {
      // Container → its own child: the child is already inside the container.
      skippedEdgeIds.push(edge.id);
      continue;
    }
    const sourceParent = index.parentOf.get(edge.source) ?? null;
    const targetParent = index.parentOf.get(edge.target) ?? null;
    if (sourceParent !== targetParent) {
      skippedEdgeIds.push(edge.id);
      continue;
    }
    const container = elkById.get(sourceParent ?? ROOT_ID);
    if (container === undefined) {
      skippedEdgeIds.push(edge.id);
      continue;
    }
    const elkEdge: ElkExtendedEdge = { id: edge.id, sources: [edge.source], targets: [edge.target] };
    (container.edges ??= []).push(elkEdge);
  }

  return { root, skippedEdgeIds, index };
}

export interface LayoutBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Flatten a laid-out ELK tree into per-node boxes (coordinates stay parent-relative). */
export function collectLayout(root: ElkNode): Map<string, LayoutBox> {
  const out = new Map<string, LayoutBox>();
  const walk = (node: ElkNode): void => {
    for (const child of node.children ?? []) {
      out.set(child.id, {
        x: child.x ?? 0,
        y: child.y ?? 0,
        width: child.width ?? 0,
        height: child.height ?? 0,
      });
      walk(child);
    }
  };
  walk(root);
  return out;
}
