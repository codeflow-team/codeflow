/**
 * Shared scaffolding for the hardening suite (`test/hardening/README.md`).
 *
 * Everything here is deliberately thin: a hardening test is worth exactly as
 * much as the reader's ability to see what source went in and what came out, so
 * the helpers stop at "open a session" and "find that node" and never assert
 * anything on the test's behalf.
 */

import { expect } from "vitest";
import { createCodeFlow, type CodeFlowSession } from "../../src/session.js";
import { createRegistry, type Registry } from "../../src/registry/index.js";
import { CodeFlowError } from "../../src/errors.js";
import type { Diagnostic, WorkflowGraph, WorkflowNode } from "../../src/model/index.js";
import { createSampleRegistry } from "../fixtures.js";

export const FILE = "flow.ts";

/** Wrap a flow body in the contract shape (01 §1). */
export function flowSource(body: string, imports = ""): string {
  return `import type { Tools } from "../generated/tools";
${imports}
export default async function flow(input: { repository: string }, tools: Tools) {
${body}
}
`;
}

export const LIB_IMPORT = `import { isAuthChange } from "@flows/lib";\n`;

export interface OpenFlow {
  session: CodeFlowSession;
  graph: WorkflowGraph;
  source: string;
}

export async function open(source: string, registry: Registry = createSampleRegistry()): Promise<OpenFlow> {
  const session = createCodeFlow({ registry });
  const graph = await session.analyze(source, { file: FILE });
  return { session, graph, source };
}

/** A registry whose `slack.send` declares three editable fields. */
export function threeFieldRegistry(): Registry {
  const registry = createRegistry();
  registry.registerTool({
    name: "slack.send",
    label: "Slack Send",
    icon: "💬",
    inputSchema: { channel: "string", message: "string", thread: "string" },
    editableFields: ["channel", "message", "thread"],
  });
  return registry;
}

export function nodeAt(graph: WorkflowGraph, semanticPath: string): WorkflowNode {
  const found = graph.nodes.find((candidate) => candidate.source.semanticPath === semanticPath);
  expect(
    found,
    `no node at ${semanticPath} — graph has ${graph.nodes.map((n) => n.source.semanticPath).join(", ")}`,
  ).toBeDefined();
  return found!;
}

export function nodesOfType(graph: WorkflowGraph, type: string): WorkflowNode[] {
  return graph.nodes.filter((node) => node.type === type);
}

export function pathsOfType(graph: WorkflowGraph, type: string): string[] {
  return nodesOfType(graph, type).map((node) => node.source.semanticPath);
}

export function toolNode(graph: WorkflowGraph, toolName: string, occurrence = 0): WorkflowNode {
  const found = graph.nodes.filter((node) => node.data["toolName"] === toolName);
  expect(found.length, `no ${toolName} #${String(occurrence)}`).toBeGreaterThan(occurrence);
  return found[occurrence];
}

export function diagnosticsOf(graph: WorkflowGraph, code: string): Diagnostic[] {
  return graph.diagnostics.filter((diagnostic) => diagnostic.code === code);
}

/** Every edge, rendered as `kind from -> to [label]` over semantic paths. */
export function edgeStrings(graph: WorkflowGraph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node.source.semanticPath]));
  return graph.edges.map(
    (edge) =>
      `${edge.kind} ${byId.get(edge.source) ?? edge.source} -> ${byId.get(edge.target) ?? edge.target}${
        edge.label === undefined ? "" : ` [${edge.label}]`
      }`,
  );
}

export function hasEdge(graph: WorkflowGraph, from: string, to: string, kind = "control"): boolean {
  return edgeStrings(graph).some((edge) => edge.startsWith(`${kind} ${from} -> ${to}`));
}

/** Assert a promise rejects with a `CodeFlowError`, and hand the error back. */
export async function refusal(promise: Promise<unknown>): Promise<CodeFlowError> {
  const caught = await promise.catch((error: unknown) => error);
  expect(caught, "expected a refusal, got a result").toBeInstanceOf(CodeFlowError);
  return caught as CodeFlowError;
}

/** Line/column of an offset (1-based), for asserting *where* a diagnostic points. */
export function positionOf(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

/** The text of the line a diagnostic points at — the readable form of "where". */
export function lineAt(source: string, line: number): string {
  return source.split("\n")[line - 1] ?? "";
}
