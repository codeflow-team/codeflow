/**
 * The per-node channel, end to end — and the thing that says which version of
 * the flow a run was about.
 *
 * Two claims are under test here.
 *
 * **There is one per-node channel, not two.** The demo used to send its own
 * `{type:"call"}` frame beside the lifecycle events, because core had nothing
 * of the kind. Core has `RunEmit` now, so the runner sends emits and the Run
 * panel's `calls` list is *derived* from them. The equivalence test below runs a
 * real flow through the real runner and checks the derived list is what the old
 * frame carried, field for field — a list that quietly lost `detail`, or turned
 * an unattributed `nodeId` into `undefined`, would still render and still be
 * wrong.
 *
 * **A trace is tied to the graph it ran against.** Node ids survive patches by
 * design (I5), so without that tie an old value re-attaches to the very node
 * whose code just changed and nothing says so. `traceMatchFor` is what says so.
 */

import { describe, expect, it } from "vitest";
import { stripsTypesNatively, TYPE_STRIPPING_REASON } from "./node-capability.ts";
import { fileURLToPath } from "node:url";
import { analyzeSource, createRegistry, nodeRanges, summarizeRun, summarizeTrace, traceIdentity, type RunEmit, type RunEvent } from "@codeflow-team/core";

import { startRun, type RunFrame } from "../server/runner.ts";
import { callFromEmit, EMPTY_RUN, traceMatchFor, type RunCall, type RunEmitFrame, type RunSnapshot } from "../src/run.ts";

const WORKER = fileURLToPath(new URL("../server/worker.ts", import.meta.url));

/* -------------------------------------------------------------------------- */
/* one real run                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A loop with a tool call in it, and one call the registry never declared.
 *
 * `echo` is not on the runner's allowlist, so it binds to the schema-shaped
 * stub — no server, no network, and the same code path a real one takes on the
 * way out. `echo.nope` is deliberately absent from the tool list, which is how
 * the failing branch of the emit (`ok: false`, with a `detail`) gets exercised.
 */
const FLOW = `
export default async function flow(input: { rounds: number }, tools: any) {
  const out: any[] = [];
  for (const item of [1, 2]) {
    const said = await tools.echo.say({ item });
    out.push(said);
  }
  try {
    await tools.echo.nope({});
  } catch (err) {
    out.push("recovered");
  }
  return out;
}
`;

const OUTPUT_SCHEMA = { type: "object", properties: { text: { type: "string" } }, required: ["text"] };

/** What the browser posts: names and output shapes, no registry object (05 §2). */
const TOOLS = [{ name: "echo.say", outputSchema: OUTPUT_SCHEMA }];

/** The same tool, as the analyzer needs it. */
const DEFINITIONS = [
  {
    name: "echo.say",
    label: "Say",
    inputSchema: { type: "object", properties: { item: { type: "number" } } },
    outputSchema: OUTPUT_SCHEMA,
  },
];

interface Recorded {
  events: RunEvent[];
  emits: RunEmitFrame[];
  plan: Extract<RunFrame, { type: "plan" }> | null;
  done: Extract<RunFrame, { type: "done" }> | null;
  graph: ReturnType<typeof analyzeSource>;
}

let recorded: Promise<Recorded> | null = null;

/** Run the flow once for the whole file — a worker thread is not free. */
function runOnce(): Promise<Recorded> {
  recorded ??= new Promise<Recorded>((resolve) => {
    const registry = createRegistry({ tools: DEFINITIONS, functions: [] });
    const graph = analyzeSource(FLOW, registry, { file: "fold.flow.ts" });
    const events: RunEvent[] = [];
    const emits: RunEmitFrame[] = [];
    let plan: Extract<RunFrame, { type: "plan" }> | null = null;

    const handle = startRun(
      { source: FLOW, ranges: nodeRanges(graph), tools: TOOLS, functions: [], input: { rounds: 2 }, timeoutMs: 30_000 },
      WORKER,
      (frame) => {
        if (frame.type === "plan") plan = frame;
        else if (frame.type === "event") {
          const { type: _type, ...event } = frame;
          events.push(event as RunEvent);
        } else if (frame.type === "emit") {
          const { type: _type, ...emit } = frame;
          emits.push(emit);
        } else if (frame.type === "done") {
          void handle.finished.then(() => { resolve({ events, emits, plan, done: frame, graph }); });
        }
      },
    );
    void handle.finished.then(() => { resolve({ events, emits, plan, done: null, graph }); });
  });
  return recorded;
}

