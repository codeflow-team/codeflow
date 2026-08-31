/**
 * Shared scaffolding for the stress suite.
 *
 * The corpus under test is `@codeflow-team/examples` — thirteen flows, nine of them
 * written against tool schemas captured from real MCP servers, four of them
 * between 260 and 350 lines. Where the golden fixtures cover *constructs* one
 * at a time and the hardening suite covers *hazards*, this suite covers
 * **scale**: what happens when twenty of those constructs are in one file, four
 * levels deep, with a hundred nodes hanging off them.
 *
 * `@codeflow-team/examples` is resolved from source through an alias in
 * `vitest.config.ts` (and `paths` in `tsconfig.json`). Core cannot depend on it
 * the ordinary way — examples depends on core, and a devDependency back would
 * make the turbo build graph cyclic.
 */

import { expect } from "vitest";
import { EXAMPLES, registryFor, type FlowExample } from "@codeflow-team/examples";

import { createCodeFlow, type CodeFlowSession } from "../../src/session.js";
import { createRegistry, type Registry } from "../../src/registry/index.js";
import type { Diagnostic, WorkflowGraph, WorkflowNode } from "../../src/model/index.js";
import { checkStatementOwnership } from "../harness/invariants.js";

export { EXAMPLES, registryFor };
export type { FlowExample };

/** Flows that are meant to be clean — everything except the degradation pair. */
export const CLEAN_EXAMPLES = EXAMPLES.filter((example) => example.category !== "degradation");

/** The four long ones, which is where the interesting failures live. */
export const LONG_EXAMPLES = EXAMPLES.filter((example) => example.lines >= 200);

export function exampleById(id: string): FlowExample {
  const example = EXAMPLES.find((candidate) => candidate.id === id);
  expect(example, `no example "${id}" — have ${EXAMPLES.map((e) => e.id).join(", ")}`).toBeDefined();
  return example!;
}

export function fileOf(example: FlowExample): string {
  return `${example.id}.flow.ts`;
}

export function registryOf(example: FlowExample): Registry {
  const { tools, functions } = registryFor(example);
  return createRegistry({ tools, functions });
}

export interface OpenExample {
  example: FlowExample;
  session: CodeFlowSession;
  graph: WorkflowGraph;
  registry: Registry;
}

export async function open(example: FlowExample): Promise<OpenExample> {
  const registry = registryOf(example);
  const session = createCodeFlow({ registry });
  const graph = await session.analyze(example.source, { file: fileOf(example) });
  return { example, session, graph, registry };
}

export function countByType(graph: WorkflowGraph): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const node of graph.nodes) counts[node.type] = (counts[node.type] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)));
}

export function diagnosticsOf(graph: WorkflowGraph, code: string): Diagnostic[] {
  return graph.diagnostics.filter((diagnostic) => diagnostic.code === code);
}

export function errorsOf(graph: WorkflowGraph): Diagnostic[] {
  return graph.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
}

export function nodesOfType(graph: WorkflowGraph, type: string): WorkflowNode[] {
  return graph.nodes.filter((node) => node.type === type);
}

export function toolNodes(graph: WorkflowGraph, toolName: string): WorkflowNode[] {
  return graph.nodes.filter((node) => node.data["toolName"] === toolName);
}

export function nodeAt(graph: WorkflowGraph, semanticPath: string): WorkflowNode {
  const node = graph.nodes.find((candidate) => candidate.source.semanticPath === semanticPath);
  expect(
    node,
    `no node at ${semanticPath} — closest: ${graph.nodes
      .map((n) => n.source.semanticPath)
      .filter((path) => path.startsWith(semanticPath.slice(0, 20)))
      .slice(0, 8)
      .join(" | ")}`,
  ).toBeDefined();
  return node!;
}

/** Nesting depth of a node, walking `data.parentId` to the root. */
export function depthOf(graph: WorkflowGraph, node: WorkflowNode): number {
  const byId = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));
  let depth = 0;
  let current: WorkflowNode | undefined = node;
  while (current !== undefined) {
    const parentId = current.data["parentId"];
    if (typeof parentId !== "string") break;
    current = byId.get(parentId);
    depth += 1;
    expect(depth, "parent chain does not terminate").toBeLessThan(50);
  }
  return depth;
}

/** I1 — every statement of the flow body belongs to exactly one node. */
export function assertOwnership(example: FlowExample, graph: WorkflowGraph): void {
  const problems = checkStatementOwnership(example.source, graph, fileOf(example));
  expect(
    problems,
    `${example.id}: ${problems.map((p) => `${p.statement} → [${p.owners.join(", ")}]`).join("\n")}`,
  ).toEqual([]);
}

/** Median of a sample, which is what a timing table should report. */
export function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}
