/**
 * Running a flow, from the browser.
 *
 * The browser has the graph; the dev server has a runtime. This module is the
 * seam: it reads `nodeRanges(graph)` — core's projection of "which node owns
 * which piece of source" (09 §1) — posts it with the source and the registry's
 * tool shapes, and turns the SSE frames that come back into `RunEvent`s the
 * canvas can render.
 *
 * Two things here exist purely so that watching a run *feels* like watching one:
 *
 *  - **frames are applied on the next animation frame, in a batch.** A 345-line
 *    flow emits hundreds of events in a few seconds; calling `setState` per
 *    event would spend the whole run in React and drop the frame rate to the
 *    point where nothing looks live. Coalescing per rAF keeps the paint at
 *    60fps and still shows every event in order.
 *  - **`activeNodeId` is the innermost open step**, tracked as a stack rather
 *    than "the last thing that started". A tool call inside a loop inside a try
 *    means three steps are open; only the deepest one is executing.
 */

import { summarizeRun, type NodeRunState, type RunEvent, type WorkflowGraph } from "@codeflow/core";
import { nodeRanges } from "@codeflow/core";
import type { ExampleRegistry } from "./examples-source.js";
import type { RunServerSpec } from "./mcp/model.js";

export interface RunBinding {
  namespace: string;
  mode: "mcp" | "stub";
  server?: string;
  safety?: string;
  reason?: string;
  /** Tool count, once the server has answered `tools/list`. */
  tools?: number;
}

export interface SkippedProbe {
  nodeId: string;
  reason: string;
  detail: string;
}

export interface RunCall {
  at: number;
  tool: string;
  mode: "mcp" | "stub";
  ms: number;
  ok: boolean;
  nodeId: string | null;
  detail?: string;
}

export interface RunPlan {
  runId: string;
  workspace: string;
  probed: string[];
  skipped: SkippedProbe[];
  droppedImports: string[];
  bindings: RunBinding[];
  timeoutMs: number;
  libraryFunctions: string[];
  note: string;
}

export type RunStatus = "idle" | "starting" | "running" | "ok" | "failed" | "timeout" | "cancelled";

/** Statuses a run cannot move out of. */
const SETTLED: readonly string[] = ["ok", "failed", "timeout", "cancelled"];

export interface RunSnapshot {
  status: RunStatus;
  plan: RunPlan | null;
  input: unknown;
  events: RunEvent[];
  calls: RunCall[];
  nodes: Map<string, NodeRunState>;
  activeNodeId: string | null;
  untraced: Set<string>;
  /**
   * Nodes the runtime was asked to report on at all.
   *
   * A synthetic node — the trigger, a merge, an implicit end — owns no code and
   * is never in the probe plan, so "no events" says nothing about it. Dimming
   * it as unreached would be an invented fact; the canvas leaves it alone.
   */
  tracked: Set<string> | null;
  result?: unknown;
  error?: { message: string; stack?: string };
  /** Milliseconds since the run started — ticks while it runs. */
  elapsedMs: number;
}

export const EMPTY_RUN: RunSnapshot = {
  status: "idle",
  plan: null,
  input: undefined,
  events: [],
  calls: [],
  nodes: new Map(),
  activeNodeId: null,
  untraced: new Set(),
  tracked: null,
  elapsedMs: 0,
};

export interface RunStatusInfo {
  available: boolean;
  defaultTimeoutMs?: number;
  realServers?: { namespace: string; server: string; safety: string }[];
  note?: string;
}

export async function fetchRunStatus(): Promise<RunStatusInfo> {
  try {
    const response = await fetch("/api/run/status");
    if (!response.ok) return { available: false };
    return (await response.json()) as RunStatusInfo;
  } catch {
    // Built for production, where there is no dev middleware and so no runner.
    return { available: false };
  }
}

/* -------------------------------------------------------------------------- */
/* the request                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Everything the runtime needs, and nothing it does not.
 *
 * The tool list carries only names and output schemas: a stub answers from the
 * schema, and a real MCP server was going to answer for itself anyway. No
 * registry object crosses the wire, which keeps the runtime honest about being
 * a runtime — it binds an interface (05 §2), it does not know CodeFlow.
 */
export interface RunRequestOptions {
  input?: unknown;
  /**
   * Servers the user configured in the MCP manager.
   *
   * They carry their own `methods` map (`<method>` → the MCP tool name), which
   * is how a tool the runner has never heard of becomes callable: the built-in
   * allowlist reverses its own slugging from rules baked into
   * `server/mcp-servers.ts`, and a server added five seconds ago has no such
   * rules — only the discovery that named it.
   */
  servers?: RunServerSpec[];
}

export function runRequestFor(
  graph: WorkflowGraph,
  source: string,
  registry: ExampleRegistry,
  options: RunRequestOptions = {},
): {
  source: string;
  ranges: { nodeId: string; start: number; end: number; type: string; label: string }[];
  tools: { name: string; outputSchema?: unknown; toolName?: string }[];
  functions: { name: string; code?: string }[];
  servers?: RunServerSpec[];
  input?: unknown;
} {
  const byNamespace = new Map((options.servers ?? []).map((spec) => [spec.namespace, spec]));

  return {
    source,
    ranges: nodeRanges(graph),
    tools: registry.tools.map((tool) => {
      const dot = tool.name.indexOf(".");
      const toolName =
        dot === -1 ? undefined : byNamespace.get(tool.name.slice(0, dot))?.methods[tool.name.slice(dot + 1)];
      return {
        name: tool.name,
        outputSchema: tool.outputSchema,
        ...(toolName === undefined ? {} : { toolName }),
      };
    }),
    functions: registry.functions.map((fn) => ({ name: fn.name, code: fn.code })),
    ...(options.servers === undefined || options.servers.length === 0 ? {} : { servers: options.servers }),
    ...(options.input === undefined ? {} : { input: options.input }),
  };
}

