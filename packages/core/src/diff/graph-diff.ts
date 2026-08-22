/**
 * Graph diff — 03-data-model.md §10, 04-analyzer.md §4.
 *
 * After a re-analyze the core emits a diff rather than "here is a whole new
 * graph", so the UI can update incrementally (07 §7) and so a change is
 * inspectable while debugging.
 *
 * The diff is taken **after identity resolution** (03 §5.2): node ids are the
 * join key, which is exactly why identity has to be resolved first — without it
 * every re-analyze would read as "everything removed, everything added".
 *
 * `node.updated` carries a *shallow* change set: the top-level fields of
 * `WorkflowNode` that differ, each as `{ from, to }`. Reformatting a file that
 * changes nothing semantic still moves source ranges, so it surfaces as
 * `node.updated` with `source` as the only changed field — a true statement
 * about the graph, and the thing a source-highlighting UI needs to know.
 *
 * Edges have no `updated` variant in the spec, and they need none: an edge id is
 * a hash of (source, target, kind, ports), so any change to those is already a
 * removal plus an addition.
 */

import type { GraphChange, WorkflowEdge, WorkflowGraph, WorkflowNode } from "../model/index.js";
import { canonicalJson } from "../util/canonical-json.js";

/** Top-level node fields compared by the shallow diff, in report order. */
const NODE_FIELDS = ["type", "label", "source", "data", "inputs", "outputs", "capabilities"] as const;

type NodeField = (typeof NODE_FIELDS)[number];

export interface FieldChange {
  from: unknown;
  to: unknown;
}

/**
 * Shallow field diff of one node, or `null` when nothing changed. Values are
 * compared canonically (key order is not a change).
 */
export function diffNode(
  previous: WorkflowNode,
  current: WorkflowNode,
): Record<string, FieldChange> | null {
  const changes: Record<string, FieldChange> = {};
  let changed = false;
  for (const field of NODE_FIELDS) {
    const from: unknown = previous[field as NodeField];
    const to: unknown = current[field as NodeField];
    if (canonicalJson(from) === canonicalJson(to)) continue;
    changes[field] = { from, to };
    changed = true;
  }
  return changed ? changes : null;
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) map.set(item.id, item);
  return map;
}

/**
 * Diff two graphs of the same session. `current` must already carry resolved
 * identity (see `applyIdentity`), otherwise the result is meaningless.
 *
 * Order is deterministic: removed nodes (previous order), added nodes (current
 * order), updated nodes (current order), removed edges, added edges.
 */
export function diffGraphs(previous: WorkflowGraph, current: WorkflowGraph): GraphChange[] {
  const changes: GraphChange[] = [];

  const previousNodes = byId(previous.nodes);
  const currentNodes = byId(current.nodes);

  for (const node of previous.nodes) {
    if (!currentNodes.has(node.id)) changes.push({ type: "node.removed", nodeId: node.id });
  }
  for (const node of current.nodes) {
    if (!previousNodes.has(node.id)) changes.push({ type: "node.added", nodeId: node.id });
  }
  for (const node of current.nodes) {
    const before = previousNodes.get(node.id);
    if (before === undefined) continue;
    const fields = diffNode(before, node);
    if (fields !== null) changes.push({ type: "node.updated", nodeId: node.id, changes: fields });
  }

  const previousEdges = byId<WorkflowEdge>(previous.edges);
  const currentEdges = byId<WorkflowEdge>(current.edges);
  for (const edge of previous.edges) {
    if (!currentEdges.has(edge.id)) changes.push({ type: "edge.removed", edgeId: edge.id });
  }
  for (const edge of current.edges) {
    if (!previousEdges.has(edge.id)) changes.push({ type: "edge.added", edgeId: edge.id });
  }

  return changes;
}
