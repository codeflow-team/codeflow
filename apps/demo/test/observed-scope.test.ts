/**
 * The other half of the complaint: the left pane, after a run.
 *
 * "Available here" lists what a step can drag from, and `scopeRows` expands a
 * binding into its fields. Before a run it can only expand what a *schema*
 * declares; after one, `childrenOf` falls back to the shape of the value that
 * was actually observed — "the keys of a value that exists are facts about it".
 *
 * That fallback was already written and could never fire, because nothing but a
 * tool call ever produced an observed value. Now that a step's binding and a
 * loop's item are recorded, this file checks the whole chain end to end rather
 * than assuming it: real runner → `RunEvent.preview` → `summarizeTrace` →
 * `observedAt(state, itemPath)` → `scopeRows` → a row per field, marked
 * `observed`.
 *
 * It uses `@codeflow-team/react`'s own functions, not a copy of them, because
 * the question is whether *that* code sees the values — a re-implementation
 * here would answer a different question and always say yes.
 */

import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import { analyzeSource, createRegistry, nodeRanges, summarizeTrace, type RunEmit, type RunEvent, type ScopeBinding } from "@codeflow-team/core";
import { observedAt, scopeRows } from "@codeflow-team/react";

import { startRun, type RunFrame } from "../server/runner.ts";
import { stripsTypesNatively, TYPE_STRIPPING_REASON } from "./node-capability.ts";

const WORKER = fileURLToPath(new URL("../server/worker.ts", import.meta.url));

/**
 * A loop over records with no declared schema anywhere.
 *
 * Deliberately schema-free: with a schema `childrenOf` walks that instead, and
 * the fallback under test would never run. `pick` is a local function, so the
 * step that calls it is a `function` node with a binding and no registry entry
 * to describe its output — exactly the shape the tester found empty.
 */
const FLOW = `
function pick(ticket: any) {
  return { id: ticket.id, plan: ticket.plan };
}

export default async function flow(input: {}, tools: any) {
  const queue = [
    { id: "T-1", customer: "Acme", plan: "enterprise" },
    { id: "T-2", customer: "Beta", plan: "free" }
  ];
  const seen: any[] = [];
  for (const ticket of queue) {
    const summary = pick(ticket);
    seen.push(summary);
  }
  return seen;
}
`;

interface Recorded {
  events: RunEvent[];
  emits: RunEmit[];
  graph: ReturnType<typeof analyzeSource>;
}

let recorded: Promise<Recorded> | null = null;

function runOnce(): Promise<Recorded> {
  recorded ??= new Promise<Recorded>((resolve) => {
    const graph = analyzeSource(FLOW, createRegistry({ tools: [], functions: [] }), { file: "scope.flow.ts" });
    const events: RunEvent[] = [];
    const emits: RunEmit[] = [];

    const handle = startRun(
      { source: FLOW, ranges: nodeRanges(graph), tools: [], functions: [], input: {}, timeoutMs: 30_000 },
      WORKER,
      (frame: RunFrame) => {
        if (frame.type === "event") {
          const { type: _type, ...event } = frame;
          events.push(event as RunEvent);
        } else if (frame.type === "emit" && frame.nodeId !== null) {
          const { type: _type, ...emit } = frame;
          emits.push(emit as RunEmit);
        }
      },
    );
    void handle.finished.then(() => { resolve({ events, emits, graph }); });
  });
  return recorded;
}

const live = stripsTypesNatively();
if (!live) console.warn(`skipping the live-runner tests: ${TYPE_STRIPPING_REASON}`);

describe.skipIf(!live)("a binding with no schema expands into its observed fields", () => {
  /** The node inside the loop body — `const summary = pick(ticket);`. */
  function bodyNodeId(graph: Recorded["graph"]): string {
    const node = graph.nodes.find((candidate) => candidate.type === "function");
    if (node === undefined) throw new Error("no function node in this flow");
    return node.id;
  }

  function bindingAt(graph: Recorded["graph"], nodeId: string, name: string): ScopeBinding {
    const binding = (graph.scopes[nodeId] ?? []).find((candidate) => candidate.name === name);
    if (binding === undefined) throw new Error(`no binding \`${name}\` in scope at ${nodeId}`);
    return binding;
  }

  it("expands the loop item into `ticket.id`, `ticket.customer`, `ticket.plan`", async () => {
    const { events, emits, graph } = await runOnce();
    const run = summarizeTrace({ events, emits });
    const body = bodyNodeId(graph);
    const ticket = bindingAt(graph, body, "ticket");

    const origin = ticket.origins[0];
    expect(origin, "the analyzer knows which node writes the loop item").toBeDefined();

    // The pass the user has selected — the second ticket.
    const observed = observedAt(run.get(origin.nodeId), [1]);
    expect(observed).toBeDefined();

    const rows = scopeRows(ticket, { ...(observed === undefined ? {} : { observed }) });
    expect(rows.map((row) => row.path)).toEqual(["ticket", "ticket.id", "ticket.customer", "ticket.plan"]);
    expect(rows.every((row) => row.valueSource === "observed")).toBe(true);
    // …and the values are the *selected* pass's, not the last one's.
    expect(rows.find((row) => row.path === "ticket.id")?.value).toBe("T-2");
    expect(rows.find((row) => row.path === "ticket.plan")?.value).toBe("free");
  });

  it("expands a step's own binding into the fields that step produced", async () => {
    const { events, emits, graph } = await runOnce();
    const run = summarizeTrace({ events, emits });
    const body = bodyNodeId(graph);

    // `summary` is block-scoped to the loop body, so the step that sees it is
    // the next one *inside* the loop — `seen.push(summary);`.
    const reader = graph.nodes.find((node) =>
      FLOW.slice(node.source.start.offset, node.source.end.offset).startsWith("seen.push"),
    );
    expect(reader, "no step reads `summary`").toBeDefined();
    const summary = bindingAt(graph, reader!.id, "summary");

    const observed = observedAt(run.get(summary.origins[0].nodeId), [0]);
    const rows = scopeRows(summary, { ...(observed === undefined ? {} : { observed }) });

    expect(rows.map((row) => row.path)).toEqual(["summary", "summary.id", "summary.plan"]);
    expect(rows.find((row) => row.path === "summary.id")?.value).toBe("T-1");
    expect(run.get(body)?.iterations?.map((entry) => entry.preview)).toEqual([
      { id: "T-1", plan: "enterprise" },
      { id: "T-2", plan: "free" },
    ]);
  });

  it("says `declared` for the same binding when no run is passed in", async () => {
    const { graph } = await runOnce();
    const ticket = bindingAt(graph, bodyNodeId(graph), "ticket");
    // The before-a-run state, unchanged: one row, no fields, and it says the
    // value is declared rather than observed.
    const rows = scopeRows(ticket);
    expect(rows.map((row) => row.path)).toEqual(["ticket"]);
    expect(rows[0].valueSource).toBe("declared");
  });
});
