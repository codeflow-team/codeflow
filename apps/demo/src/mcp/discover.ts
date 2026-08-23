/**
 * Asking a server what it can do.
 *
 * Two paths, tried in that order:
 *
 *  1. **the browser itself**, for a Streamable-HTTP endpoint whose operator
 *     sends permissive CORS headers. This is the path that matters for the
 *     deployed build: a static bundle on a CDN has no server behind it, so if
 *     the page cannot make the call, nobody can. Roughly sixty lines of `fetch`
 *     — the MCP SDK is deliberately *not* pulled into the bundle for this.
 *  2. **`POST /api/mcp/discover`**, the dev server, which owns the MCP SDK and
 *     therefore stdio, SSE, and every endpoint that refuses cross-origin
 *     requests.
 *
 * Both ends run the same mapping — `mcpToolsToDefinitions` from `@codeflow/mcp`
 * (05 §3). There is one adapter in this repo and neither path re-implements it.
 */

import { mcpToolsToDefinitions, type McpTool } from "@codeflow/mcp";
import { IS_PUBLIC_BUILD } from "../deployment.js";
import type { McpDiscovery, McpToolRecord, McpTransport } from "./model.js";

/** The revision this client speaks. Sent on every request, per the spec. */
const PROTOCOL_VERSION = "2025-06-18";
const BROWSER_TIMEOUT_MS = 20_000;

export interface DiscoverInput {
  transport: McpTransport;
  namespace: string;
  name: string;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
}

export type DiscoverOutcome =
  | { ok: true; discovery: McpDiscovery }
  | { ok: false; error: string; hint?: string };

export interface McpServerStatus {
  /** Is there a dev server behind this page at all? */
  available: boolean;
  /** Will it spawn a process? */
  stdio: boolean;
  stdioReason: string | null;
}

export async function fetchMcpStatus(): Promise<McpServerStatus> {
  if (IS_PUBLIC_BUILD) {
    return {
      available: false,
      stdio: false,
      stdioReason:
        "This is the hosted build — a static bundle with no server behind it, so there is no process to start a command in. Remote (URL) servers work here; stdio ones need a local checkout.",
    };
  }
  try {
    const response = await fetch("/api/mcp/status");
    if (!response.ok) throw new Error(String(response.status));
    const status = (await response.json()) as { stdio?: boolean; stdioReason?: string | null };
    return {
      available: true,
      stdio: status.stdio === true,
      stdioReason: status.stdioReason ?? null,
    };
  } catch {
    return {
      available: false,
      stdio: false,
      stdioReason:
        "No dev server answered, so nothing here can start a command. Remote (URL) servers still work; stdio ones need `pnpm dev`.",
    };
  }
}

/** `tools/list` entries → the records a config stores. */
export function toRecords(tools: readonly McpTool[], namespace: string, server: string): McpToolRecord[] {
  return mcpToolsToDefinitions([...tools], { namespace, server }).map((definition) => {
    const record: McpToolRecord = {
      method: definition.mcp.method,
      toolName: definition.mcp.toolName,
      label: definition.label,
      inputSchema: definition.inputSchema,
    };
    if (definition.description !== undefined) record.description = definition.description;
    if (definition.outputSchema !== undefined) record.outputSchema = definition.outputSchema;
    if (definition.editableFields !== undefined) {
      record.editableFields = definition.editableFields.map((field) =>
        typeof field === "string" ? field : field.name,
      );
    }
    if (definition.icon !== undefined) record.icon = definition.icon;
    return record;
  });
}

export async function discoverServer(input: DiscoverInput): Promise<DiscoverOutcome> {
  if (input.transport !== "stdio" && typeof input.url === "string" && input.url.length > 0) {
    const direct = await discoverInBrowser(input);
    if (direct.ok) return direct;
    // Not a failure yet — the endpoint may simply not allow this origin. Ask
    // the dev server, and if there is none, report the browser's own error.
    const viaServer = await discoverOnServer(input);
    if (viaServer.ok) return viaServer;
    return {
      ok: false,
      error: viaServer.error,
      hint:
        viaServer.hint ??
        `The browser could not reach it either: ${direct.error}. A remote server has to send CORS headers for a page to call it directly.`,
    };
  }
  return await discoverOnServer(input);
}

/* -------------------------------------------------------------------------- */
/* path 1 — straight from the page                                             */
/* -------------------------------------------------------------------------- */

interface JsonRpcResponse {
  result?: unknown;
  error?: { code?: number; message?: string };
}

/**
 * One Streamable-HTTP request/response pair.
 *
 * The transport allows either a plain JSON body or an SSE stream carrying the
 * one message, and servers genuinely differ, so both are read.
 */
