/**
 * The MCP surface this adapter reads — 05-registry.md §3.
 *
 * Written as plain structural types rather than re-exported SDK types on
 * purpose:
 *
 *  - a mock client (`{ listTools() { … } }`) is all a unit test needs, so nothing
 *    here forces a transport, a process or a network connection;
 *  - the shapes are a subset of the SDK's `Tool` / `Client`, so a real
 *    `@modelcontextprotocol/sdk` client is accepted as is (the test suite pins
 *    that with a compile-time assignability check).
 *
 * Everything imported from `@codeflow-team/core` in this package is a **type**: the
 * dependency direction is core ← mcp, never the reverse (02 §2), and the adapter
 * ships no runtime coupling to core at all.
 */

import type { ToolDefinition } from "@codeflow-team/core";

/** JSON Schema as MCP carries it — a draft-standard object, not re-modelled here. */
export type McpJsonSchema = Record<string, unknown>;

/** MCP tool annotations (only the field the adapter reads is required to exist). */
export interface McpToolAnnotations {
  title?: string | undefined;
  readOnlyHint?: boolean | undefined;
  destructiveHint?: boolean | undefined;
  idempotentHint?: boolean | undefined;
  openWorldHint?: boolean | undefined;
}

export interface McpIcon {
  src: string;
  mimeType?: string | undefined;
  sizes?: readonly string[] | undefined;
}

/** One tool as an MCP server describes it (`tools/list`). */
export interface McpTool {
  name: string;
  title?: string | undefined;
  description?: string | undefined;
  inputSchema?: McpJsonSchema | undefined;
  outputSchema?: McpJsonSchema | undefined;
  annotations?: McpToolAnnotations | undefined;
  icons?: readonly McpIcon[] | undefined;
  _meta?: Record<string, unknown> | undefined;
}

/** Result of `tools/list`; `nextCursor` drives pagination. */
export interface McpListToolsResult {
  tools: McpTool[];
  nextCursor?: string | undefined;
}

/**
 * The one method the adapter calls. `@modelcontextprotocol/sdk`'s `Client`
 * satisfies it, and so does a two-line fake.
 */
export interface McpToolClient {
  listTools(params?: { cursor?: string | undefined } | undefined, ...rest: never[]): Promise<McpListToolsResult>;
}

/**
 * Where a generated `ToolDefinition` came from — the original MCP identity,
 * preserved because the CodeFlow name is a *slug* of it (see `slugifyMethod`).
 * Without this, `github.getIssue` would no longer tell anyone which MCP tool to
 * invoke at runtime.
 *
 * It rides along as an extra property on the definition. Core ignores unknown
 * properties, and `registryHash` hashes named fields only (registry/hash.ts), so
 * carrying provenance never changes a registry fingerprint.
 */
export interface McpToolOrigin {
  /** Namespace the tool was mounted under — `github` in `github.getIssue`. */
  namespace: string;
  /** Method segment after slugging — `getIssue`. */
  method: string;
  /** The MCP tool name, verbatim — `get-issue`, `get_issue`, `GET ISSUE!`… */
  toolName: string;
  /** False when the MCP name already was a valid method identifier. */
  renamed: boolean;
  /** Optional label for the server the tool was discovered on. */
  server?: string;
}

/** A `ToolDefinition` that remembers the MCP tool it was mapped from. */
export interface McpToolDefinition extends ToolDefinition {
  mcp: McpToolOrigin;
}

export interface McpAdapterOptions {
  /**
   * Namespace the server's tools are mounted under — the `<ns>` of
   * `<ns>.<method>` (05 §1). Slugged the same way method names are, and may be
   * dotted (`acme.github`) to nest one level deeper.
   */
  namespace: string;
  /** Recorded in `mcp.server`; purely informational. */
  server?: string;
  /**
   * Derive `editableFields` from the top-level properties of the input schema
   * (06 §1) so the inspector has something to render. Default `true`; pass
   * `false` to leave the definition without editable fields.
   */
  deriveEditableFields?: boolean;
  /**
   * Override the method segment for a tool. Returning a non-identifier string is
   * still slugged — the result always reaches the registry as a valid name.
   */
  methodName?: (tool: McpTool) => string;
}

/** The slice of `Registry` the adapter needs — it never reads the registry back. */
export interface McpToolRegistrar {
  registerTool(definition: ToolDefinition, options?: { overwrite?: boolean }): void;
}
