/**
 * `POST /api/mcp/discover` — connect to an MCP server, list its tools, map them
 * to `ToolDefinition`s, disconnect.
 *
 * ## Why the server does this at all
 *
 * Two of the three transports a visitor might name cannot be reached from a
 * page:
 *
 *  - **stdio** needs a child process, which a browser does not have;
 *  - **remote HTTP/SSE** *can* be reached from a page, but only when the
 *    endpoint sends permissive CORS headers. Many do not. The browser tries
 *    first (`src/mcp/discover.ts`) and falls back here, so a deployed build
 *    keeps every server whose operator allowed it and a local checkout gets all
 *    of them.
 *
 * The mapping is **not** re-implemented here: `mcpToolsToDefinitions` from
 * `@codeflow/mcp` is the one adapter (05 §3), and this endpoint is a transport
 * plus a timeout around it.
 *
 * ## Security — read this before changing anything
 *
 * Spawning a command a web page typed is remote code execution on this machine.
 * Three gates, all of them load-bearing:
 *
 *  1. **loopback only.** `vite --host` puts the dev server on the LAN; a stdio
 *     discover from a non-loopback peer is refused. Remote (URL) discovery is
 *     still allowed there, because it spawns nothing.
 *  2. **`Content-Type: application/json` required.** That header is not a CORS
 *     "simple" request, so a drive-by page on another origin cannot send it to
 *     `localhost:5173` without a preflight — and this server answers no
 *     preflight. That is the CSRF gate.
 *  3. **off by an env switch.** `CODEFLOW_MCP_STDIO=0` (or building the public
 *     demo with `VITE_PUBLIC_DEMO=1`) turns spawning off entirely, so the same
 *     tree can be served somewhere it must not run commands.
 *
 * The command still runs with the developer's own permissions. Nothing here
 * pretends otherwise, and the UI says it in words before the first stdio add.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { mcpToolsToDefinitions, type McpTool } from "@codeflow/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

/** How long a discovery may take before it is abandoned. */
export const DISCOVER_TIMEOUT_MS = 30_000;
export const MAX_DISCOVER_TIMEOUT_MS = 120_000;
/** A loop guard on `tools/list` pagination, not a limit on tools. */
const MAX_PAGES = 50;

export interface DiscoverRequest {
  transport?: "stdio" | "http" | "sse";
  namespace?: string;
  server?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface DiscoverResponse {
  ok: boolean;
  /** Raw `tools/list` entries, verbatim — the payload before any mapping. */
  tools?: McpTool[];
  /** The same tools after `@codeflow/mcp`'s adapter. */
  definitions?: unknown[];
  serverInfo?: { name?: string; version?: string } | undefined;
  transport?: string;
  ms?: number;
  error?: string;
  /** One sentence a reader can act on. */
  hint?: string;
}

/** Is spawning a process allowed in this process? */
export function stdioAllowed(): boolean {
  if (process.env["VITE_PUBLIC_DEMO"] === "1") return false;
  return process.env["CODEFLOW_MCP_STDIO"] !== "0";
}

export function stdioDisabledReason(): string {
  if (process.env["VITE_PUBLIC_DEMO"] === "1") {
    return "This build is the public demo, which must never spawn a command. Add a remote (URL) server instead, or run the repo locally.";
  }
  return "Spawning MCP servers is turned off here (CODEFLOW_MCP_STDIO=0). Add a remote (URL) server instead.";
}

function isLoopback(req: IncomingMessage): boolean {
  const address = req.socket.remoteAddress ?? "";
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address.startsWith("127.")
  );
}

function readBody(req: IncomingMessage, limitBytes = 256_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => { resolve(Buffer.concat(chunks).toString("utf8")); });
    req.on("error", reject);
  });
}

/**
 * Turn a transport failure into something a person can fix.
 *
 * "spawn npx ENOENT" is the single most common outcome of this feature and it
 * says nothing to someone who typed a package name into a box, so the two
 * failures that actually happen get named.
 */
