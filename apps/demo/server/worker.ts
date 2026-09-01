/**
 * The demo runner's execution thread.
 *
 * This is the half of the feature `@codeflow-team/core` is forbidden to contain
 * (00 §5, I7): it dynamically imports a module built from the user's flow and
 * calls it. It lives in a worker thread so the dev server can kill it — a
 * `while (true)` in a generated flow must cost one `terminate()`, not a
 * restarted Vite.
 *
 * What it provides to the flow:
 *
 *  - `globalThis.__cf` — the probe object the instrumenter's markers call. Every
 *    marker posts a `RunEvent` to the parent **immediately**; nothing is
 *    batched, because a trace that arrives all at once at the end is the same
 *    as no trace at all.
 *  - `tools` — the object the flow's second parameter is bound to. Per
 *    namespace it is either a real MCP client over stdio, or a stub that
 *    answers from the tool's declared `outputSchema`. Which one it was is
 *    reported up front and shown on every node, so nobody mistakes a sample for
 *    a fact.
 *
 * ⚠️ Not a sandbox. The worker shares the machine; it is unprivileged only in
 * the sense that it has no credentials and is given no network client other
 * than the MCP transports listed in `mcp-servers.ts`. A production runtime must
 * use real isolation (09 §1).
 */

import { parentPort, workerData } from "node:worker_threads";

import { slugifyMethod } from "@codeflow-team/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import { createProbe } from "./probe.ts";
import { preview, sampleFromSchema } from "./sample.ts";
import { explainStubbedPath, workspacePathsIn } from "./stub-paths.ts";
import type { McpServerPlan } from "./mcp-servers.ts";

export interface ToolBinding {
  /** `<namespace>.<method>` */
  name: string;
  outputSchema?: unknown;
  /**
   * The MCP tool name this method stands for, when the caller already knows it.
   *
   * For the built-in servers the name is reconstructed by re-running the same
   * slugging the example registries were generated with. For a server the user
   * added there is nothing to reconstruct from, so discovery's own answer is
   * carried here and used verbatim.
   */
  toolName?: string;
}

export interface WorkerJob {
  /** file:// URL of the instrumented module. */
  entry: string;
  input: unknown;
  tools: ToolBinding[];
  /** Namespaces bound to a real server, keyed by namespace. */
  servers: Record<string, McpServerPlan>;
  scratch: string;
  maxPreviewChars: number;
}

/**
 * One thing a node said mid-step, on the wire.
 *
 * This is core's `RunEmit` with one field widened: `nodeId` may be `null`. A
 * tool called from a statement no probe could bracket has no node to belong to,
 * and core's `RunEmit` — which exists to be folded *into* a node — has no way
 * to say that. Rather than drop the fact or invent an owner, it travels
 * unattributed and the client folds only the attributed ones.
 */
export interface EmitFrame {
  type: "emit";
  nodeId: string | null;
  at: number;
  kind: string;
  payload: unknown;
  iteration?: number[];
}

/** What a `kind: "tool-call"` emit carries. The demo's own kind, not core's. */
export interface ToolCallPayload {
  tool: string;
  mode: "mcp" | "stub";
  ms: number;
  ok: boolean;
  detail?: string;
}

type Outbound =
  | { type: "event"; nodeId: string; phase: string; at: number; durationMs?: number; preview?: unknown; error?: { message: string; stack?: string }; iteration?: number[] }
  | EmitFrame
  | { type: "ready"; namespaces: { namespace: string; mode: "mcp" | "stub"; server?: string; tools?: number; error?: string }[] }
  | { type: "done"; status: "ok" | "failed"; ms: number; result?: unknown; error?: { message: string; stack?: string } };

const job = workerData as WorkerJob;
const port = parentPort;
if (port === null) throw new Error("run worker must be started with a parentPort");

const startedAt = Date.now();
const now = (): number => Date.now() - startedAt;
const send = (message: Outbound): void => { port.postMessage(message); };

/* -------------------------------------------------------------------------- */
/* probes                                                                      */
/* -------------------------------------------------------------------------- */

/*
 * The marker protocol itself lives in `probe.ts` — including the rule for when
 * an event may carry a loop iteration and when it must carry none. It is a
 * module of its own because this file reads `workerData` at import time and so
 * cannot be loaded by a test, and those rules are exactly what has to be tested
 * against real instrumented programs.
 */
