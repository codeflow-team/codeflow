/**
 * Helpers for the identity/diff suites: analyze two revisions of a flow inside
 * one session (the continuity path — 03 §5.0) and assert structural sanity of
 * the result.
 */

import { expect } from "vitest";
import { createCodeFlow, type CodeFlowSession } from "../../src/session.js";
import { computeEdgeId } from "../../src/mapper/ids.js";
import type {
  AnalyzeOptions,
  GraphChange,
  WorkflowGraph,
  WorkflowNode,
} from "../../src/model/index.js";
import type { IdentityResolution } from "../../src/mapper/resolve.js";
import { createSampleRegistry } from "../fixtures.js";

export interface Revision {
  session: CodeFlowSession;
  before: WorkflowGraph;
  after: WorkflowGraph;
  changes: GraphChange[];
  resolution: IdentityResolution;
}

/** Analyze `before`, then `after`, in the same session. */
export async function reanalyze(
  before: string,
  after: string,
  secondOptions?: AnalyzeOptions,
): Promise<Revision> {
  const session = createCodeFlow({ registry: createSampleRegistry() });
  const first = await session.analyze(before);
  const second = await session.analyze(after, secondOptions);
  const resolution = session.lastResolution();
  expect(resolution).not.toBeNull();
  assertIntegrity(first);
  assertIntegrity(second);
  return { session, before: first, after: second, changes: session.lastChanges(), resolution: resolution! };
}

/** Node ids must be unique, and every reference in the graph must resolve. */
export function assertIntegrity(graph: WorkflowGraph): void {
  const ids = graph.nodes.map((node) => node.id);
  expect(new Set(ids).size).toBe(ids.length);

  const known = new Set(ids);
  for (const node of graph.nodes) {
    const parentId = node.data["parentId"];
    if (typeof parentId === "string") expect(known.has(parentId)).toBe(true);
  }
  for (const edge of graph.edges) {
    expect(known.has(edge.source)).toBe(true);
    expect(known.has(edge.target)).toBe(true);
    // Edge ids are derived, never resolved (03 §5.0).
    expect(edge.id).toBe(
      computeEdgeId(edge.source, edge.target, edge.kind, edge.sourcePort, edge.targetPort),
    );
  }
}

/** A previous id is handed to at most one node, and a node inherits at most one. */
export function assertBijective(resolution: IdentityResolution): void {
  const previous = resolution.matches.map((match) => match.previousId);
  const fresh = resolution.matches.map((match) => match.freshId);
  expect(new Set(previous).size).toBe(previous.length);
  expect(new Set(fresh).size).toBe(fresh.length);
}

export function nodeByPath(graph: WorkflowGraph, semanticPath: string): WorkflowNode {
  const node = graph.nodes.find((candidate) => candidate.source.semanticPath === semanticPath);
  expect(node, `no node at ${semanticPath}`).toBeDefined();
  return node!;
}

export function nodeById(graph: WorkflowGraph, id: string): WorkflowNode | undefined {
  return graph.nodes.find((candidate) => candidate.id === id);
}

export function idsOf(graph: WorkflowGraph): string[] {
  return graph.nodes.map((node) => node.id);
}

export function changesOf(changes: readonly GraphChange[], type: GraphChange["type"]): GraphChange[] {
  return changes.filter((change) => change.type === type);
}

/** Wrap a flow body in the contract shape (01 §1). */
export function flowSource(body: string, imports = ""): string {
  return `import type { Tools } from "../generated/tools";
${imports}
export default async function flow(input: { repository: string }, tools: Tools) {
${body}
}
`;
}