/* -------------------------------------------------------------------------- */
/* the stream                                                                  */
/* -------------------------------------------------------------------------- */

type Frame =
  | ({ type: "plan" } & RunPlan)
  | { type: "input"; input: unknown }
  | { type: "event"; nodeId: string; phase: RunEvent["phase"]; at: number; durationMs?: number; preview?: unknown; error?: { message: string; stack?: string } }
  | ({ type: "call" } & RunCall)
  | { type: "ready"; namespaces: { namespace: string; mode: string; server?: string; tools?: number }[] }
  | { type: "done"; status: "ok" | "failed" | "timeout" | "cancelled"; ms?: number; result?: unknown; error?: { message: string; stack?: string } }
  | { type: "fatal"; message: string };

export interface RunHandle {
  /** Abort the fetch; the server kills the worker and clears the scratch dir. */
  stop: () => void;
}

/**
 * POST the run and stream it back.
 *
 * `onSnapshot` is called at most once per animation frame with the whole
 * snapshot — cheaper than one call per event, and it means React sees a single
 * consistent state rather than a partially-applied one.
 */
export function startRun(
  body: unknown,
  onSnapshot: (snapshot: RunSnapshot) => void,
): RunHandle {
  const controller = new AbortController();
  const startedAt = performance.now();

  let plan: RunPlan | null = null;
  let input: unknown;
  const events: RunEvent[] = [];
  const calls: RunCall[] = [];
  /** Open steps, innermost last — the runtime's own probe stack, mirrored. */
  const openStack: string[] = [];
  let status: RunStatus = "starting";
  let result: unknown;
  let error: { message: string; stack?: string } | undefined;

  let scheduled = 0;
  let ticker: number | null = null;

  const snapshot = (): RunSnapshot => ({
    status,
    plan,
    input,
    // Copies, not the live arrays: React memoization keys on identity, and a
    // list that is mutated in place looks unchanged to every `useMemo` reading
    // it — the run log stayed empty for exactly that reason.
    events: events.slice(),
    calls: calls.slice(),
    nodes: summarizeRun(events),
    activeNodeId: openStack.length === 0 ? null : openStack[openStack.length - 1],
    untraced: new Set((plan?.skipped ?? []).map((entry) => entry.nodeId)),
    tracked:
      plan === null ? null : new Set([...plan.probed, ...plan.skipped.map((entry) => entry.nodeId)]),
    result,
    error,
    elapsedMs: Math.round(performance.now() - startedAt),
  });

  const flush = (): void => {
    scheduled = 0;
    onSnapshot(snapshot());
  };
  const schedule = (): void => {
    if (scheduled !== 0) return;
    scheduled = requestAnimationFrame(flush);
  };
  const finish = (): void => {
    if (scheduled !== 0) { cancelAnimationFrame(scheduled); scheduled = 0; }
    if (ticker !== null) { clearInterval(ticker); ticker = null; }
    // Whatever was open when the stream ended is not running any more. Leaving
    // it lit would have a stopped run keep pulsing at the step it died on.
    openStack.length = 0;
    onSnapshot(snapshot());
  };

  // While the run is alive, keep the elapsed clock moving even if the flow is
  // sitting inside one slow tool call and emitting nothing.
  ticker = window.setInterval(() => { schedule(); }, 250);

  const apply = (frame: Frame): void => {
    switch (frame.type) {
      case "plan": {
        const { type: _type, ...rest } = frame;
        plan = rest;
        status = "running";
        break;
      }
      case "input":
        input = frame.input;
        break;
      case "event": {
        const { type: _type, ...event } = frame;
        events.push(event);
        if (event.phase === "started") openStack.push(event.nodeId);
        else {
          for (let i = openStack.length - 1; i >= 0; i--) {
            if (openStack[i] === event.nodeId) { openStack.splice(i); break; }
          }
        }
        break;
      }
      case "call": {
        const { type: _type, ...call } = frame;
        calls.push(call);
        break;
      }
      case "ready": {
        if (plan === null) break;
        for (const namespace of frame.namespaces) {
          const binding = plan.bindings.find((entry) => entry.namespace === namespace.namespace);
          if (binding !== undefined && namespace.tools !== undefined) binding.tools = namespace.tools;
        }
        break;
      }
      case "done":
        status = frame.status;
        result = frame.result;
        error = frame.error;
        openStack.length = 0;
        break;
      case "fatal":
        status = "failed";
        error = { message: frame.message };
        break;
    }
  };

  void (async () => {
    try {
      const response = await fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.body === null) throw new Error("The run endpoint returned no stream.");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        buffer += decoder.decode(step.value, { stream: true });
        let cut = buffer.indexOf("\n\n");
        while (cut !== -1) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf("\n\n");
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload.length === 0) continue;
            try {
              apply(JSON.parse(payload) as Frame);
            } catch {
              // A malformed frame is the server's bug, not a reason to stop
              // showing the run that is already on screen.
            }
          }
          schedule();
        }
      }
      // The stream ended without a `done` frame — the server went away. (The
      // membership test rather than `!==` chains because `status` is only ever
      // reassigned inside `apply`, which the checker cannot see through.)
      if (!SETTLED.includes(status)) status = "cancelled";
    } catch (cause) {
      if (controller.signal.aborted) status = "cancelled";
      else {
        status = "failed";
        error = { message: cause instanceof Error ? cause.message : String(cause) };
      }
    } finally {
      finish();
    }
  })();

  return { stop: () => { controller.abort(); } };
}