const probe = createProbe(
  (event) => { send({ type: "event", ...event }); },
  { now, preview: (value) => preview(value, job.maxPreviewChars) },
);

(globalThis as unknown as Record<string, unknown>)["__cf"] = probe;

/* -------------------------------------------------------------------------- */
/* tools                                                                       */
/* -------------------------------------------------------------------------- */

interface Connection {
  client: Client;
  transport: Transport;
  /** method name in `tools.<ns>` → the MCP tool name to call. */
  methods: Map<string, string>;
}

const connections = new Map<string, Connection>();
const namespaceStatus: { namespace: string; mode: "mcp" | "stub"; server?: string; tools?: number; error?: string }[] = [];

function methodNameFor(plan: McpServerPlan, toolName: string): string {
  const renamed = plan.rename?.[toolName];
  if (renamed !== undefined) return slugifyMethod(renamed);
  if (plan.strip !== null && toolName.startsWith(plan.strip)) {
    const rest = toolName.slice(plan.strip.length);
    if (rest.length > 0) return slugifyMethod(rest);
  }
  return slugifyMethod(toolName);
}

/**
 * Open the transport this plan describes.
 *
 * stdio is the built-in case and the one the allowlist is written for; the two
 * remote forms exist because a user-added server can be a URL, and a URL is the
 * only kind that can work on a machine that must not spawn anything.
 */
function transportFor(plan: McpServerPlan): Transport {
  if (plan.transport === "http" || plan.transport === "sse") {
    if (plan.url === undefined) throw new Error(`${plan.server} is a remote server with no URL.`);
    const url = new URL(plan.url);
    const headers = plan.headers ?? {};
    const requestInit = Object.keys(headers).length === 0 ? undefined : { headers };
    if (plan.transport === "sse") {
      return new SSEClientTransport(
        url,
        requestInit === undefined
          ? {}
          : {
              requestInit,
              fetch: async (input: string | URL, init?: RequestInit) =>
                await fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...headers } }),
            },
      );
    }
    return new StreamableHTTPClientTransport(url, requestInit === undefined ? {} : { requestInit });
  }

  if (plan.command === undefined) throw new Error(`${plan.server} is a stdio server with no command.`);
  const args = (plan.args ?? []).map((arg) => arg.replaceAll("{{scratch}}", job.scratch));
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [key, value] of Object.entries(plan.env ?? {})) {
    env[key] = value.replaceAll("{{scratch}}", job.scratch);
  }
  return new StdioClientTransport({ command: plan.command, args, env, stderr: "ignore" });
}

async function connect(namespace: string, plan: McpServerPlan): Promise<Connection> {
  const existing = connections.get(namespace);
  if (existing !== undefined) return existing;

  const transport = transportFor(plan);
  const client = new Client({ name: "codeflow-demo-runner", version: "0.0.0" }, {});
  await client.connect(transport);

  const methods = new Map<string, string>();
  // A method map that came with the plan is authoritative: it is what discovery
  // saw, and it is what the registry the flow was analyzed against was built
  // from. Listing again only fills in anything it did not cover.
  for (const [method, toolName] of Object.entries(plan.methods ?? {})) methods.set(method, toolName);
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const listed = await client.listTools(cursor === undefined ? undefined : { cursor });
    for (const tool of listed.tools ?? []) {
      const method = methodNameFor(plan, tool.name);
      if (!methods.has(method)) methods.set(method, tool.name);
    }
    if (listed.nextCursor === undefined || listed.nextCursor === cursor) break;
    cursor = listed.nextCursor;
  }

  const connection: Connection = { client, transport, methods };
  connections.set(namespace, connection);
  const entry = namespaceStatus.find((candidate) => candidate.namespace === namespace);
  if (entry !== undefined) entry.tools = methods.size;
  send({ type: "ready", namespaces: namespaceStatus });
  return connection;
}

/**
 * Turn one MCP `tools/call` result into the value the flow's types promise.
 *
 * A server that declares an `outputSchema` answers with `structuredContent`
 * shaped exactly like it, and that is what the generated `Tools` interface says
 * the call returns — so it is what the flow gets. Older servers answer only
 * with `content` blocks; those are folded into `{ content: <joined text> }`,
 * which is the shape the filesystem server's own schema uses and the shape the
 * example flows read.
 */
