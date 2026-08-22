/** Workflow graph — 03-data-model.md §1, §2, §3, §6, §10, §11. */

import type { Diagnostic } from "./diagnostic.js";
import type { Schema } from "./schema.js";
import type { SourceDocument, SourceMapping } from "./source.js";

export type CoreNodeType =
  /** synthetic — flow signature + TriggerMetadata (03 §9) */
  | "trigger"
  /** await tools.<ns>.<fn>(...) */
  | "tool"
  /** library function OR local function — called as a statement */
  | "function"
  /** if / else */
  | "condition"
  /** for...of OR while — body is a subgraph; data.kind: "forOf" | "while" */
  | "loop"
  /** try/catch(/finally) — subgraphs + control edge "error" */
  | "try"
  /** break | continue — terminal node inside a loop subgraph */
  | "jump"
  /** Promise.all */
  | "parallel"
  /** synthetic — convergence point after parallel/condition */
  | "merge"
  /** fallback: unsupported construct — source kept verbatim */
  | "code"
  /** return of the flow (explicit or synthetic) */
  | "output"
  /** recognised construct whose resolution FAILED (e.g. tool not in registry) */
  | "unknown";

/** Open union: plugins register new node types through the registry (05 §5). */
export type NodeType = CoreNodeType | (string & {});

export interface NodePort {
  id: string;
  label: string;
  /** From the registry, or from the TS type. */
  schema?: Schema;
}

/** Default capabilities per node type are listed in 03 §11. */
export interface NodeCapabilities {
  /** has editable fields */
  editable: boolean;
  deletable: boolean;
  /** has a subgraph (loop/try/parallel) or a code view */
  expandable: boolean;
}

export interface WorkflowNode {
  /** Stable identity — 03 §5. Opaque handle, never encodes content. */
  id: string;
  type: NodeType;
  label: string;

  source: SourceMapping;

  inputs: NodePort[];
  outputs: NodePort[];

  /** Node-type specific payload: tool name, field values, condition expression… */
  data: Record<string, unknown>;

  capabilities: NodeCapabilities;
}

export type EdgeKind = "control" | "data";

export interface WorkflowEdge {
  id: string;
  /** node id */
  source: string;
  /** node id */
  target: string;
  kind: EdgeKind;
  sourcePort?: string;
  targetPort?: string;
  /** e.g. "true"/"false" on a condition branch, or the binding name on a data edge */
  label?: string;
}

export interface WorkflowGraph {
  id: string;
  /** bumped on every re-analyze */
  version: number;
  source: SourceDocument;
  /**
   * Fingerprint of the registry at analyze time — the graph is a function of
   * (source, registry), so staleness must look at BOTH.
   */
  registryHash: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  diagnostics: Diagnostic[];
}

/** Graph diff emitted after each re-analyze — 03 §10. */
export interface GraphChange {
  type: "node.added" | "node.removed" | "node.updated" | "edge.added" | "edge.removed";
  nodeId?: string;
  edgeId?: string;
  changes?: Record<string, unknown>;
}
