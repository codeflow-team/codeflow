/**
 * Hand-built graphs shaped exactly like what the analyzer emits (see
 * packages/core/test/fixtures/01-canonical/expected-graph.json), so the UI
 * adapters can be tested without depending on the analyzer's internals.
 */

import type {
  NodeCapabilities,
  NodePort,
  NodeType,
  SourceMapping,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from "@codeflow-team/core";

const CAPS: NodeCapabilities = { editable: true, deletable: true, expandable: false };

let offset = 0;

function mapping(semanticPath: string): SourceMapping {
  const start = offset;
  offset += 40;
  return {
    file: "flow.ts",
    start: { line: start / 40 + 1, column: 1, offset: start },
    end: { line: start / 40 + 1, column: 30, offset: start + 30 },
    semanticPath,
    fingerprint: `fp:${semanticPath}`,
  };
}

export interface NodeSpec {
  id: string;
  type: NodeType;
  label: string;
  path: string;
  parentId?: string | null;
  parentSlot?: string | null;
  data?: Record<string, unknown>;
  outputs?: NodePort[];
  inputs?: NodePort[];
}

export function node(spec: NodeSpec): WorkflowNode {
  return {
    id: spec.id,
    type: spec.type,
    label: spec.label,
    source: mapping(spec.path),
    inputs: spec.inputs ?? [],
    outputs: spec.outputs ?? [],
    data: {
      parentId: spec.parentId ?? null,
      parentSlot: spec.parentSlot ?? null,
      ...(spec.data ?? {}),
    },
    capabilities: CAPS,
  };
}

export function edge(
  source: string,
  target: string,
  kind: "control" | "data",
  extra: Partial<WorkflowEdge> = {},
): WorkflowEdge {
  return { id: `${source}->${target}:${kind}:${extra.label ?? ""}`, source, target, kind, ...extra };
}

export function graphOf(nodes: WorkflowNode[], edges: WorkflowEdge[], diagnostics: WorkflowGraph["diagnostics"] = []): WorkflowGraph {
  return {
    id: "g1",
    version: 1,
    source: { file: "flow.ts", content: "", contentHash: "hash" },
    registryHash: "registry",
    nodes,
    edges,
    diagnostics,
    // Hand-built graphs carry no scope table (03 §6): these fixtures exercise
    // rendering, and an empty table is what a host that drops it looks like.
    scopes: {},
  };
}

/**
 * The canonical flow of 01 §1 / 07 §6: trigger → getNewPRs → for-each loop
 * (getFiles → condition → slack.send, all parented on the loop) → output.
 */
export function canonicalGraph(): WorkflowGraph {
  offset = 0;
  const nodes = [
    node({ id: "n_trigger", type: "trigger", label: "Trigger", path: "flow#trigger", outputs: [{ id: "input", label: "input", schema: "{ repository: string }" }], data: { inputType: "{ repository: string }" } }),
    node({
      id: "n_getNewPRs",
      type: "tool",
      label: "Get New PRs",
      path: "flow/call:github.getNewPRs[0]",
      outputs: [{ id: "prs", label: "prs", schema: "PullRequest[]" }],
      data: {
        toolName: "github.getNewPRs",
        resolved: true,
        awaited: true,
        arguments: { repo: "input.repository" },
        argumentText: "{ repo: input.repository }",
        argumentsEditable: true,
        argumentsHaveSpread: false,
        icon: "🐙",
      },
    }),
    node({ id: "n_loop", type: "loop", label: "For Each pr in prs", path: "flow/for[0]", outputs: [{ id: "pr", label: "pr" }], data: { kind: "forOf", variable: "pr", iterable: "prs" } }),
    node({
      id: "n_getFiles",
      type: "tool",
      label: "Get PR Files",
      path: "flow/for[0]/call:github.getFiles[0]",
      parentId: "n_loop",
      parentSlot: "body",
      outputs: [{ id: "files", label: "files", schema: "File[]" }],
      data: {
        toolName: "github.getFiles",
        resolved: true,
        awaited: true,
        arguments: { pr: "pr" },
        argumentText: "{ pr }",
        argumentsEditable: true,
        argumentsHaveSpread: false,
        icon: "🐙",
      },
    }),
    node({
      id: "n_condition",
      type: "condition",
      label: "Is Auth Change",
      path: "flow/for[0]/if[0]",
      parentId: "n_loop",
      parentSlot: "body",
      data: { expression: "files.some(isAuthChange)", functionName: "isAuthChange", hasElse: false, labelSource: "registry" },
    }),
    node({
      id: "n_slack",
      type: "tool",
      label: "Slack Send",
      path: "flow/for[0]/if[0]/call:slack.send[0]",
      parentId: "n_loop",
      parentSlot: "body",
      data: {
        toolName: "slack.send",
        resolved: true,
        awaited: true,
        arguments: { channel: '"#security"', message: "`Security PR: ${pr.title}`" },
        argumentText: '{ channel: "#security", message: `Security PR: ${pr.title}` }',
        argumentsEditable: true,
        argumentsHaveSpread: false,
        icon: "💬",
      },
    }),
    node({ id: "n_output", type: "output", label: "End Flow", path: "flow#output", data: { explicit: false, expression: null } }),
  ];

  const edges = [
    edge("n_trigger", "n_getNewPRs", "control"),
    edge("n_trigger", "n_getNewPRs", "data", { sourcePort: "input", label: "input.repository" }),
    edge("n_getNewPRs", "n_loop", "control"),
    edge("n_getNewPRs", "n_loop", "data", { sourcePort: "prs", label: "prs" }),
    edge("n_loop", "n_output", "control"),
    edge("n_loop", "n_getFiles", "control", { sourcePort: "body", label: "body" }),
    edge("n_loop", "n_getFiles", "data", { sourcePort: "pr", label: "pr" }),
    edge("n_loop", "n_slack", "data", { sourcePort: "pr", label: "pr.title" }),
    edge("n_getFiles", "n_condition", "control"),
    edge("n_getFiles", "n_condition", "data", { sourcePort: "files", label: "files" }),
    edge("n_condition", "n_slack", "control", { sourcePort: "true", label: "true" }),
  ];

  return graphOf(nodes, edges);
}

/** A `try` with body + catch children, plus a diagnostic on the unknown node. */
export function tryGraph(): WorkflowGraph {
  offset = 0;
  const nodes = [
    node({ id: "n_try", type: "try", label: "Try", path: "flow/try[0]", outputs: [{ id: "err", label: "err" }], data: { hasCatch: true, hasFinally: false, catchParam: "err" } }),
    node({ id: "n_charge", type: "tool", label: "Charge", path: "flow/try[0]/call:payment.charge[0]", parentId: "n_try", parentSlot: "body", data: { toolName: "payment.charge", resolved: true, arguments: { amount: "amount" }, argumentsEditable: true, argumentsHaveSpread: false } }),
    node({ id: "n_alert", type: "unknown", label: "slack.alert", path: "flow/try[0]/catch/call:slack.alert[0]", parentId: "n_try", parentSlot: "catch", data: { toolName: "slack.alert", resolved: false, arguments: null, argumentsEditable: false, argumentsHaveSpread: false } }),
    node({ id: "n_out", type: "output", label: "End Flow", path: "flow#output", data: { explicit: false, expression: null } }),
  ];
  const edges = [
    edge("n_try", "n_charge", "control", { sourcePort: "body", label: "body" }),
    edge("n_try", "n_alert", "control", { sourcePort: "error", label: "error" }),
    edge("n_try", "n_out", "control"),
    edge("n_charge", "n_out", "control"),
  ];
  const alert = nodes[2];
  return graphOf(nodes, edges, [
    {
      severity: "error",
      code: "unresolved-tool",
      message: 'Cannot resolve tool "slack.alert".',
      source: alert.source,
    },
  ]);
}
