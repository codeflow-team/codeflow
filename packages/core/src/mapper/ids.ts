/**
 * Identity generation — 03-data-model.md §5.0.
 *
 * `node.id` is an opaque handle that never encodes content (changing a node's
 * tool must not change its id). On the **cold analyze** path it is a
 * deterministic hash of the semantic path, so the same (source, registry)
 * always yields the same graph including ids — invariant I2.
 *
 * `edge.id` is a deterministic hash of (source, target, kind, ports); edges
 * never need resolution of their own.
 *
 * Session re-analyze (carrying ids across through alignment) is Phase 3 and
 * deliberately absent here.
 */

import { sha256Hex } from "../util/sha256.js";
import type { EdgeKind } from "../model/index.js";

const NODE_FORMAT = "codeflow.node-id.v1";
const EDGE_FORMAT = "codeflow.edge-id.v1";
const GRAPH_FORMAT = "codeflow.graph-id.v1";

/** Hash length kept short enough to stay readable in fixtures, long enough to not collide. */
const LENGTH = 12;

/** Cold-analyze node id: deterministic hash of the semantic path (03 §5.0). */
export function coldNodeId(semanticPath: string): string {
  return `n_${sha256Hex(`${NODE_FORMAT}|${semanticPath}`).slice(0, LENGTH)}`;
}

export function computeEdgeId(
  source: string,
  target: string,
  kind: EdgeKind,
  sourcePort?: string,
  targetPort?: string,
): string {
  const key = `${EDGE_FORMAT}|${source}|${target}|${kind}|${sourcePort ?? ""}|${targetPort ?? ""}`;
  return `e_${sha256Hex(key).slice(0, LENGTH)}`;
}

/** Graph id — a function of (file, source content, registry), like the graph itself. */
export function computeGraphId(file: string, contentHash: string, registryHash: string): string {
  const key = `${GRAPH_FORMAT}|${file}|${contentHash}|${registryHash}`;
  return `g_${sha256Hex(key).slice(0, LENGTH)}`;
}