function unwrap(result: unknown): unknown {
  if (typeof result !== "object" || result === null) return result;
  const record = result as Record<string, unknown>;
  if (record["structuredContent"] !== undefined) return record["structuredContent"];
  const content = record["content"];
  if (Array.isArray(content)) {
    const text = content
      .map((block) => (typeof block === "object" && block !== null ? (block as Record<string, unknown>)["text"] : undefined))
      .filter((value): value is string => typeof value === "string")
      .join("\n");
    return { content: text };
  }
  return result;
}

function buildTools(): Record<string, Record<string, (args?: unknown) => Promise<unknown>>> {
  const out: Record<string, Record<string, (args?: unknown) => Promise<unknown>>> = {};

  for (const binding of job.tools) {
    const dot = binding.name.indexOf(".");
    if (dot === -1) continue;
    const namespace = binding.name.slice(0, dot);
    const method = binding.name.slice(dot + 1);
    const plan = job.servers[namespace];

    out[namespace] ??= {};
    out[namespace][method] = async (args?: unknown): Promise<unknown> => {
      const frame = probe.current();
      const at = now();
      const began = Date.now();
      // Read before the call, beside `at`: by the time it returns the stack may
      // be somewhere else entirely, and this fact belongs to the moment the
      // call was made.
      const iteration = probe.iterationNow();
      /**
       * One tool call, on the per-node emit channel (core's `RunEmit`).
       *
       * There is exactly one such channel. The demo used to have a private
       * `{type:"call"}` frame here because core had nothing of the kind; core
       * has `RunEmit` now, so this *is* that frame — same payload, folded by
       * `summarizeTrace` onto the node it belongs to.
       */
      const emit = (payload: ToolCallPayload): void => {
        send({
          type: "emit",
          nodeId: frame?.nodeId ?? null,
          at,
          kind: "tool-call",
          payload,
          ...(iteration === undefined ? {} : { iteration }),
        });
      };

      if (plan !== undefined) {
        try {
          const connection = await connect(namespace, plan);
          const toolName = binding.toolName ?? connection.methods.get(method);
          if (toolName === undefined) {
            throw new Error(
              `${plan.server} has no tool matching \`tools.${namespace}.${method}\` (it offers ${String(connection.methods.size)} tools).`,
            );
          }
          const raw = await connection.client.callTool({
            name: toolName,
            arguments: (args ?? {}) as Record<string, unknown>,
          });
          if ((raw as { isError?: boolean }).isError === true) {
            const message = String((unwrap(raw) as { content?: unknown }).content ?? "the server reported an error");
            throw new Error(`${toolName}: ${message}`);
          }
          const value = unwrap(raw);
          const shown = preview(value, job.maxPreviewChars);
          if (frame !== undefined) {
            frame.preview = { tool: binding.name, source: "mcp", value: shown };
            // Kept raw and compared by identity, never shown: when the step's
            // own binding turns out to be this very object, `probe.ts` leaves
            // the envelope above in place so the provenance badge survives.
            frame.toolValue = value;
            frame.hasToolValue = true;
          }
          emit({ tool: binding.name, mode: "mcp", ms: Date.now() - began, ok: true });
          return value;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          emit({ tool: binding.name, mode: "mcp", ms: Date.now() - began, ok: false, detail: message });
          throw cause;
        }
      }

      // No server: answer from the declared output schema, and say so.
      //
      // Remember any workspace path this stub was handed. A stub answers with a
      // shape and changes nothing, so a tool whose *point* is a side effect —
      // `browser.snapshot({ filename })` — leaves no file behind, and the next
      // step, which may be a real server, dies on ENOENT about a path nothing
      // in the flow looks wrong for. That error is true and tells the reader
      // nothing; `explainStubbedPath` below turns it into what happened.
      const promised = workspacePathsIn(args, job.scratch);
      for (const path of promised.absolute) {
        if (!stubbedPaths.has(path)) stubbedPaths.set(path, binding.name);
      }
      const value = binding.outputSchema === undefined ? undefined : sampleFromSchema(binding.outputSchema, method);
      const shown = preview(value, job.maxPreviewChars);
      if (frame !== undefined) {
        frame.preview = { tool: binding.name, source: "sample", value: shown };
        frame.toolValue = value;
        frame.hasToolValue = true;
      }
      // Said at the moment it happens, not when something later trips over it.
      // A flow that catches its own errors — the QA runner does — never reaches
      // the worker's top-level handler, so an explanation attached only to a
      // crash would never be read. This one is attached to the call that made
      // the promise nobody will keep.
      emit({
        tool: binding.name,
        mode: "stub",
        ms: Date.now() - began,
        ok: true,
        ...(promised.shown.length === 0
          ? {}
          : {
              detail: `answered from its schema, so it wrote nothing: ${promised.shown.join(", ")} ${promised.shown.length === 1 ? "does" : "do"} not exist. A stub can return a shape; it cannot have the side effect the flow is relying on.`,
            }),
      });
      return value;
    };
  }

  /*
   * A call to something the registry never declared.
   *
   * The gallery has two flows built entirely around this case — they call
   * `tools.github.getAuditLog` and `tools.fs.gitBlameEveryLine` on purpose, to
   * show what the analyzer says when it does not know a tool (04 §3). Left
   * alone, the runtime answers `undefined is not a function`, which reads as a
   * bug in the runner rather than as the point being made. So the miss is
   * caught and named.
   */
  const missing = (namespace: string, method: string): never => {
    throw new Error(
      `tools.${namespace}.${method} is not in the registry this flow was analyzed against, so the demo runner has nothing to bind it to. The diagram shows it as an unknown step for the same reason.`,
    );
  };

  const known = new Set(Object.keys(out));
  for (const namespace of known) {
    const methods = out[namespace];
    out[namespace] = new Proxy(methods, {
      get: (target, property: string | symbol) => {
        if (typeof property !== "string" || property in target) {
          return Reflect.get(target, property) as unknown;
        }
        return () => missing(namespace, property);
      },
    });
  }

  return new Proxy(out, {
    get: (target, property: string | symbol) => {
      if (typeof property !== "string" || property in target) {
        return Reflect.get(target, property) as unknown;
      }
      return new Proxy(
        {},
        { get: (_inner, method: string | symbol) => () => missing(property, String(method)) },
      );
    },
  });
}