async function rpc(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
): Promise<{ response: Response; message: JsonRpcResponse | null }> {
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOL_VERSION,
      ...headers,
    },
    body: JSON.stringify(body),
  });

  if (response.status === 202 || response.status === 204) return { response, message: null };
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${String(response.status)}${text.length > 0 ? `: ${text.slice(0, 200)}` : ""}`);
  }
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload.length === 0) continue;
      try {
        const parsed = JSON.parse(payload) as JsonRpcResponse & { id?: unknown };
        if (parsed.id !== undefined) return { response, message: parsed };
      } catch {
        /* a frame that is not the answer; keep reading */
      }
    }
    return { response, message: null };
  }
  return { response, message: text.length === 0 ? null : (JSON.parse(text) as JsonRpcResponse) };
}

async function discoverInBrowser(input: DiscoverInput): Promise<DiscoverOutcome> {
  const url = input.url;
  if (url === undefined) return { ok: false, error: "No URL." };

  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, BROWSER_TIMEOUT_MS);
  const started = Date.now();

  try {
    const headers: Record<string, string> = { ...(input.headers ?? {}) };

    const init = await rpc(
      url,
      headers,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "codeflow-demo", version: "0.0.0" },
        },
      },
      controller.signal,
    );
    if (init.message?.error !== undefined) {
      throw new Error(init.message.error.message ?? "initialize was refused");
    }
    // Exposed only when the operator lists it in `Access-Control-Expose-Headers`.
    // A stateless server does not issue one at all, which is also fine.
    const session = init.response.headers.get("mcp-session-id");
    if (session !== null) headers["Mcp-Session-Id"] = session;

    await rpc(url, headers, { jsonrpc: "2.0", method: "notifications/initialized" }, controller.signal);

    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page += 1) {
      const listed = await rpc(
        url,
        headers,
        {
          jsonrpc: "2.0",
          id: page + 2,
          method: "tools/list",
          params: cursor === undefined ? {} : { cursor },
        },
        controller.signal,
      );
      if (listed.message?.error !== undefined) {
        throw new Error(listed.message.error.message ?? "tools/list was refused");
      }
      const result = (listed.message?.result ?? {}) as { tools?: McpTool[]; nextCursor?: string };
      tools.push(...(result.tools ?? []));
      if (result.nextCursor === undefined || result.nextCursor === cursor) break;
      cursor = result.nextCursor;
    }

    const info = ((init.message?.result ?? {}) as { serverInfo?: { name?: string; version?: string } }).serverInfo;

    return {
      ok: true,
      discovery: {
        at: Date.now(),
        via: "browser",
        transport: "streamable-http",
        ...(info?.name === undefined ? {} : { serverName: info.name }),
        ...(info?.version === undefined ? {} : { serverVersion: info.version }),
        tools: toRecords(tools, input.namespace, input.name),
      },
    };
  } catch (cause) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      error: aborted
        ? `No answer within ${String(Math.round(BROWSER_TIMEOUT_MS / 1000))}s (${String(Date.now() - started)}ms elapsed).`
        : cause instanceof Error
          ? cause.message
          : String(cause),
    };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* path 2 — the dev server                                                     */
/* -------------------------------------------------------------------------- */

async function discoverOnServer(input: DiscoverInput): Promise<DiscoverOutcome> {
  if (IS_PUBLIC_BUILD) {
    return {
      ok: false,
      error:
        input.transport === "stdio"
          ? "This build cannot start a command — it is a static page with no server behind it."
          : "That endpoint did not allow this page to call it, and this build has no server to call it for you.",
      hint:
        input.transport === "stdio"
          ? "Clone the repo and run `pnpm dev` to add stdio servers."
          : "Try an endpoint that sends CORS headers, or run the repo locally.",
    };
  }

  try {
    const response = await fetch("/api/mcp/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transport: input.transport,
        namespace: input.namespace,
        server: input.name,
        ...(input.command === undefined ? {} : { command: input.command }),
        ...(input.args === undefined ? {} : { args: input.args }),
        ...(input.url === undefined ? {} : { url: input.url }),
        ...(input.headers === undefined ? {} : { headers: input.headers }),
      }),
    });

    const type = response.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) {
      return {
        ok: false,
        error: "There is no discovery endpoint behind this page.",
        hint: "Run the demo with `pnpm dev` to add stdio servers, or use a remote endpoint that allows browser calls.",
      };
    }

    const payload = (await response.json()) as {
      ok?: boolean;
      tools?: McpTool[];
      serverInfo?: { name?: string; version?: string };
      transport?: string;
      error?: string;
      hint?: string;
    };

    if (payload.ok !== true) {
      return {
        ok: false,
        error: payload.error ?? `Discovery failed (HTTP ${String(response.status)}).`,
        ...(payload.hint === undefined ? {} : { hint: payload.hint }),
      };
    }

    return {
      ok: true,
      discovery: {
        at: Date.now(),
        via: "server",
        transport: payload.transport ?? input.transport,
        ...(payload.serverInfo?.name === undefined ? {} : { serverName: payload.serverInfo.name }),
        ...(payload.serverInfo?.version === undefined ? {} : { serverVersion: payload.serverInfo.version }),
        tools: toRecords(payload.tools ?? [], input.namespace, input.name),
      },
    };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message : String(cause),
      hint: "The dev server may have restarted — reload the page and try again.",
    };
  }
}
