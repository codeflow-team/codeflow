/**
 * Graph assembly helpers: node/edge creation, capabilities, diagnostics.
 */

import type { Node } from "ts-morph";
import type {
  Diagnostic,
  DiagnosticSeverity,
  EdgeKind,
  NodeCapabilities,
  NodePort,
  NodeType,
  SourceMapping,
  WorkflowEdge,
  WorkflowNode,
} from "../model/index.js";
import { coldNodeId, computeEdgeId, mappingForNode } from "../mapper/index.js";
import type { AnalysisContext, Exit, FlowBinding, Frame } from "./context.js";

/** Default capabilities per node type — 03 §11. */
export function capabilitiesFor(type: NodeType, synthetic: boolean): NodeCapabilities {
  if (synthetic) return { editable: false, deletable: false, expandable: false };
  switch (type) {
    case "tool":
    case "function":
      return { editable: true, deletable: true, expandable: false };
    case "condition":
      return { editable: true, deletable: true, expandable: false };
    case "loop":
      return { editable: true, deletable: true, expandable: true };
    case "try":
    case "parallel":
      return { editable: false, deletable: true, expandable: true };
    case "code":
      return { editable: true, deletable: true, expandable: true };
    case "unknown":
      // 03 §11: not editable, but deletable (through the dependency check) and
      // its output binding is still tracked for data edges.
      return { editable: false, deletable: true, expandable: false };
    case "jump":
    case "output":
      return { editable: false, deletable: true, expandable: false };
    default:
      return { editable: false, deletable: false, expandable: false };
  }
}

export interface AddNodeInput {
  type: NodeType;
  label: string;
  mapping: SourceMapping;
  data?: Record<string, unknown>;
  inputs?: NodePort[];
  outputs?: NodePort[];
  synthetic?: boolean;
  capabilities?: NodeCapabilities;
  /**
   * Bindings this node itself declares and that are *already* in `frame.scope`
   * when the node is created — a code node declares its bindings while its run
   * is being classified, before the node exists. They are excluded from the
   * node's scope capture: `const prs = await …` makes the node the writer of
   * `prs`, and that value is not available at the node's own configuration.
   * (Every other emitter declares after `addNode`, so it needs nothing here.)
   */
  declares?: readonly FlowBinding[];
}

export function addNode(ctx: AnalysisContext, frame: Frame, input: AddNodeInput): WorkflowNode {
  const node: WorkflowNode = {
    id: coldNodeId(input.mapping.semanticPath),
    type: input.type,
    label: input.label,
    source: input.mapping,
    inputs: input.inputs ?? [],
    outputs: input.outputs ?? [],
    data: {
      parentId: frame.parentId,
      parentSlot: frame.parentSlot,
      ...(input.data ?? {}),
    },
    capabilities: input.capabilities ?? capabilitiesFor(input.type, input.synthetic === true),
  };
  ctx.nodes.push(node);
  // The single choke point for node creation is also the single choke point
  // for "what was visible here" — captured now, materialised after the whole
  // analysis (03 §6, see analyzer/scopes.ts).
  ctx.scopeCaptures.push({
    nodeId: node.id,
    bindings: frame.scope.visible(new Set(input.declares ?? [])),
  });
  return node;
}

export function addControlEdge(
  ctx: AnalysisContext,
  from: Exit,
  targetId: string,
  label?: string,
): void {
  addEdge(ctx, {
    source: from.nodeId,
    target: targetId,
    kind: "control",
    sourcePort: from.port,
    label: label ?? from.label,
  });
}

export interface AddEdgeInput {
  source: string;
  target: string;
  kind: EdgeKind;
  sourcePort?: string;
  targetPort?: string;
  label?: string;
}

export function addEdge(ctx: AnalysisContext, input: AddEdgeInput): WorkflowEdge | null {
  if (input.source === input.target) return null;
  const key = `${input.source}|${input.target}|${input.kind}|${input.sourcePort ?? ""}|${input.targetPort ?? ""}`;
  const seen = input.kind === "data" ? ctx.dataEdgeKeys : ctx.controlEdgeKeys;
  if (seen.has(key)) return null;
  seen.add(key);

  const edge: WorkflowEdge = {
    id: computeEdgeId(input.source, input.target, input.kind, input.sourcePort, input.targetPort),
    source: input.source,
    target: input.target,
    kind: input.kind,
  };
  if (input.sourcePort !== undefined) edge.sourcePort = input.sourcePort;
  if (input.targetPort !== undefined) edge.targetPort = input.targetPort;
  if (input.label !== undefined) edge.label = input.label;
  ctx.edges.push(edge);
  return edge;
}

export function connectAll(ctx: AnalysisContext, incoming: readonly Exit[], targetId: string): void {
  for (const exit of incoming) addControlEdge(ctx, exit, targetId);
}

export function diagnose(
  ctx: AnalysisContext,
  severity: DiagnosticSeverity,
  code: string,
  message: string,
  mapping?: SourceMapping,
): void {
  const diagnostic: Diagnostic = { severity, code, message };
  if (mapping !== undefined) diagnostic.source = mapping;
  ctx.diagnostics.push(diagnostic);
}

/** Diagnostic anchored on an AST node, reusing that node's semantic path. */
export function diagnoseAt(
  ctx: AnalysisContext,
  severity: DiagnosticSeverity,
  code: string,
  message: string,
  node: Node,
  semanticPath: string,
): void {
  diagnose(
    ctx,
    severity,
    code,
    message,
    mappingForNode(ctx.file, ctx.sourceFile, node, semanticPath),
  );
}
