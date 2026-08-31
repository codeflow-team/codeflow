/**
 * Run a flow twice — once as written, once instrumented — in this process.
 *
 * Shared by `instrument.test.ts` (which asks "did the program change?") and
 * `iteration.test.ts` (which asks "what did the markers report?"), because they
 * are two questions about one mechanism and answering them against two
 * different fakes would let the mechanism drift between them.
 *
 * The probe is **not** a fake: it is `server/probe.ts`, the same object the
 * worker installs as `globalThis.__cf`. Only the transport is swapped — events
 * land in an array instead of a `postMessage`. A test that mocked the probe
 * would be testing its own idea of the marker protocol, which is exactly the
 * thing that has to be checked.
 */

import ts from "typescript";
import {
  analyzeSource,
  createRegistry,
  nodeRanges,
  type RunEvent,
  type WorkflowGraph,
  type WorkflowNode,
} from "@codeflow-team/core";

import { instrument, type InstrumentResult, type ProbeRange } from "../server/instrument.ts";
import { createProbe } from "../server/probe.ts";

export interface Effect {
  call: string;
  args: unknown;
}

export interface Outcome {
  effects: Effect[];
  result: unknown;
  error: string | null;
  /** Marker pairs recorded, only meaningful for the instrumented copy. */
  probes: string[];
  /** Every `RunEvent` the probe produced, in order. */
  events: RunEvent[];
}

const registry = createRegistry({ tools: [], functions: [] });

export function graphFor(source: string): WorkflowGraph {
  return analyzeSource(source, registry, { file: "flow.ts" });
}

export function rangesFor(source: string): ProbeRange[] {
  return nodeRanges(graphFor(source));
}

/**
 * The nth node of a type, in source order — how a test names a node without
 * hard-coding an id the analyzer is free to change.
 */
export function nodeIdOf(graph: WorkflowGraph, type: string, index = 0): string {
  const matches = graph.nodes
    .filter((node: WorkflowNode) => node.type === type)
    .sort((a, b) => a.source.start.offset - b.source.start.offset);
  const found = matches[index];
  if (found === undefined) {
    throw new Error(`no ${type} node #${String(index)} — the analyzer found ${String(matches.length)}`);
  }
  return found.id;
}

export function instrumentFor(source: string): InstrumentResult {
  return instrument(source, rangesFor(source));
}

/** Transpile to CommonJS and call the default export — no bundler needed. */
export async function execute(source: string, input: unknown): Promise<Outcome> {
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;

  const effects: Effect[] = [];
  const events: RunEvent[] = [];
  const tools = new Proxy(
    {},
    {
      get: (_target, namespace: string) =>
        new Proxy(
          {},
          {
            get: (_inner, method: string) => async (args: unknown) => {
              effects.push({ call: `${namespace}.${method}`, args });
              await Promise.resolve();
              // One method name throws, so a rejection path can be tested with
              // the same harness as the happy one.
              if (method === "explode") throw new Error(`${namespace}.${method} failed`);
              return { ok: true, of: `${namespace}.${method}` };
            },
          },
        ),
    },
  );

  const startedAt = Date.now();
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals["__cf"];
  globals["__cf"] = createProbe(
    (event) => { events.push(event); },
    { now: () => Date.now() - startedAt, preview: (value) => value },
  );

  const moduleExports: Record<string, unknown> = {};
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval -- test harness, not core (I7 scopes to packages/core).
    const factory = new Function("exports", "module", "require", js) as (
      exports: Record<string, unknown>,
      module: { exports: Record<string, unknown> },
      require: (id: string) => unknown,
    ) => void;
    factory(moduleExports, { exports: moduleExports }, () => ({}));
    const flow = moduleExports["default"] as (input: unknown, tools: unknown) => Promise<unknown>;
    const result = (await flow(input, tools)) as unknown;
    return { effects, result, error: null, probes: probesOf(events), events };
  } catch (cause) {
    return {
      effects,
      result: undefined,
      error: cause instanceof Error ? cause.message : String(cause),
      probes: probesOf(events),
      events,
    };
  } finally {
    globals["__cf"] = previous;
  }
}

function probesOf(events: readonly RunEvent[]): string[] {
  return events.map((event) => `${event.phase === "started" ? "s" : "f"}:${event.nodeId}`);
}

/**
 * Every event for `nodeId`, as `phase` plus its iteration — `null` where the
 * runtime sent none, so a missing number is visible in the assertion rather
 * than merged with `[]`.
 */
export function iterationsOf(
  events: readonly RunEvent[],
  nodeId: string,
): { phase: string; iteration: number[] | null }[] {
  return events
    .filter((event) => event.nodeId === nodeId)
    .map((event) => ({ phase: event.phase, iteration: event.iteration ?? null }));
}
