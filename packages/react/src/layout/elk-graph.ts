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
   * Graph edges that were not handed to ELK **as themselves**: data edges, the
   * container→child slot edges, and the hierarchy-crossing ones (those are
   * represented by a proxy between their nearest sibling ancestors instead —
   * see `proxyEndpoints`). React Flow still draws all of them exactly as the
   * graph states them; this list only says what did not steer the layout
   * directly.
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
function containerOptions(
  direction: LayoutDirection,
  own: { width: number; height: number },
  /** How many containers this one sits inside — 0 at the top level. */
  depth: number,
): Record<string, string> {
  // Nesting is what makes a diagram hard to read: two frames a few pixels apart
  // stop reading as "inside", so each level buys itself a little more air.
  const extra = Math.min(depth, 3) * 6;
  const left = CONTAINER_PADDING.left + extra;
  const right = CONTAINER_PADDING.right + extra;
  const bottom = CONTAINER_PADDING.bottom + extra;
  const top = Math.max(CONTAINER_PADDING.top, Math.round(own.height + 16)) + extra;

  const minWidth = Math.max(CONTAINER_MIN_SIZE.width, Math.round(own.width + left + right));
  const minHeight = Math.max(CONTAINER_MIN_SIZE.height, Math.round(own.height + top + bottom));
  return {
    ...baseOptions(direction),
    "elk.layered.spacing.nodeNodeBetweenLayers": String(54 + extra),
    "elk.spacing.nodeNode": String(38 + extra),
    "elk.padding": `[top=${String(top)},left=${String(left)},bottom=${String(bottom)},right=${String(right)}]`,
    "elk.nodeSize.constraints": "MINIMUM_SIZE",
    "elk.nodeSize.minimum": `(${String(minWidth)},${String(minHeight)})`,
  };
}

/** Chain from a node up to the root: `[node, parent, grandparent, …]`. */
function ancestorChain(nodeId: string, index: GraphIndex): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null = nodeId;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = index.parentOf.get(current) ?? null;
  }
  return chain;
}

/**
 * Where an edge should be *projected* so ELK can order its endpoints.
 *
 * ELK only orders siblings, so an edge whose ends live at different depths —
 * `return charge` inside a `try` flowing on to the `return null` that follows
 * the whole `try` — has nothing to say to it. Dropping such an edge is what put
 * the second `End Flow` in layer 0, top-left of the diagram, with a long
 * looping line back down to it: nothing told ELK that the step comes *after*
 * the `try`.
 *
 * So the edge is not dropped, it is lifted: walk both ends up their parent
 * chains until they are siblings, and give ELK an edge between that pair. The
 * real edge is still drawn between the real endpoints — the projection exists
 * only to state the ordering the picture depends on.
 *
 * Returns `null` when both ends lift to the same node (one contains the other,
 * e.g. a container's own slot edge): an edge from a node to itself would tell
 * ELK nothing and risks a self-loop.
 */
function proxyEndpoints(
  source: string,
  target: string,
  index: GraphIndex,
): { container: string | null; source: string; target: string } | null {
  const parentOf = (id: string): string | null => index.parentOf.get(id) ?? null;

  // Chains are strictly ascending, so a parent identifies at most one entry.
  const byParent = new Map<string | null, string>();
  for (const id of ancestorChain(target, index)) byParent.set(parentOf(id), id);

  // Deepest first: the first shared parent is the nearest common container.
  for (const candidate of ancestorChain(source, index)) {
    const sibling = byParent.get(parentOf(candidate));
    if (sibling === undefined) continue;
    return candidate === sibling ? null : { container: parentOf(candidate), source: candidate, target: sibling };
  }
  return null;
}

/**
 * Build the ELK input tree for `graph`.
 *
 * Edge placement rule: an edge is laid out in the container that holds both of
 * its endpoints. Container→own-child edges (the `body`/`error` slot edges) are
 * left out — the child is already inside the box. An edge that crosses a
 * container boundary is projected onto the nearest pair of siblings instead of
 * being dropped (`proxyEndpoints`), so a step that follows a `for`/`while`/`try`
 * is laid out after it rather than floating off on its own.
 */
export function toElkGraph(graph: WorkflowGraph, options: ElkGraphOptions): ElkGraphResult {
  const direction = options.direction ?? "DOWN";
  const measure = options.measure ?? measureNode;
  const kinds = options.edgeKinds ?? (["control"] as const);
  const index = options.index ?? buildIndex(graph);

  const elkById = new Map<string, ElkNode>();

  const build = (parent: string | null, depth: number): ElkNode[] => {
    const children = index.childrenOf.get(parent) ?? [];
    return children.map((node) => {
      const own = build(node.id, depth + 1);
      const elk: ElkNode =
        own.length > 0
          ? {
              id: node.id,
              children: own,
              edges: [],
              layoutOptions: containerOptions(direction, measure(node, options.mode), depth),
            }
          : { id: node.id, ...measure(node, options.mode) };
      elkById.set(node.id, elk);
      return elk;
    });
  };

  const root: ElkNode = {
    id: ROOT_ID,
    layoutOptions: baseOptions(direction),
    children: build(null, 0),
    edges: [],
  };
  elkById.set(ROOT_ID, root);

  const skippedEdgeIds: string[] = [];
  /** One projection per sibling pair — many edges can lift onto the same one. */
  const projected = new Set<string>();

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

    const lifted = proxyEndpoints(edge.source, edge.target, index);
    if (lifted === null) {
      skippedEdgeIds.push(edge.id);
      continue;
    }
    const container = elkById.get(lifted.container ?? ROOT_ID);
    if (container === undefined) {
      skippedEdgeIds.push(edge.id);
      continue;
    }

    const direct = lifted.source === edge.source && lifted.target === edge.target;
    if (direct) {
      (container.edges ??= []).push({ id: edge.id, sources: [edge.source], targets: [edge.target] });
      continue;
    }

    // Crossed a boundary: ELK gets the projection, and the real edge is
    // reported as not laid out directly.
    skippedEdgeIds.push(edge.id);
    const proxyId = `proxy:${lifted.source}->${lifted.target}`;
    if (projected.has(proxyId)) continue;
    projected.add(proxyId);
    const elkEdge: ElkExtendedEdge = { id: proxyId, sources: [lifted.source], targets: [lifted.target] };
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