/* -------------------------------------------------------------------------- */
/* run                                                                         */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const tools = buildTools();
  const known = new Set(job.tools.map((binding) => binding.name.slice(0, binding.name.indexOf("."))));
  for (const namespace of known) {
    namespaceStatus.push(
      job.servers[namespace] === undefined
        ? { namespace, mode: "stub" }
        : { namespace, mode: "mcp", server: job.servers[namespace].server },
    );
  }
  send({ type: "ready", namespaces: namespaceStatus });

  const module = (await import(job.entry)) as { default?: (input: unknown, tools: unknown) => unknown };
  if (typeof module.default !== "function") {
    throw new Error("This flow has no default export to call — a flow is `export default async function flow(input, tools)`.");
  }

  const result = (await module.default(job.input, tools)) as unknown;
  // Anything still open when the flow returned finished with it.
  probe.unwindAll("finished");
  send({ type: "done", status: "ok", ms: now(), result: preview(result, job.maxPreviewChars) });
}


/** Workspace paths a stub was handed, and the tool that was handed them. */
const stubbedPaths = new Map<string, string>();

main()
  .catch((cause: unknown) => {
    const raw = cause instanceof Error ? cause.message : String(cause);
    const error = {
      message: explainStubbedPath(raw, stubbedPaths) ?? raw,
      ...(cause instanceof Error && cause.stack !== undefined ? { stack: cause.stack } : {}),
    };
    // The innermost open step is the one that threw; everything above it in the
    // stack failed with it.
    probe.failTop(error);
    probe.unwindAll("failed", { message: "An error thrown inside this step ended the run." });
    send({ type: "done", status: "failed", ms: now(), error });
  })
  .finally(() => {
    void Promise.all(
      [...connections.values()].map(async (connection) => {
        await connection.client.close().catch(() => undefined);
        await connection.transport.close().catch(() => undefined);
      }),
    ).then(() => { process.exit(0); }, () => { process.exit(0); });
  });
