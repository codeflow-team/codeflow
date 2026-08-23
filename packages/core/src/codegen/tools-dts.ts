/**
 * `generated/tools.d.ts` — 05-registry.md §2.
 *
 * One artifact serving three consumers: AI context (the whole API in ~1k tokens),
 * the analyzer (a call is a tool node iff its symbol belongs to `Tools`), and the
 * future sandbox runtime (`tools` is the injected binding).
 */

import { CodeFlowError } from "../errors.js";
import type { RegistryLookup } from "../registry/lookup.js";
import type { RegisteredTool } from "../registry/definitions.js";
import { generatedHeader } from "./header.js";
import { schemaToTs } from "./schema-to-ts.js";

export interface GenerateToolsDtsOptions {
  /** Only emit these top-level namespaces — 10 §4 (context scoping). */
  namespaces?: string[];
  /** Interface name; defaults to `Tools`, the name the flow contract uses. */
  interfaceName?: string;
}

interface Namespace {
  namespaces: Map<string, Namespace>;
  tools: Map<string, RegisteredTool>;
}

function emptyNamespace(): Namespace {
  return { namespaces: new Map(), tools: new Map() };
}

// A description is server-authored prose, and prose contains a comment
// terminator more often than one would hope — the official filesystem server
// documents its glob patterns as '**' + '/*.ext'. Left as is, that closes the
// JSDoc block early and the whole .d.ts stops parsing. Escaping the star with a
// backslash is the standard fix: it renders the same and does not terminate.
function escapeComment(text: string): string {
  return text.replace(/\*\//g, "*\\/");
}

export function jsDoc(text: string | undefined, indent: string): string[] {
  if (text === undefined || text.trim().length === 0) return [];
  // `\r` would leave a stray carriage return inside the comment; normalize first.
  const lines = escapeComment(text.trim()).split(/\r?\n/);
  if (lines.length === 1) return [`${indent}/** ${lines[0]!.trim()} */`];
  return [
    `${indent}/**`,
    ...lines.map((line) => `${indent} * ${line.trim()}`.trimEnd()),
    `${indent} */`,
  ];
}

function insert(root: Namespace, tool: RegisteredTool): void {
  const segments = tool.name.split(".");
  const method = segments.pop()!;
  let current = root;
  for (const segment of segments) {
    if (current.tools.has(segment)) {
      throw new CodeFlowError(
        "invalid-tool-name",
        `Tool "${tool.name}" cannot be generated: "${segment}" is already a method name in the same namespace.`,
      );
    }
    let next = current.namespaces.get(segment);
    if (next === undefined) {
      next = emptyNamespace();
      current.namespaces.set(segment, next);
    }
    current = next;
  }
  if (current.namespaces.has(method)) {
    throw new CodeFlowError(
      "invalid-tool-name",
      `Tool "${tool.name}" cannot be generated: "${method}" is already a namespace.`,
    );
  }
  current.tools.set(method, tool);
}

function signature(name: string, tool: RegisteredTool): string {
  const input = schemaToTs(tool.inputSchema);
  const output = tool.outputSchema === undefined ? "void" : schemaToTs(tool.outputSchema);
  return `${name}(input: ${input}): Promise<${output}>;`;
}

function emit(ns: Namespace, indent: string): string[] {
  const lines: string[] = [];
  for (const [name, child] of [...ns.namespaces.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`${indent}${name}: {`);
    lines.push(...emit(child, `${indent}  `));
    lines.push(`${indent}};`);
  }
  for (const [name, tool] of [...ns.tools.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(...jsDoc(tool.description ?? tool.label, indent));
    lines.push(`${indent}${signature(name, tool)}`);
  }
  return lines;
}

export function generateToolsDts(
  registry: RegistryLookup,
  options: GenerateToolsDtsOptions = {},
): string {
  const interfaceName = options.interfaceName ?? "Tools";
  const scope = options.namespaces;
  const tools = registry
    .listTools()
    .filter((tool) => scope === undefined || scope.includes(tool.name.split(".")[0]!));

  const root = emptyNamespace();
  for (const tool of tools) insert(root, tool);

  const body = emit(root, "  ");
  const declaration =
    body.length === 0
      ? [`export interface ${interfaceName} {}`]
      : [`export interface ${interfaceName} {`, ...body, "}"];

  return [
    generatedHeader(registry.registryHash()),
    "",
    ...(tools.length === 0 ? ["// No tools are registered."] : []),
    ...declaration,
    "",
  ].join("\n");
}
