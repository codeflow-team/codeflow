/**
 * Bring-your-own MCP servers — the data model, and the one function that turns
 * a list of them into a registry.
 *
 * This is the feature the architecture was written for. Core knows no tool
 * (00 §6.6b): everything that can become a node arrives through the registry at
 * runtime (05 §3). So pointing the demo at *your* MCP server should make your
 * tools appear as palette entries, as `tools.d.ts` for the AI, as nodes in the
 * graph and as bindings when you press Run — with no change to core, and none
 * to the analyzer. `compose()` below is the whole seam: `McpServerConfig[]` in,
 * an `ExampleRegistry` out, which is the same shape the five built-in example
 * registries already have.
 *
 * Two decisions worth stating:
 *
 *  - **discovery is persisted, not re-run.** A `ToolDefinition` is exactly what
 *    a `tools/list` payload maps to (05 §3) and it is plain JSON, so the whole
 *    mapped set is kept in `localStorage`. A reload rebuilds the registry
 *    without touching the network or spawning anything — which is the only way
 *    the flow on screen can still be analyzed against the registry it was
 *    written against.
 *  - **the namespace is the user's**, because `tools.<ns>.<method>` is what the
 *    flow code will literally say. Changing it renames every tool of that
 *    server, which changes the registry hash, which makes the open graph stale
 *    (06 §5) — that is not a bug to hide, it is the mechanism working.
 */

import type { FunctionDefinition, ToolDefinition } from "@codeflow/core";
import { slugifyNamespace } from "@codeflow/mcp";
import type { ExampleRegistry } from "../examples-source.js";

export type McpTransport = "stdio" | "http" | "sse";

/** One tool as it was discovered, kept in the shape the adapter produced. */
export interface McpToolRecord {
  /** Slugged method segment — the `<method>` of `tools.<ns>.<method>`. */
  method: string;
  /** The MCP tool name, verbatim — what `tools/call` must be given. */
  toolName: string;
  label: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  editableFields?: string[];
  icon?: string;
}

export interface McpDiscovery {
  /** Epoch ms. */
  at: number;
  /** Whether the browser reached the server itself, or the dev server did. */
  via: "browser" | "server";
  /** What the transport turned out to be — `stdio`, `streamable-http`, `sse`. */
  transport: string;
  serverName?: string;
  serverVersion?: string;
  tools: McpToolRecord[];
}

export interface McpServerConfig {
  id: string;
  /** What the user calls it. Also the default source of the namespace. */
  name: string;
  /** `tools.<namespace>.*`. Always a valid identifier path. */
  namespace: string;
  transport: McpTransport;
  /** stdio */
  command?: string;
  args?: string[];
  /** remote */
  url?: string;
  headerName?: string;
  /** Only present when the user asked for it to be remembered — see `storage.ts`. */
  headerValue?: string;
  /** Whether the token above is written to disk. */
  rememberToken?: boolean;
  /** Included in the composed registry. */
  enabled: boolean;
  /** Which methods are included. `null` means "all of them". */
  selected: string[] | null;
  /** Quick-add entry this came from, if any. */
  catalogId?: string;
  discovery: McpDiscovery | null;
  /** Last discovery failure, kept so the row can say what went wrong. */
  error?: string | null;
}

export type ServerStatus = "connected" | "failed" | "not-connected";

export function statusOf(config: McpServerConfig): ServerStatus {
  if (config.discovery !== null) return "connected";
  if (typeof config.error === "string" && config.error.length > 0) return "failed";
  return "not-connected";
}

/** Tools of a server that are actually included, respecting `selected`. */
export function includedTools(config: McpServerConfig): McpToolRecord[] {
  const tools = config.discovery?.tools ?? [];
  if (config.selected === null) return tools;
  const wanted = new Set(config.selected);
  return tools.filter((tool) => wanted.has(tool.method));
}