function explain(cause: unknown, request: DiscoverRequest): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code = (cause as { code?: string } | null)?.code;

  if (code === "ENOENT" || /ENOENT/.test(message)) {
    return `\`${request.command ?? "the command"}\` was not found on this machine's PATH. Install it, or use the full path.`;
  }
  if (/EACCES/.test(message)) {
    return `\`${request.command ?? "the command"}\` is not executable by this user.`;
  }
  if (/ECONNREFUSED/.test(message)) {
    return `Nothing is listening at ${request.url ?? "that URL"}.`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
    return `That host could not be resolved (${request.url ?? "?"}). Check the URL, and this machine's network.`;
  }
  if (/\b40[13]\b/.test(message)) {
    return "The endpoint refused the connection as unauthorized — it needs a token, so it is not one of the open servers.";
  }
  if (/\b404\b/.test(message)) {
    return "The endpoint answered 404. Remote MCP servers usually live at a path like `/mcp` or `/sse` — check which one this server publishes.";
  }
  // A URL that is a web page rather than an MCP endpoint answers 200 with a
  // whole HTML document, and pasting that document into the error is not an
  // error message.
  if (/<!doctype html|<html[\s>]/i.test(message)) {
    return "That URL answered with an HTML page rather than MCP. It is probably a website, not an MCP endpoint — look for the `/mcp` or `/sse` path the server publishes.";
  }
  return message.length > 400 ? `${message.slice(0, 400)}…` : message;
}

async function connectClient(request: DiscoverRequest, signal: AbortSignal): Promise<{
  client: Client;
  close: () => Promise<void>;
  transportName: string;
}> {
  const client = new Client({ name: "codeflow-demo-discover", version: "0.0.0" }, {});

  if (request.transport === "stdio") {
    if (typeof request.command !== "string" || request.command.trim().length === 0) {
      throw new Error("A stdio server needs a `command`.");
    }
    const transport = new StdioClientTransport({
      command: request.command,
      args: request.args ?? [],
      env: { ...(process.env as Record<string, string>), ...(request.env ?? {}) },
      stderr: "pipe",
    });
    // The server's own stderr is the only place a "missing argument" or a
    // "directory does not exist" ever shows up; keep the tail for the error.
    let stderr = "";
    transport.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2000);
    });
    try {
      await client.connect(transport, { signal });
    } catch (cause) {
      const detail = stderr.trim();
      await transport.close().catch(() => undefined);
      throw new Error(detail.length > 0 ? `${explain(cause, request)}\n\n${detail}` : explain(cause, request));
    }
    return {
      client,
      close: async () => { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); },
      transportName: "stdio",
    };
  }

  if (typeof request.url !== "string" || request.url.trim().length === 0) {
    throw new Error("A remote server needs a `url`.");
  }
  const url = new URL(request.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Only http(s) MCP endpoints are supported.");
  }
  const headers = request.headers ?? {};
  const requestInit = Object.keys(headers).length === 0 ? undefined : { headers };

  // Streamable HTTP is the current transport; SSE is the 2024 one and still
  // what several published endpoints speak. Try the named one, then the other,
  // because "which of the two is this URL?" is exactly what a person adding a
  // server does not know.
  const order: ("http" | "sse")[] = request.transport === "sse" ? ["sse", "http"] : ["http", "sse"];
  const failures: string[] = [];
  for (const kind of order) {
    // The SSE transport opens its stream with a plain GET, so a token header
    // has to ride on the custom `fetch` rather than on `requestInit` (which
    // only covers the POSTs back).
    const withHeaders = async (input: string | URL, init?: RequestInit): Promise<Response> =>
      await fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...headers } });
    const transport =
      kind === "http"
        ? new StreamableHTTPClientTransport(url, requestInit === undefined ? {} : { requestInit })
        : new SSEClientTransport(url, requestInit === undefined ? {} : { requestInit, fetch: withHeaders });
    try {
      await client.connect(transport, { signal });
      return {
        client,
        close: async () => { await client.close().catch(() => undefined); await transport.close().catch(() => undefined); },
        transportName: kind === "http" ? "streamable-http" : "sse",
      };
    } catch (cause) {
      // Both attempts are reported, not just the last: "404" from the SSE probe
      // is a confusing thing to show for an endpoint whose real problem was
      // something the Streamable-HTTP attempt said.
      failures.push(`${kind === "http" ? "Streamable HTTP" : "SSE"}: ${explain(cause, request)}`);
      await transport.close().catch(() => undefined);
      if (signal.aborted) break;
    }
  }
  throw new Error(failures.join("\n"));
}