/* -------------------------------------------------------------------------- */
/* one channel                                                                 */
/* -------------------------------------------------------------------------- */

// Drives the real runner in a real worker thread — see node-capability.ts.
describe.skipIf(!stripsTypesNatively())("the per-node emit channel", () => {
  it("carries every tool call, as `RunEmit` and nothing else", async () => {
    const { emits } = await runOnce();
    // Two — one per loop pass. `tools.echo.nope` produces none, and did not
    // produce a `call` frame before either: a method the registry never
    // declared throws on the way in, so no call was ever made to report.
    expect(emits.length).toBe(2);
    for (const emit of emits) {
      expect(emit.kind).toBe("tool-call");
      expect(typeof emit.at).toBe("number");
      // Attributed to the step that made the call — the fold needs an owner.
      expect(typeof emit.nodeId).toBe("string");
    }
    const payloads = emits.map((emit) => emit.payload as { tool: string; mode: string; ok: boolean });
    expect(payloads.map((payload) => payload.tool)).toEqual(["echo.say", "echo.say"]);
    expect(payloads.map((payload) => payload.mode)).toEqual(["stub", "stub"]);
    expect(payloads.map((payload) => payload.ok)).toEqual([true, true]);
  });

  it("derives the calls list the Run panel has always read", async () => {
    const { emits } = await runOnce();

    /*
     * What the removed `{type:"call"}` frame was, verbatim from the worker
     * before the migration:
     *
     *   send({ type: "call", at, tool: binding.name, mode, ms: Date.now() -
     *          began, ok, nodeId: frame?.nodeId ?? null, detail? })
     *
     * Same run, same facts, rebuilt through the old rule — the derived list has
     * to be indistinguishable from it.
     */
    const asOldFrames: RunCall[] = emits.map((emit) => {
      const payload = emit.payload as { tool: string; mode: "mcp" | "stub"; ms: number; ok: boolean; detail?: string };
      return {
        at: emit.at,
        tool: payload.tool,
        mode: payload.mode,
        ms: payload.ms,
        ok: payload.ok,
        nodeId: emit.nodeId,
        ...(payload.detail === undefined ? {} : { detail: payload.detail }),
      };
    });

    const derived = emits
      .map(callFromEmit)
      .filter((call): call is RunCall => call !== null);

    expect(derived).toEqual(asOldFrames);
    // …and it is the same list a viewer saw before: one row per call, each
    // attributed, each with the tool it named and no `detail` on a success.
    expect(derived.map((call) => call.tool)).toEqual(["echo.say", "echo.say"]);
    expect(derived.map((call) => call.ok)).toEqual([true, true]);
    expect(derived.every((call) => call.detail === undefined)).toBe(true);
    expect(derived.every((call) => call.nodeId !== null)).toBe(true);
    expect(derived.every((call) => typeof call.ms === "number")).toBe(true);
  });

  /*
   * The paths a stub-only run cannot reach.
   *
   * A failing call needs a real MCP server to fail, and an unattributed one
   * needs a statement no probe could bracket. Both are shapes the runner sends,
   * so both are pinned here against the same old-frame rule rather than left
   * to the first time one happens in front of a user.
   */
  it("keeps a failed call's reason, and an unowned call's missing owner", () => {
    const failed: RunEmitFrame = {
      nodeId: "n7",
      at: 1204,
      kind: "tool-call",
      payload: { tool: "fs.readTextFile", mode: "mcp", ms: 42, ok: false, detail: "read_text_file: ENOENT" },
      iteration: [3],
    };
    expect(callFromEmit(failed)).toEqual({
      at: 1204,
      tool: "fs.readTextFile",
      mode: "mcp",
      ms: 42,
      ok: false,
      nodeId: "n7",
      detail: "read_text_file: ENOENT",
    });

    const unowned: RunEmitFrame = {
      nodeId: null,
      at: 9,
      kind: "tool-call",
      payload: { tool: "fs.write", mode: "stub", ms: 1, ok: true },
    };
    // `null`, not `undefined` and not dropped: the old frame said "this call
    // belongs to no step I could name", and that is still what it says.
    expect(callFromEmit(unowned)?.nodeId).toBeNull();
    expect(callFromEmit(unowned)?.detail).toBeUndefined();

    // A kind the panel does not know about is not a call and never joins the
    // list — the channel is shared, the view is not.
    expect(callFromEmit({ nodeId: "n7", at: 3, kind: "artifact", payload: { url: "x" } })).toBeNull();
  });

  it("folds emits onto their node without touching its lifecycle", async () => {
    const { events, emits } = await runOnce();
    const attributed = emits.filter((emit): emit is RunEmit => emit.nodeId !== null);

    const lifecycleOnly = summarizeRun(events);
    const withEmits = summarizeTrace({ events, emits: attributed });

    for (const [nodeId, before] of lifecycleOnly) {
      const after = withEmits.get(nodeId);
      // An image arriving is not a step finishing. `status`, `runs` and the
      // durations are the fold of the *events*, and stay exactly that.
      expect(after?.status).toBe(before.status);
      expect(after?.runs).toBe(before.runs);
      expect(after?.totalMs).toBe(before.totalMs);
      expect(after?.iterations?.map((entry) => entry.iteration)).toEqual(
        before.iterations?.map((entry) => entry.iteration),
      );
    }

    const owners = new Set(attributed.map((emit) => emit.nodeId));
    expect(owners.size).toBeGreaterThan(0);
    for (const owner of owners) {
      const state = withEmits.get(owner);
      expect(state?.emits?.length).toBe(attributed.filter((emit) => emit.nodeId === owner).length);
      expect(state?.emits?.every((emit) => emit.kind === "tool-call")).toBe(true);
    }
  });

  it("numbers a real run's loop passes, on the events and on the emits alike", async () => {
    const { events, emits, plan, graph } = await runOnce();
    expect(plan?.blind).toBe(false);
    expect(plan?.counted.length).toBe(1);

    const loop = graph.nodes.find((node) => node.type === "loop");
    const body = events.filter(
      (event) => event.nodeId !== loop?.id && event.iteration !== undefined,
    );
    expect(body.length).toBeGreaterThan(0);
    expect([...new Set(body.map((event) => JSON.stringify(event.iteration)))]).toEqual(["[0]", "[1]"]);

    // The calls inside the loop know which pass they came from — one per pass,
    // numbered, out of a real worker thread rather than a harness.
    expect(emits.map((emit) => emit.iteration ?? null)).toEqual([[0], [1]]);
  });
});

