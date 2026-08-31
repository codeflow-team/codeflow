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

import {
  summarizeTrace,
  traceMatches,
  type NodeRunState,
  type RunEmit,
  type RunEvent,
  type TraceMatch,
  type WorkflowGraph,
} from "@codeflow-team/core";
import { nodeRanges } from "@codeflow-team/core";
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

/**
 * One thing a node said mid-step, as the runner sends it.
 *
 * Core's `RunEmit` with `nodeId` widened to allow `null`: a tool called from a
 * statement no probe could bracket has no node to belong to, and an emit exists
 * to be folded *into* a node. Rather than drop the fact or invent an owner, it
 * arrives unattributed; only the attributed ones are folded.
 */
export type RunEmitFrame = Omit<RunEmit, "nodeId"> & { nodeId: string | null };

/**
 * One tool call, as the Run panel has always shown it.
 *
 * **Derived**, not received. This used to be its own `{type:"call"}` frame — a
 * per-node side channel the demo invented because core had no such thing. Core
 * has `RunEmit` now, so there is one channel and this is a view of it.
 */
export interface RunCall {
  at: number;
  tool: string;
  mode: "mcp" | "stub";
  ms: number;
  ok: boolean;
  nodeId: string | null;
  detail?: string;
}

/** The payload the runner puts on a `kind: "tool-call"` emit. */
export interface ToolCallPayload {
  tool: string;
  mode: "mcp" | "stub";
  ms: number;
  ok: boolean;
  detail?: string;
}

/** The `calls` view of one emit, or `null` if it is not a tool call. */
export function callFromEmit(emit: RunEmitFrame): RunCall | null {
  if (emit.kind !== "tool-call") return null;
  const payload = emit.payload as ToolCallPayload;
  return {
    at: emit.at,
    tool: payload.tool,
    mode: payload.mode,
    ms: payload.ms,
    ok: payload.ok,
    nodeId: emit.nodeId,
    ...(payload.detail === undefined ? {} : { detail: payload.detail }),
  };
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
  /** Loops whose passes this run can count. */
  counted: string[];
  /** Steps inside which an iteration number would be a guess, so none is sent. */
  uncounted: string[];
  /** True when nothing in this run carries an iteration at all. */
  blind: boolean;
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
  /** Everything the nodes said mid-step, in arrival order. */
  emits: RunEmitFrame[];
  /** The tool calls among them, in the shape the Run panel reads. Derived. */
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
  /**
   * `WorkflowGraph.id` this run was launched against — core's `traceIdentity`.
   *
   * Without it a run is unattached to any version of the flow, and node ids are
   * stable across patches on purpose (I5) — so an old value re-attaches, silent
   * and confident, to the very node whose code just changed. Carried so
   * `traceMatchFor` can say `stale` instead of the picture quietly lying.
   */
  graphId?: string;
  /** `WorkflowGraph.source.contentHash` at launch. Copied, never re-hashed. */
  sourceHash?: string;
}

export const EMPTY_RUN: RunSnapshot = {
  status: "idle",
  plan: null,
  input: undefined,
  events: [],
  emits: [],
  calls: [],
  nodes: new Map(),
  activeNodeId: null,
  untraced: new Set(),
  tracked: null,
  elapsedMs: 0,
};

/**
 * Do this run's values still describe this graph?
 *
 * A thin wrapper over core's `traceMatches` so there is one answer in the demo
 * rather than one per panel. `unknown` means the run carries no identity to
 * compare — it must be rendered as uncertainty, never as `current`.
 */
export function traceMatchFor(run: RunSnapshot, graph: WorkflowGraph | null | undefined): TraceMatch {
  return traceMatches(run, graph);
}

/**
 * How each answer reads on screen.
 *
 * `unknown` is worded as uncertainty and never as agreement: "not known" is the
 * honest caption, while showing the values plainly would say "this is what your
 * flow does now" — which nothing established (07 §5).
 */
export const TRACE_MATCH_LABEL: Record<TraceMatch, string> = {
  current: "from this version",
  stale: "from an earlier version",
  unknown: "version not recorded",
};

export const TRACE_MATCH_HINT: Record<TraceMatch, string> = {
  current: "This run was launched against the code on screen.",
  stale:
    "The flow changed after this run. These values are from an earlier version of it — the steps are the same steps, but the code behind them is not the code that produced these numbers. Run again to see what it does now.",
  unknown:
    "This run carries no record of which version of the flow it ran against, so whether these values still describe the code on screen is not known.",
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
  | { type: "event"; nodeId: string; phase: RunEvent["phase"]; at: number; durationMs?: number; preview?: unknown; error?: { message: string; stack?: string }; iteration?: number[] }
  | ({ type: "emit" } & RunEmitFrame)
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
  /** `traceIdentity(graph)` — which version of the flow this run is about. */
  identity?: { graphId: string; sourceHash: string },
): RunHandle {
  const controller = new AbortController();
  const startedAt = performance.now();

  let plan: RunPlan | null = null;
  let input: unknown;
  const events: RunEvent[] = [];
  const emits: RunEmitFrame[] = [];
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
    emits: emits.slice(),
    // One channel, two views. `calls` is what the Run panel has always read;
    // the fold below is what a node card reads. Neither is a second source.
    calls: emits.map(callFromEmit).filter((call): call is RunCall => call !== null),
    // Only the attributed emits reach core: `RunEmit` is keyed by `nodeId`, and
    // an emit with none has no node to be folded onto.
    nodes: summarizeTrace({
      events,
      emits: emits.filter((emit): emit is RunEmit => emit.nodeId !== null),
    }),
    activeNodeId: openStack.length === 0 ? null : openStack[openStack.length - 1],
    untraced: new Set((plan?.skipped ?? []).map((entry) => entry.nodeId)),
    tracked:
      plan === null ? null : new Set([...plan.probed, ...plan.skipped.map((entry) => entry.nodeId)]),
    result,
    error,
    elapsedMs: Math.round(performance.now() - startedAt),
    ...(identity ?? {}),
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
      case "emit": {
        const { type: _type, ...emit } = frame;
        emits.push(emit);
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
