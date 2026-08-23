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
  /**
   * Also document each **argument** of a tool, as `@param` lines under the
   * tool's own description.
   *
   * The signature already carries every argument's name, type and optionality,
   * so this looks redundant — and for a human reading the file it nearly is.
   * For an AI writing against it, it is not. `sequentialthinking` publishes
   * `nextThoughtNeeded?: boolean` with the description "Whether another thought
   * step is needed"; the type alone says "you may leave this out", the
   * description says what leaving it out means. The generate-and-run eval
   * caught a model omitting exactly that field, writing a flow that reached L2
   * and then died on the first call
   * (`packages/core/test/ai/results/generate-and-run-summary*.md`).
   *
   * Off by default: descriptions are server-authored prose and can be long, so
   * this trades context tokens for argument accuracy, and 10 §4 leaves that
   * trade to the caller.
   */
  parameterDocs?: boolean;
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

/**
 * `@param` lines for the arguments that carry a description of their own.
 *
 * Only the **top level** of the input schema, and only properties whose
 * description says something: nesting the whole schema back into prose would
 * cost more tokens than the schema it duplicates, and a `@param` that repeats
 * the property name adds nothing the signature did not already say.
 *
 * Optionality is restated in words (`(optional)`) rather than left to the `?`
 * in the signature, because the observed failure was precisely a model reading
 * `?` as "ignore me".
 */
function parameterDocLines(tool: RegisteredTool): string[] {
  const schema = tool.inputSchema as Record<string, unknown> | undefined;
  if (schema === undefined || typeof schema !== "object") return [];
  const properties = schema["properties"];
  if (typeof properties !== "object" || properties === null) return [];
  const required = Array.isArray(schema["required"])
    ? new Set((schema["required"] as unknown[]).map((name) => String(name)))
    : new Set<string>();

  const lines: string[] = [];
  for (const [name, value] of Object.entries(properties as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const description = (value as Record<string, unknown>)["description"];
    if (typeof description !== "string" || description.trim().length === 0) continue;
    const optional = required.has(name) ? "" : " (optional)";
    lines.push(`@param ${name}${optional} — ${description.trim().replace(/\s+/g, " ")}`);
  }
  return lines;
}

function signature(name: string, tool: RegisteredTool): string {
  const input = schemaToTs(tool.inputSchema);
  // No declared output schema means "we were not told", not "there is no result".
  // `void` was a lie a live run exposed: an MCP tool that declares no output still
  // answers with one, and code written against `void` either drops the value or
  // prints a wrong number for it. `unknown` says what is true — something comes
  // back and the caller has to establish what it is.
  const output = tool.outputSchema === undefined ? "unknown" : schemaToTs(tool.outputSchema);
  return `${name}(input: ${input}): Promise<${output}>;`;
}

function emit(ns: Namespace, indent: string, parameterDocs: boolean): string[] {
  const lines: string[] = [];
  for (const [name, child] of [...ns.namespaces.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`${indent}${name}: {`);
    lines.push(...emit(child, `${indent}  `, parameterDocs));
    lines.push(`${indent}};`);
  }
  for (const [name, tool] of [...ns.tools.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const params = parameterDocs ? parameterDocLines(tool) : [];
    const description = tool.description ?? tool.label;
    lines.push(
      ...jsDoc(
        params.length === 0
          ? description
          : [description ?? "", "", ...params].join("\n").replace(/^\n+/, ""),
        indent,
      ),
    );
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

  const body = emit(root, "  ", options.parameterDocs === true);
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