/* -------------------------------------------------------------------------- */
/* which version these values are about                                        */
/* -------------------------------------------------------------------------- */

const SOURCE_A = `
export default async function flow(input: {}, tools: any) {
  const first = await tools.a.run({});
  return first;
}
`;

const SOURCE_B = `
export default async function flow(input: {}, tools: any) {
  const first = await tools.a.run({ mode: "fast" });
  return first;
}
`;

describe("a run knows which version of the flow it is about", () => {
  const registry = createRegistry({ tools: [], functions: [] });
  const graphA = analyzeSource(SOURCE_A, registry, { file: "flow.ts" });
  const graphB = analyzeSource(SOURCE_B, registry, { file: "flow.ts" });

  const ranAgainstA: RunSnapshot = { ...EMPTY_RUN, status: "ok", ...traceIdentity(graphA) };

  it("reads `current` against the graph it ran on", () => {
    expect(traceMatchFor(ranAgainstA, graphA)).toBe("current");
  });

  it("reads `stale` once the source moves under it", () => {
    // The same node ids are still on screen — that is the point. Nothing about
    // the values changed; what changed is the code behind them.
    expect(graphB.source.contentHash).not.toBe(graphA.source.contentHash);
    expect(traceMatchFor(ranAgainstA, graphB)).toBe("stale");
  });

  it("reads `current` again after a re-run against the edited flow", () => {
    const ranAgainstB: RunSnapshot = { ...EMPTY_RUN, status: "ok", ...traceIdentity(graphB) };
    expect(traceMatchFor(ranAgainstB, graphB)).toBe("current");
    expect(traceMatchFor(ranAgainstB, graphA)).toBe("stale");
  });

  it("reads `unknown` — never `current` — when the run carries no identity", () => {
    const unstamped: RunSnapshot = { ...EMPTY_RUN, status: "ok" };
    expect(traceMatchFor(unstamped, graphA)).toBe("unknown");
    // And with no graph to compare against, the answer is uncertainty too.
    expect(traceMatchFor(ranAgainstA, null)).toBe("unknown");
  });

  it("stamps what the analyzer already computed, rather than hashing again", () => {
    expect(traceIdentity(graphA)).toEqual({ graphId: graphA.id, sourceHash: graphA.source.contentHash });
  });
});

