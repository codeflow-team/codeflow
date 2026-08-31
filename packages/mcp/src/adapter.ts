/**
 * MCP adapter — 05-registry.md §3.
 *
 * ```text
 * MCP Server → tool discovery → MCP schema → ToolDefinition → registry → codegen
 * ```
 *
 * An MCP tool already carries a name, a description and a JSON Schema, and
 * `Schema` accepts a JSON Schema object as one of its three shapes (03 §11), so
 * the mapping is nearly mechanical. The parts that are *not* mechanical, and why:
 *
 *  - **name** — MCP names are free-form, CodeFlow names are `<ns>.<method>` with
 *    identifier segments (they become property paths in `Tools`). The method is
 *    slugged (`names.ts`) and the original kept in `definition.mcp.toolName`.
 *  - **label** — MCP `title`, else `annotations.title`, else the humanized name.
 *    A label is what a non-developer reads on the node (07 §3), so it never
 *    falls back to a slug.
 *  - **schemas** — passed through verbatim. Converting them here would mean
 *    inventing a second representation of something core already understands;
 *    `generateToolsDts` turns them into TypeScript at codegen time (05 §2).
 *
 * Once a tool is in the registry, nothing downstream can tell it came from MCP —
 * "tool đến từ MCP hay local function hay REST SDK là không phân biệt được và
 * không cần phân biệt" (05 §3). That is the point of the adapter.
 */

import type { Schema } from "@codeflow-team/core";
import { humanize, slugifyMethod, slugifyNamespace, uniqueMethod } from "./names.js";
import type {
  McpAdapterOptions,
  McpJsonSchema,
  McpListToolsResult,
  McpTool,
  McpToolClient,
  McpToolDefinition,
  McpToolOrigin,
  McpToolRegistrar,
} from "./types.js";

/** An input schema is required by MCP; a server that omits it means "no input". */
const EMPTY_INPUT: McpJsonSchema = { type: "object" };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Top-level property names of a JSON Schema object — the fields an inspector can
 * render for this tool (06 §1). Order follows the schema, so the form matches
 * what the server author wrote.
 */
export function editableFieldsOf(schema: McpJsonSchema | undefined): string[] {
  if (schema === undefined) return [];
  const properties = schema["properties"];
  if (!isObject(properties)) return [];
  return Object.keys(properties).filter((key) => key.length > 0);
}

export interface MapMcpToolOptions extends McpAdapterOptions {
  /** Method names already used in this namespace — collisions get a numeric suffix. */
  taken?: ReadonlySet<string>;
}

/** Map one MCP tool to a `ToolDefinition` (05 §3). */
export function mcpToolToDefinition(tool: McpTool, options: MapMcpToolOptions): McpToolDefinition {
  if (typeof tool?.name !== "string" || tool.name.length === 0) {
    throw new TypeError("MCP tool has no name — `tools/list` entries must carry a `name`.");
  }

  const namespace = slugifyNamespace(options.namespace);
  const proposed = slugifyMethod(options.methodName?.(tool) ?? tool.name);
  const method = uniqueMethod(proposed, options.taken ?? new Set());

  const inputSchema = isObject(tool.inputSchema) ? tool.inputSchema : EMPTY_INPUT;
  const label = tool.title ?? tool.annotations?.title ?? humanize(tool.name);
  const icon = tool.icons?.[0]?.src;

  const origin: McpToolOrigin = {
    namespace,
    method,
    toolName: tool.name,
    renamed: method !== tool.name,
    ...(options.server === undefined ? {} : { server: options.server }),
  };

  const definition: McpToolDefinition = {
    name: `${namespace}.${method}`,
    label,
    inputSchema: inputSchema as Schema,
    mcp: origin,
  };

  // `description` is passed through untouched — it is the JSDoc the AI reads in
  // `tools.d.ts` (05 §2), and rewriting it would be inventing content.
  if (tool.description !== undefined && tool.description.length > 0) {
    definition.description = tool.description;
  }
  if (isObject(tool.outputSchema)) {
    definition.outputSchema = tool.outputSchema as Schema;
  }
  if (icon !== undefined) definition.icon = icon;

  if (options.deriveEditableFields !== false) {
    const fields = editableFieldsOf(inputSchema);
    if (fields.length > 0) definition.editableFields = fields;
  }

  return definition;
}

/**
 * Map a whole `tools/list` payload, keeping method names unique within the
 * namespace. Two MCP tools that slug alike (`get-issue`, `get_issue`) both stay
 * reachable — the second becomes `getIssue2` — rather than one silently
 * overwriting the other.
 */
export function mcpToolsToDefinitions(
  tools: readonly McpTool[],
  options: McpAdapterOptions,
): McpToolDefinition[] {
  const taken = new Set<string>();
  const definitions: McpToolDefinition[] = [];
  for (const tool of tools) {
    const definition = mcpToolToDefinition(tool, { ...options, taken });
    taken.add(definition.mcp.method);
    definitions.push(definition);
  }
  return definitions;
}

export interface DiscoverMcpToolsOptions extends McpAdapterOptions {
  /** Stop after this many `tools/list` pages. Default 100 — a loop guard, not a limit. */
  maxPages?: number;
}

/**
 * Discover every tool a connected MCP client exposes and map them to
 * `ToolDefinition`s.
 *
 * Pagination is followed to the end (`nextCursor`), because a partial registry is
 * worse than a slow one: a tool missing from the registry makes its call an
 * `unknown` node (04 §1.2), which reads as "the AI invented this".
 *
 * The adapter never connects anything — the caller owns the transport and the
 * lifecycle. That keeps this package testable with a fake client and keeps
 * "core never executes anything" true one layer up as well (05 §6).
 */
export async function discoverMcpTools(
  client: McpToolClient,
  options: DiscoverMcpToolsOptions,
): Promise<McpToolDefinition[]> {
  const maxPages = options.maxPages ?? 100;
  const tools: McpTool[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const result: McpListToolsResult = await client.listTools(
      cursor === undefined ? undefined : { cursor },
    );
    tools.push(...(result?.tools ?? []));

    const next = result?.nextCursor;
    if (next === undefined || next === null || next === cursor || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }

  return mcpToolsToDefinitions(tools, options);
}

export interface RegisterMcpServerOptions extends DiscoverMcpToolsOptions {
  /** Replace tools already registered under the same name. Default `false`. */
  overwrite?: boolean;
}

/**
 * Discover a server's tools and register them — the one-call path from an MCP
 * connection to a registry that `codeflow generate` can turn into `tools.d.ts`.
 */
export async function registerMcpServer(
  registry: McpToolRegistrar,
  client: McpToolClient,
  options: RegisterMcpServerOptions,
): Promise<McpToolDefinition[]> {
  const definitions = await discoverMcpTools(client, options);
  return registerMcpTools(registry, definitions, options);
}

/** Register already-mapped definitions. Split out so discovery can be inspected first. */
export function registerMcpTools(
  registry: McpToolRegistrar,
  definitions: readonly McpToolDefinition[],
  options: { overwrite?: boolean } = {},
): McpToolDefinition[] {
  for (const definition of definitions) {
    registry.registerTool(definition, { overwrite: options.overwrite === true });
  }
  return [...definitions];
}