export async function discover(request: DiscoverRequest): Promise<DiscoverResponse> {
  const started = Date.now();
  const timeoutMs = Math.min(Math.max(request.timeoutMs ?? DISCOVER_TIMEOUT_MS, 1_000), MAX_DISCOVER_TIMEOUT_MS);
  const controller = new AbortController();
  const timer = setTimeout(() => { controller.abort(); }, timeoutMs);

  let close: (() => Promise<void>) | null = null;
  try {
    const connection = await connectClient(request, controller.signal);
    close = connection.close;

    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const listed = await connection.client.listTools(
        cursor === undefined ? undefined : { cursor },
        { signal: controller.signal },
      );
      tools.push(...((listed.tools ?? []) as McpTool[]));
      const next = listed.nextCursor;
      if (next === undefined || next === null || next === cursor) break;
      cursor = next;
    }

    const definitions = mcpToolsToDefinitions(tools, {
      namespace: request.namespace ?? "mcp",
      ...(request.server === undefined ? {} : { server: request.server }),
    });

    const info = connection.client.getServerVersion();
    return {
      ok: true,
      tools,
      definitions,
      serverInfo: info === undefined ? undefined : { name: info.name, version: info.version },
      transport: connection.transportName,
      ms: Date.now() - started,
    };
  } catch (cause) {
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      ms: Date.now() - started,
      error: aborted
        ? `The server did not answer within ${String(Math.round(timeoutMs / 1000))}s.`
        : cause instanceof Error
          ? cause.message
          : String(cause),
      ...(aborted
        ? { hint: "A first `npx -y …` downloads the package, which can be slow. Try again once it is cached." }
        : {}),
    };
  } finally {
    clearTimeout(timer);
    if (close !== null) await close();
  }
}

type Middleware = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Vite dev-server plugin: `/api/mcp/status` and `/api/mcp/discover`.
 *
 * Sits next to `/api/ai` and `/api/run` for the same reason they do — a thing
 * the browser cannot do, done on the Node side.
 */
export function mcpPlugin(): {
  name: string;
  configureServer: (server: { middlewares: { use: (path: string, handler: Middleware) => void } }) => void;
} {
  return {
    name: "codeflow:mcp",
    configureServer(server) {
      server.middlewares.use("/api/mcp/status", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            available: true,
            stdio: stdioAllowed(),
            stdioReason: stdioAllowed() ? null : stdioDisabledReason(),
            timeoutMs: DISCOVER_TIMEOUT_MS,
          }),
        );
      });

      server.middlewares.use("/api/mcp/discover", (req, res) => {
        res.setHeader("Content-Type", "application/json");
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end(JSON.stringify({ ok: false, error: "POST only" }));
          return;
        }
        // Gate 2 — see the header comment. A cross-origin page cannot set this
        // without a preflight, and this server answers none.
        if (!(req.headers["content-type"] ?? "").includes("application/json")) {
          res.statusCode = 415;
          res.end(JSON.stringify({ ok: false, error: "Content-Type: application/json is required." }));
          return;
        }

        void (async () => {
          let request: DiscoverRequest;
          try {
            request = JSON.parse(await readBody(req)) as DiscoverRequest;
          } catch (cause) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: cause instanceof Error ? cause.message : String(cause) }));
            return;
          }

          if (request.transport === "stdio") {
            if (!stdioAllowed()) {
              res.statusCode = 403;
              res.end(JSON.stringify({ ok: false, error: stdioDisabledReason() }));
              return;
            }
            // Gate 1 — `vite --host` is a LAN service; spawning for a LAN peer
            // would hand them a shell.
            if (!isLoopback(req)) {
              res.statusCode = 403;
              res.end(
                JSON.stringify({
                  ok: false,
                  error:
                    "stdio MCP servers can only be started from a browser on this machine (the request came from another host). Use a remote URL server instead.",
                }),
              );
              return;
            }
          }

          const result = await discover(request);
          res.statusCode = result.ok ? 200 : 502;
          res.end(JSON.stringify(result));
        })();
      });
    },
  };
}
