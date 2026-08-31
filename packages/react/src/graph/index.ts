/**
 * Read-only helpers over a `WorkflowGraph`.
 *
 * Nothing here mutates the graph — the graph is a projection of source
 * (00 §2.1), and the UI layer only ever derives view state from it (03 §8).
 */

import type { Diagnostic, NodeType, WorkflowEdge, WorkflowGraph, WorkflowNode } from "@codeflow-team/core";
import { rangeLength } from "@codeflow-team/core";

/** Node types that always own a subgraph — the only containers the analyzer emits. */
export const CONTAINER_NODE_TYPES: readonly NodeType[] = ["loop", "try"];

/** Slots a container can hold children in — mirrors `frame.parentSlot` in the analyzer. */
export const CONTAINER_SLOTS = ["body", "catch", "finally"] as const;
export type ContainerSlot = (typeof CONTAINER_SLOTS)[number];

/** Container ports that get their own source handle on the container node. */
export const SLOT_PORTS: Record<string, ContainerSlot> = {
  body: "body",
  error: "catch",
  finally: "finally",
};

export function parentIdOf(node: WorkflowNode): string | null {
  const value = node.data["parentId"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parentSlotOf(node: WorkflowNode): string | null {
  const value = node.data["parentSlot"];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function stringData(node: WorkflowNode, key: string): string | null {
  const value = node.data[key];
  return typeof value === "string" ? value : null;
}

export interface GraphIndex {
  nodeById: Map<string, WorkflowNode>;
  /** Children keyed by parent id; roots live under `null`. Graph order preserved. */
  childrenOf: Map<string | null, WorkflowNode[]>;
  /** Nodes that actually hold children (a `try` with an empty body is not a container). */
  containerIds: Set<string>;
  /** Effective parent — `null` when `data.parentId` points at a node outside the graph. */
  parentOf: Map<string, string | null>;
  /** Depth from the root, used to emit parents before children for React Flow. */
  depthOf: Map<string, number>;
}

/**
 * Build the parent/child index the layout and the React Flow mapping both need.
 *
 * Nesting comes from `data.parentId` / `data.parentSlot`, which the analyzer sets
 * for the body of a `loop` and for the body/catch/finally of a `try` (04 §2.5, §2.7).
 * A `condition` is NOT a container: its branch statements keep the enclosing
 * container as their parent, exactly as the canonical fixture shows.
 */
export function buildIndex(graph: WorkflowGraph | null | undefined): GraphIndex {
  const nodeById = new Map<string, WorkflowNode>();
  const childrenOf = new Map<string | null, WorkflowNode[]>();
  const containerIds = new Set<string>();
  const parentOf = new Map<string, string | null>();
  const depthOf = new Map<string, number>();

  const nodes = graph?.nodes ?? [];
  for (const node of nodes) nodeById.set(node.id, node);

  for (const node of nodes) {
    const declared = parentIdOf(node);
    // A dangling parent id would strand the node: fall back to the root.
    const parent = declared !== null && nodeById.has(declared) && declared !== node.id ? declared : null;
    parentOf.set(node.id, parent);
    const bucket = childrenOf.get(parent);
    if (bucket === undefined) childrenOf.set(parent, [node]);
    else bucket.push(node);
    if (parent !== null) containerIds.add(parent);
  }

  const walk = (id: string | null, depth: number): void => {
    for (const child of childrenOf.get(id) ?? []) {
      if (depthOf.has(child.id)) continue; // cycle guard
      depthOf.set(child.id, depth);
      walk(child.id, depth + 1);
    }
  };
  walk(null, 0);
  // Anything unreachable (cycle in parentId) is treated as a root at depth 0.
  for (const node of nodes) if (!depthOf.has(node.id)) depthOf.set(node.id, 0);

  return { nodeById, childrenOf, containerIds, parentOf, depthOf };
}

/** Nodes ordered so that every parent precedes its children — React Flow requires this. */
export function orderedNodes(graph: WorkflowGraph, index: GraphIndex): WorkflowNode[] {
  const out: WorkflowNode[] = [];
  const seen = new Set<string>();
  const push = (parent: string | null): void => {
    for (const child of index.childrenOf.get(parent) ?? []) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push(child);
      push(child.id);
    }
  };
  push(null);
  for (const node of graph.nodes) if (!seen.has(node.id)) out.push(node);
  return out;
}

export function isContainerNode(node: WorkflowNode, index: GraphIndex): boolean {
  return index.containerIds.has(node.id) || CONTAINER_NODE_TYPES.includes(node.type);
}

/** True when `edge` goes from a container straight into one of its own children. */
export function isSlotEdge(edge: WorkflowEdge, index: GraphIndex): boolean {
  if (edge.kind !== "control") return false;
  return index.parentOf.get(edge.target) === edge.source;
}

/* -------------------------------------------------------------------------- */
/* source ranges                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `rangeLength` and `nodeAtOffset` now live in `@codeflow-team/core` (`src/run/`).
 *
 * They moved because the same rule answers two questions — "which step is the
 * caret in" (07 §2) and "which step is the runtime in" (09 §1) — and two copies
 * of an innermost-owner rule would eventually disagree. They are re-exported
 * here so every existing import of `@codeflow-team/react` keeps working.
 */
export { nodeAtOffset } from "@codeflow-team/core";
export { rangeLength };

/**
 * Attach diagnostics to nodes (03 §7, 07 §5 — "badge on the node it belongs to").
 * Exact `semanticPath` match first; otherwise the innermost node covering the range.
 */
export function diagnosticsByNode(graph: WorkflowGraph | null | undefined): Map<string, Diagnostic[]> {
  const out = new Map<string, Diagnostic[]>();
  if (graph === null || graph === undefined) return out;

  const byPath = new Map<string, WorkflowNode>();
  for (const node of graph.nodes) {
    if (!byPath.has(node.source.semanticPath)) byPath.set(node.source.semanticPath, node);
  }

  for (const diagnostic of graph.diagnostics) {
    const target = nodeForDiagnostic(graph, diagnostic, byPath);
    if (target === null) continue;
    const bucket = out.get(target.id);
    if (bucket === undefined) out.set(target.id, [diagnostic]);
    else bucket.push(diagnostic);
  }
  return out;
}

function nodeForDiagnostic(
  graph: WorkflowGraph,
  diagnostic: Diagnostic,
  byPath: Map<string, WorkflowNode>,
): WorkflowNode | null {
  const mapping = diagnostic.source;
  if (mapping === undefined) return null;
  const exact = byPath.get(mapping.semanticPath);
  if (exact !== undefined) return exact;

  let best: WorkflowNode | null = null;
  for (const node of graph.nodes) {
    if (node.source.start.offset > mapping.start.offset) continue;
    if (node.source.end.offset < mapping.end.offset) continue;
    if (best === null || rangeLength(node) < rangeLength(best)) best = node;
  }
  return best;
}

/** Highest severity among `diagnostics`, or `null` when there are none. */
export function worstSeverity(diagnostics: readonly Diagnostic[]): Diagnostic["severity"] | null {
  let worst: Diagnostic["severity"] | null = null;
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") return "error";
    if (diagnostic.severity === "warning") worst = "warning";
    else if (worst === null) worst = "info";
  }
  return worst;
}
