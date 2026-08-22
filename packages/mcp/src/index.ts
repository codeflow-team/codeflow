/**
 * `@codeflow/mcp` — the optional MCP adapter (05-registry.md §3, 02 §2).
 *
 * ```ts
 * import { registerMcpServer } from "@codeflow/mcp";
 *
 * await registerMcpServer(registry, client, { namespace: "github" });
 * // → registry now holds github.getIssue, github.listPRs, … and
 * //   `codeflow generate` emits them into generated/tools.d.ts.
 * ```
 *
 * Core never depends on MCP; this package depends on core for **types only**.
 * Nothing here opens a connection: the caller owns the client and its transport,
 * so `@modelcontextprotocol/sdk` is an optional peer — an SDK `Client` is
 * accepted, and so is any object with a `listTools()`.
 *
 * Post-MVP (10 §3): the reverse direction — exposing CodeFlow itself as an MCP
 * server with a `codeflow://context` resource and a `codeflow.validate` tool.
 */

export {
  discoverMcpTools,
  editableFieldsOf,
  mcpToolToDefinition,
  mcpToolsToDefinitions,
  registerMcpServer,
  registerMcpTools,
} from "./adapter.js";
export type {
  DiscoverMcpToolsOptions,
  MapMcpToolOptions,
  RegisterMcpServerOptions,
} from "./adapter.js";

export {
  humanize,
  isValidIdentifier,
  slugifyMethod,
  slugifyNamespace,
  uniqueMethod,
  words,
} from "./names.js";

export type {
  McpAdapterOptions,
  McpIcon,
  McpJsonSchema,
  McpListToolsResult,
  McpTool,
  McpToolAnnotations,
  McpToolClient,
  McpToolDefinition,
  McpToolOrigin,
  McpToolRegistrar,
} from "./types.js";