export function isSelected(config: McpServerConfig, method: string): boolean {
  return config.selected === null || config.selected.includes(method);
}

/** Toggle one tool, normalizing "everything is selected" back to `null`. */
export function toggleTool(config: McpServerConfig, method: string): McpServerConfig {
  const all = (config.discovery?.tools ?? []).map((tool) => tool.method);
  const current = config.selected === null ? all : config.selected;
  const next = current.includes(method)
    ? current.filter((entry) => entry !== method)
    : [...current, method];
  return { ...config, selected: next.length === all.length ? null : next };
}

export function selectAll(config: McpServerConfig, on: boolean): McpServerConfig {
  return { ...config, selected: on ? null : [] };
}

/**
 * The namespace a server gets when the user has not chosen one.
 *
 * A slug, because it becomes a property path in the generated `Tools` interface
 * (05 §2) and TypeScript has to parse it.
 */
export function defaultNamespace(name: string): string {
  const slug = slugifyNamespace(name.replace(/^@[^/]+\//, "").replace(/^(?:mcp|server)[-_]/i, ""));
  return slug.length === 0 ? "mcp" : slug;
}

export function newServerId(): string {
  return `srv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

/* -------------------------------------------------------------------------- */
/* composing a registry                                                        */
/* -------------------------------------------------------------------------- */

export interface NamespaceCollision {
  namespace: string;
  /** Config ids claiming it, in configuration order. The first one wins. */
  serverIds: string[];
}

export interface ComposedRegistry {
  /** The registry, in the same shape the built-in examples use. */
  registry: ExampleRegistry;
  /** Servers that contributed at least one tool. */
  contributing: string[];
  /** Namespaces two enabled servers both claimed — the later ones are dropped. */
  collisions: NamespaceCollision[];
  /** Total tools in the registry. */
  toolCount: number;
}

/**
 * `McpServerConfig[]` → `ExampleRegistry`.
 *
 * Pure, and deliberately so: the same configuration always composes to the same
 * registry, therefore to the same `registryHash`, therefore to a graph whose
 * staleness check means something across reloads.
 *
 * **Collisions are refused, not merged.** Two servers under one namespace would
 * make `tools.fs.read` ambiguous — and worse, silently ambiguous, since the
 * second server's `read` would simply overwrite the first in the generated
 * interface. So the first server to claim a namespace keeps it, the rest are
 * reported, and the UI makes the user pick a different one.
 */
export function compose(
  configs: readonly McpServerConfig[],
  options: { baseFunctions?: FunctionDefinition[]; label?: string } = {},
): ComposedRegistry {
  const tools: ToolDefinition[] = [];
  const contributing: string[] = [];
  const claimed = new Map<string, string[]>();

  for (const config of configs) {
    if (!config.enabled || config.discovery === null) continue;
    const owners = claimed.get(config.namespace);
    if (owners !== undefined) {
      owners.push(config.id);
      continue;
    }
    claimed.set(config.namespace, [config.id]);

    const included = includedTools(config);
    if (included.length === 0) continue;
    contributing.push(config.id);

    for (const tool of included) {
      const definition: ToolDefinition = {
        name: `${config.namespace}.${tool.method}`,
        label: tool.label,
        inputSchema: tool.inputSchema as ToolDefinition["inputSchema"],
      };
      if (tool.description !== undefined && tool.description.length > 0) {
        definition.description = tool.description;
      }
      if (tool.outputSchema !== undefined) {
        definition.outputSchema = tool.outputSchema as ToolDefinition["outputSchema"];
      }
      if (tool.editableFields !== undefined && tool.editableFields.length > 0) {
        definition.editableFields = tool.editableFields;
      }
      if (tool.icon !== undefined) definition.icon = tool.icon;
      tools.push(definition);
    }
  }

  const collisions: NamespaceCollision[] = [...claimed.entries()]
    .filter(([, serverIds]) => serverIds.length > 1)
    .map(([namespace, serverIds]) => ({ namespace, serverIds }));

  // Sorted by name: the registry's own listing is sorted (05 §2) and a stable
  // input makes the composed id stable too.
  tools.sort((a, b) => a.name.localeCompare(b.name));

  const registry: ExampleRegistry = {
    id: `mcp:${signature(tools)}`,
    label: options.label ?? "Your MCP servers",
    tools,
    functions: options.baseFunctions ?? [],
  };

  return { registry, contributing, collisions, toolCount: tools.length };
}

/**
 * A short, stable fingerprint of a composed tool list.
 *
 * Not `registryHash` — that is core's, it is async-free but lives on a built
 * registry, and this is needed *before* one exists, to key the instance cache.
 * A cheap FNV-1a over the sorted names and schema shapes is enough for "is this
 * the same composition as last time".
 */
function signature(tools: readonly ToolDefinition[]): string {
  let hash = 0x811c9dc5;
  const text = tools.map((tool) => `${tool.name}|${JSON.stringify(tool.inputSchema)}`).join("\n");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/* -------------------------------------------------------------------------- */
/* the run request                                                             */
/* -------------------------------------------------------------------------- */

/** What the runner needs to actually start (or reach) one server. */
export interface RunServerSpec {
  namespace: string;
  server: string;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  /** `tools.<ns>.<method>` → the MCP tool name to call. */
  methods: Record<string, string>;
}

/**
 * Turn the enabled servers into run specs.
 *
 * The method map is sent explicitly rather than re-derived on the server. The
 * built-in allowlist reverses its own slugging with `strip`/`rename` rules,
 * which works because those registries were *generated* with them — for a
 * server the user just added, the only authority on "which MCP tool is
 * `tools.fs.readFile`?" is the discovery that produced the name.
 */
export function runSpecs(
  configs: readonly McpServerConfig[],
  tokenFor: (config: McpServerConfig) => string | undefined,
): RunServerSpec[] {
  const specs: RunServerSpec[] = [];
  const claimed = new Set<string>();

  for (const config of configs) {
    if (!config.enabled || config.discovery === null) continue;
    if (claimed.has(config.namespace)) continue;
    const included = includedTools(config);
    if (included.length === 0) continue;
    claimed.add(config.namespace);

    const methods: Record<string, string> = {};
    for (const tool of included) methods[tool.method] = tool.toolName;

    const token = tokenFor(config);
    const headers =
      config.headerName !== undefined && config.headerName.length > 0 && token !== undefined && token.length > 0
        ? { [config.headerName]: token }
        : undefined;

    specs.push({
      namespace: config.namespace,
      server: config.name,
      transport: config.transport,
      ...(config.command === undefined ? {} : { command: config.command }),
      ...(config.args === undefined ? {} : { args: config.args }),
      ...(config.url === undefined ? {} : { url: config.url }),
      ...(headers === undefined ? {} : { headers }),
      methods,
    });
  }

  return specs;
}

/* -------------------------------------------------------------------------- */
/* command line parsing                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Split `npx -y @modelcontextprotocol/server-filesystem /tmp/scratch` into a
 * command and its arguments.
 *
 * Quotes are honoured so a path with a space survives; nothing else is
 * interpreted. In particular there is **no shell**: no pipes, no `&&`, no
 * globbing, no variable expansion. The string is split and handed to `spawn`,
 * which is the difference between "start this program" and "run this script".
 */
export function parseCommand(line: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let has = false;

  for (const char of line.trim()) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      has = true;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      has = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (has) parts.push(current);
      current = "";
      has = false;
      continue;
    }
    current += char;
    has = true;
  }
  if (has) parts.push(current);

  return { command: parts[0] ?? "", args: parts.slice(1) };
}

export function formatCommand(config: McpServerConfig): string {
  return [config.command ?? "", ...(config.args ?? [])]
    .filter((part) => part.length > 0)
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}
