/**
 * The demo runner's execution thread.
 *
 * This is the half of the feature `@codeflow/core` is forbidden to contain
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

import { slugifyMethod } from "@codeflow/mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { preview, sampleFromSchema } from "./sample.ts";
import type { McpServerPlan } from "./mcp-servers.ts";

export interface ToolBinding {
  /** `<namespace>.<method>` */
  name: string;
  outputSchema?: unknown;
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

type Outbound =
  | { type: "event"; nodeId: string; phase: string; at: number; durationMs?: number; preview?: unknown; error?: { message: string; stack?: string } }
  | { type: "call"; at: number; tool: string; mode: "mcp" | "stub"; ms: number; ok: boolean; nodeId: string | null; detail?: string }
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

interface Frame {
  nodeId: string;
  at: number;
  /** Result of the last tool call made while this frame was innermost. */
  preview?: unknown;
}

const stack: Frame[] = [];

/**
 * Close `frame`, and say why.
 *
 * `unwind` covers the frames that were still open when an enclosing step ended.
 * How that reads depends on *how* it ended, and the difference is not cosmetic:
 * an exception caught by a `try` means the steps inside it failed, while a
 * `break` out of a loop means they simply stopped. The instrumenter marks the
 * entry to every `catch` (`__cf.x`) precisely so the two can be told apart.
 */
function close(frame: Frame, phase: "finished" | "failed", error?: { message: string; stack?: string }): void {
  send({
    type: "event",
    nodeId: frame.nodeId,
    phase,
    at: now(),
    durationMs: now() - frame.at,
    ...(frame.preview === undefined ? {} : { preview: frame.preview }),
    ...(error === undefined ? {} : { error }),
  });
}

function unwindAbove(index: number, phase: "finished" | "failed", error?: { message: string; stack?: string }): void {
  while (stack.length > index + 1) {
    const orphan = stack.pop();
    if (orphan !== undefined) close(orphan, phase, error);
  }
}

/** Innermost open frame for `nodeId`, or -1. (`findLastIndex` is ES2023.) */
function openIndexOf(nodeId: string): number {
  for (let i = stack.length - 1; i >= 0; i--) if (stack[i].nodeId === nodeId) return i;
  return -1;
}

const probe = {
  s(nodeId: string): void {
    stack.push({ nodeId, at: now() });
    send({ type: "event", nodeId, phase: "started", at: now() });
  },
  f(nodeId: string): void {
    const index = openIndexOf(nodeId);
    if (index === -1) return;
    // Anything still open above this step left early (a `break`, a `continue`,
    // a `return`). It ran; it just did not reach its own closing marker.
    unwindAbove(index, "finished");
    const frame = stack.pop();
    if (frame !== undefined) close(frame, "finished");
  },
  x(nodeId: string): void {
    const index = openIndexOf(nodeId);
    if (index === -1) return;
    unwindAbove(index, "failed", { message: "An error was thrown before this step finished." });
  },
  /**
   * A step that is an *expression*, not a statement — an element of
   * `Promise.all([…])`.
   *
   * Several of these are in flight at once, so they cannot use the stack: each
   * gets its own frame, closed when its own promise settles. The promise is
   * *listened to*, never chained, so what the caller gets back is the identical
   * promise with identical timing.
   */
  p<T>(nodeId: string, thunk: () => T): T {
    const frame: Frame = { nodeId, at: now() };
    send({ type: "event", nodeId, phase: "started", at: now() });
    let value: T;
    try {
      value = thunk();
    } catch (cause) {
      close(frame, "failed", { message: cause instanceof Error ? cause.message : String(cause) });
      throw cause;
    }
    const thenable = value as unknown as { then?: unknown };
    if (typeof thenable?.then === "function") {
      (value as unknown as Promise<unknown>).then(
        (settled: unknown) => {
          frame.preview = preview(settled, job.maxPreviewChars);
          close(frame, "finished");
        },
        (cause: unknown) => {
          close(frame, "failed", { message: cause instanceof Error ? cause.message : String(cause) });
        },
      );
    } else {
      close(frame, "finished");
    }
    return value;
  },
};

(globalThis as unknown as Record<string, unknown>)["__cf"] = probe;

/* -------------------------------------------------------------------------- */
/* tools                                                                       */
/* -------------------------------------------------------------------------- */

interface Connection {
  client: Client;
  transport: StdioClientTransport;
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

async function connect(namespace: string, plan: McpServerPlan): Promise<Connection> {
  const existing = connections.get(namespace);
  if (existing !== undefined) return existing;

  const args = plan.args.map((arg) => arg.replaceAll("{{scratch}}", job.scratch));
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const [key, value] of Object.entries(plan.env ?? {})) {
    env[key] = value.replaceAll("{{scratch}}", job.scratch);
  }

  const transport = new StdioClientTransport({ command: plan.command, args, env, stderr: "ignore" });
  const client = new Client({ name: "codeflow-demo-runner", version: "0.0.0" }, {});
  await client.connect(transport);

  const methods = new Map<string, string>();
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const listed = await client.listTools(cursor === undefined ? undefined : { cursor });
    for (const tool of listed.tools ?? []) methods.set(methodNameFor(plan, tool.name), tool.name);
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
      const frame = stack[stack.length - 1];
      const at = now();
      const began = Date.now();

      if (plan !== undefined) {
        try {
          const connection = await connect(namespace, plan);
          const toolName = connection.methods.get(method);
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
          if (frame !== undefined) frame.preview = { tool: binding.name, source: "mcp", value: shown };
          send({ type: "call", at, tool: binding.name, mode: "mcp", ms: Date.now() - began, ok: true, nodeId: frame?.nodeId ?? null });
          return value;
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          send({ type: "call", at, tool: binding.name, mode: "mcp", ms: Date.now() - began, ok: false, nodeId: frame?.nodeId ?? null, detail: message });
          throw cause;
        }
      }

      // No server: answer from the declared output schema, and say so.
      const value = binding.outputSchema === undefined ? undefined : sampleFromSchema(binding.outputSchema, method);
      const shown = preview(value, job.maxPreviewChars);
      if (frame !== undefined) frame.preview = { tool: binding.name, source: "sample", value: shown };
      send({ type: "call", at, tool: binding.name, mode: "stub", ms: Date.now() - began, ok: true, nodeId: frame?.nodeId ?? null });
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
  unwindAbove(-1, "finished");
  send({ type: "done", status: "ok", ms: now(), result: preview(result, job.maxPreviewChars) });
}

main()
  .catch((cause: unknown) => {
    const error = {
      message: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof Error && cause.stack !== undefined ? { stack: cause.stack } : {}),
    };
    // The innermost open step is the one that threw; everything above it in the
    // stack failed with it.
    const innermost = stack.pop();
    if (innermost !== undefined) close(innermost, "failed", error);
    unwindAbove(-1, "failed", { message: "An error thrown inside this step ended the run." });
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
