/**
 * The node editor's decision layer, against a **real** graph from
 * `@codeflow-team/core`.
 *
 * The gesture this whole feature exists for — drag the output of one step into
 * a parameter of another — is a field patch, and these tests hold it to that:
 * the `changes` a drop produces are handed to the real patch engine, and the
 * engine's refusal is the one the user is shown.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createCodeFlow,
  createRegistry,
  sampleFromSchema,
  type NodeRunState,
  type ScopeBinding,
  type WorkflowGraph,
} from "@codeflow-team/core";
import { scopeRows, groupScope, describeSchema } from "../src/editor/scope-rows.js";
import { canDrop, dropInto, rootNameOf } from "../src/editor/drop.js";
import { resultItems, traceNotice, observedAt, LATEST_LABEL } from "../src/editor/result.js";
import { pickPreviewRenderer, previewText } from "../src/editor/preview.js";
import { runBadgeKind, isCompleted } from "../src/flow/run-badge.js";
import { resolveNodeRenderer, rendererMeasurer, DEFAULT_NODE_BODY_HEIGHT } from "../src/flow/renderer.js";
import { measureNode } from "../src/layout/measure.js";
import { resolveInspectorFields } from "../src/inspector/fields.js";
import { node as fixtureNode } from "./fixtures.js";

/* -------------------------------------------------------------------------- */
/* a real flow                                                                 */
/* -------------------------------------------------------------------------- */

const SOURCE = `import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });

  for (const pr of prs) {
    await tools.slack.send({
      channel: "#security",
      message: \`Security PR: \${pr.title}\`
    });
  }
}
`;

/** `prs` has a real JSON Schema, so it is the one that can be sampled. */
const PR_ITEM = {
  type: "object",
  properties: { title: { type: "string" }, number: { type: "number" } },
} as const;

function makeSession() {
  const registry = createRegistry({
    tools: [
      {
        name: "github.getNewPRs",
        label: "Get New PRs",
        inputSchema: { repo: "string" },
        outputSchema: { type: "array", items: PR_ITEM },
        editableFields: ["repo"],
      },
      {
        name: "slack.send",
        label: "Slack Send",
        inputSchema: { channel: "string", message: "string", silent: "boolean" },
        editableFields: ["channel", { name: "message", editor: "expression" }, "silent"],
      },
    ],
  });
  return createCodeFlow({ registry });
}

async function analyzed(): Promise<{ graph: WorkflowGraph; session: ReturnType<typeof makeSession> }> {
  const session = makeSession();
  const graph = await session.analyze(SOURCE);
  return { graph, session };
}

function nodeIdOf(graph: WorkflowGraph, label: string): string {
  const found = graph.nodes.find((candidate) => candidate.label === label);
  if (found === undefined) throw new Error(`no node labelled ${label}`);
  return found.id;
}

function bindingAt(graph: WorkflowGraph, nodeId: string, name: string): ScopeBinding {
  const found = (graph.scopes[nodeId] ?? []).find((binding) => binding.name === name);
  if (found === undefined) throw new Error(`no binding ${name} at ${nodeId}`);
  return found;
}

/* -------------------------------------------------------------------------- */
/* scopeRows                                                                   */
/* -------------------------------------------------------------------------- */

describe("scopeRows — what can be dragged, and where its value came from", () => {
  it("derives rows from an object schema", () => {
    const binding: ScopeBinding = { name: "pr", kind: "value", origins: [], schema: PR_ITEM };
    const rows = scopeRows(binding);
    expect(rows.map((row) => row.path)).toEqual(["pr", "pr.title", "pr.number"]);
    expect(rows[1].label).toBe("title");
    expect(rows[1].typeText).toBe("string");
    expect(rows.every((row) => row.bindingName === "pr")).toBe(true);
  });

  it("steps into an array of objects by index, so the expression says what it does", async () => {
    const { graph } = await analyzed();
    const rows = scopeRows(bindingAt(graph, nodeIdOf(graph, "For Each pr in prs"), "prs"));
    expect(rows.map((row) => row.path)).toEqual(["prs", "prs[0]", "prs[0].title", "prs[0].number"]);
    // `prs[0].title` is legal TypeScript that means exactly the first item —
    // no index is implied that the source would not contain.
    expect(rows[1].label).toBe("first item");
    expect(rows[0].typeText).toBe("object[]");
    expect(rows[2].typeText).toBe("string");
    expect(describeSchema({ type: "array", items: PR_ITEM })).toBe("object[]");
  });

  it("gives a scalar exactly one row", () => {
    const rows = scopeRows({ name: "count", kind: "value", origins: [], schema: { type: "number" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "count", typeText: "number" });
  });

  it("gives a binding with no schema and no run the binding itself, marked declared", () => {
    const rows = scopeRows({ name: "pr", kind: "value", origins: [], loopItem: true });
    expect(rows).toHaveLength(1);
    expect(rows[0].path).toBe("pr");
    expect(rows[0].valueSource).toBe("declared");
    expect(rows[0].hasValue).toBe(false);
    expect(rows[0].loopItem).toBe(true);
  });

  it("marks schema-only rows as samples, and uses core's own sample values", () => {
    const binding: ScopeBinding = { name: "pr", kind: "value", origins: [], schema: PR_ITEM };
    const rows = scopeRows(binding);
    expect(rows.every((row) => row.valueSource === "sample")).toBe(true);
    // Asserted against `sampleFromSchema` itself, so the picture and the run
    // can never disagree about the value for one schema.
    expect(rows[0].value).toEqual(sampleFromSchema(PR_ITEM));
    expect(rows[1].value).toBe((sampleFromSchema(PR_ITEM) as { title: string }).title);
  });

  it("prefers an observed value over a sample, and never shows both", () => {
    const binding: ScopeBinding = { name: "pr", kind: "value", origins: [], schema: PR_ITEM };
    const rows = scopeRows(binding, { observed: { value: { title: "Fix auth", number: 7 } } });
    expect(rows.map((row) => row.valueSource)).toEqual(["observed", "observed", "observed"]);
    expect(rows[1].value).toBe("Fix auth");
    expect(rows[1].value).not.toBe((sampleFromSchema(PR_ITEM) as { title: string }).title);
  });

  it("falls back to declared for a field the run did not produce", () => {
    const binding: ScopeBinding = { name: "pr", kind: "value", origins: [], schema: PR_ITEM };
    const rows = scopeRows(binding, { observed: { value: { title: "Fix auth" } } });
    expect(rows.find((row) => row.path === "pr.title")?.valueSource).toBe("observed");
    expect(rows.find((row) => row.path === "pr.number")?.valueSource).toBe("declared");
    expect(rows.find((row) => row.path === "pr.number")?.hasValue).toBe(false);
  });

  it("names the origin step, never its id", async () => {
    const { graph } = await analyzed();
    const rows = scopeRows(bindingAt(graph, nodeIdOf(graph, "For Each pr in prs"), "prs"), {
      originLabel: "Get New PRs",
    });
    expect(rows[0].originLabel).toBe("Get New PRs");
    expect(JSON.stringify(rows)).not.toContain("n_");
  });

  it("gives the loop item its fields, from the analyzer's own table", async () => {
    const { graph } = await analyzed();
    const inside = nodeIdOf(graph, "Slack Send");
    const pr = bindingAt(graph, inside, "pr");
    // The item schema is derived once, in the analyzer (`itemSchemaOf`), so the
    // tree offered here and the names the patch engine accepts cannot diverge.
    expect(pr.loopItem).toBe(true);
    expect(pr.schema).toEqual(PR_ITEM);
    const rows = scopeRows(pr);
    expect(rows.map((row) => row.path)).toEqual(["pr", "pr.title", "pr.number"]);
  });

  it("keeps imports and `tools` out of the draggable list without hiding them", async () => {
    const { graph } = await analyzed();
    const groups = groupScope(graph.scopes[nodeIdOf(graph, "Slack Send")] ?? []);
    expect(groups.values.map((binding) => binding.name)).toContain("pr");
    expect(groups.other.map((binding) => binding.name)).toContain("tools");
    // Loop item first: inside a loop it is what the user reaches for.
    expect(groups.values[0].loopItem).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* dropInto                                                                    */
/* -------------------------------------------------------------------------- */

async function slackFields() {
  const { graph, session } = await analyzed();
  const id = nodeIdOf(graph, "Slack Send");
  const model = resolveInspectorFields(
    graph.nodes.find((candidate) => candidate.id === id)!,
    session.registry,
  );
  return { graph, session, id, model };
}

describe("dropInto — a drop is an ordinary field patch", () => {
  it("fills an empty field with the expression itself", async () => {
    const { model } = await slackFields();
    const silent = model.fields.find((field) => field.name === "silent")!;
    const result = dropInto(silent, { path: "pr.title" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("expression");
    expect(result.changes).toEqual({ silent: { kind: "expression", text: "pr.title" } });
    expect(result.promotedToTemplate).toBe(false);
  });

  it("turns a plain string into a template, and says that it did", async () => {
    const { model } = await slackFields();
    const channel = model.fields.find((field) => field.name === "channel")!;
    const result = dropInto(channel, { path: "pr.title" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display).toBe("#security{{ pr.title }}");
    expect(result.kind).toBe("template");
    expect(result.promotedToTemplate).toBe(true);
    expect(result.note).not.toBeNull();
    expect(result.changes).toEqual({ channel: { kind: "template", text: "#security${pr.title}" } });
  });

  it("inserts at the caret when the caret is in the middle of the string", async () => {
    const { model } = await slackFields();
    const channel = model.fields.find((field) => field.name === "channel")!;
    const result = dropInto(channel, { path: "pr.title" }, { caret: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.display).toBe("#{{ pr.title }}security");
    expect(result.changes).toEqual({ channel: { kind: "template", text: "#${pr.title}security" } });
    expect(result.caret).toBe(1 + "{{ pr.title }}".length);
  });

  it("adds one more interpolation to a field that is already a template", async () => {
    const { model } = await slackFields();
    const message = model.fields.find((field) => field.name === "message")!;
    // `Security PR: {{ pr.title }}` — the display form of the template literal.
    const result = dropInto(message, { path: "pr.number" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.kind).toBe("template");
    expect(result.promotedToTemplate).toBe(false);
    expect(result.display).toBe("Security PR: {{ pr.title }}{{ pr.number }}");
    expect(result.changes).toEqual({
      message: { kind: "template", text: "Security PR: ${pr.title}${pr.number}" },
    });
  });

  it("inserts into an expression field exactly where the caret is", async () => {
    const { graph } = await analyzed();
    const loop = graph.nodes.find((candidate) => candidate.type === "loop")!;
    const model = resolveInspectorFields(loop, null);
    const iterable = model.fields.find((field) => field.name === "iterable")!;
    const result = dropInto(iterable, { path: "extra" }, { caret: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // `$iterable` owns its construct, so the change is the operation, not a
    // property — the shape the patch engine expects for a `for…of`.
    expect(result.changes).toEqual({ $iterable: "extraprs" });
  });

  it("refuses a field the patch engine cannot edit, in that field's own words", async () => {
    const { graph } = await analyzed();
    const loop = graph.nodes.find((candidate) => candidate.type === "loop")!;
    const variable = resolveInspectorFields(loop, null).fields.find((field) => field.name === "variable")!;
    const result = dropInto(variable, { path: "pr" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toBe(variable.blockedReason);
  });

  it("produces changes the real patch engine accepts", async () => {
    const { graph, session, model } = await slackFields();
    const channel = model.fields.find((field) => field.name === "channel")!;
    const dropped = dropInto(channel, { path: "pr.title" }, { text: "", caret: 0 });
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) return;
    const patched = await session.patchNode(nodeIdOf(graph, "Slack Send"), dropped.changes, {
      source: SOURCE,
    });
    expect(patched.source).toContain("channel: pr.title");
  });
});

/* -------------------------------------------------------------------------- */
/* canDrop                                                                     */
/* -------------------------------------------------------------------------- */

describe("canDrop — scope decides, not the UI", () => {
  it("allows the loop item inside the loop and refuses it before it", async () => {
    const { graph } = await analyzed();
    const inside = nodeIdOf(graph, "Slack Send");
    const before = nodeIdOf(graph, "Get New PRs");
    const row = { path: "pr.title", bindingName: "pr" };

    expect(canDrop(row, inside, graph)).toEqual({ ok: true });

    const outside = canDrop(row, before, graph);
    expect(outside.ok).toBe(false);
    if (outside.ok) return;
    expect(outside.reason).toContain("pr");
  });

  it("refuses when nothing is analyzed, rather than guessing", () => {
    expect(canDrop({ path: "pr", bindingName: "pr" }, "n_1", null).ok).toBe(false);
  });

  it("asks about the root name of a path", () => {
    expect(rootNameOf("prs[0].title")).toBe("prs");
    expect(rootNameOf("pr")).toBe("pr");
  });
});

/* -------------------------------------------------------------------------- */
/* the engine's refusal, verbatim                                              */
/* -------------------------------------------------------------------------- */

describe("a refusal from core is surfaced, never reworded", () => {
  it("comes back naming the offender and listing what is in scope", async () => {
    const { graph, session, model } = await slackFields();
    const channel = model.fields.find((field) => field.name === "channel")!;
    // Deliberately dropping something that is not in scope here, which is what
    // `canDrop` exists to prevent — but if the UI ever gets it wrong, the
    // engine is the thing that must stop it.
    const dropped = dropInto(channel, { path: "files.length" }, { text: "", caret: 0 });
    expect(dropped.ok).toBe(true);
    if (!dropped.ok) return;

    let message: string | null = null;
    try {
      await session.patchNode(nodeIdOf(graph, "Slack Send"), dropped.changes, { source: SOURCE });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).not.toBeNull();
    expect(message).toContain("`files`");
    expect(message).toContain("values in scope at this step");
    expect(message).toContain("pr");

    // And the UI's own pre-check does not try to say the same thing a second
    // time: one source of truth for the refusal.
    const check = canDrop({ path: "files.length", bindingName: "files" }, nodeIdOf(graph, "Slack Send"), graph);
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.reason).not.toBe(message);
    expect(check.reason).not.toContain("values in scope at this step");
  });

  it("is rendered as the engine wrote it", () => {
    // A source-level guard, because the rendering itself needs a DOM: the
    // editor must print `refusal.message`, not a rewritten version of it.
    const source = readFileSync(
      fileURLToPath(new URL("../src/editor/NodeEditor.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).toContain("{refusal.message}");
    expect(source).not.toContain("splitSpecRefs(refusal.message)");
  });
});

/* -------------------------------------------------------------------------- */
/* the result pane                                                             */
/* -------------------------------------------------------------------------- */

function runState(partial: Partial<NodeRunState>): NodeRunState {
  return { nodeId: "n", runs: 1, status: "ok", totalMs: 0, lastAt: 0, ...partial };
}

describe("result — an item number is only ever the runtime's", () => {
  it("addresses item N when the run counted iterations", () => {
    const state = runState({
      runs: 3,
      iterations: [
        { iteration: [0], status: "ok", preview: "first" },
        { iteration: [1], status: "ok", preview: "second" },
        { iteration: [2], status: "ok", preview: "third" },
      ],
    });
    const items = resultItems(state);
    expect(items.map((item) => item.label)).toEqual(["Item 1", "Item 2", "Item 3"]);
    expect(items[2].iteration).toEqual([2]);
    expect(items[2].value).toBe("third");
  });

  it("names a nested pass by every level it knows", () => {
    const items = resultItems(
      runState({ iterations: [{ iteration: [2, 0], status: "ok", preview: "x" }] }),
    );
    expect(items[0].label).toBe("Item 3 · 1");
  });

  it("says 'latest' — and invents no number — when the run counted nothing", () => {
    const items = resultItems(runState({ runs: 4, preview: "last value" }));
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe(LATEST_LABEL);
    expect(items[0].iteration).toBeNull();
    expect(items[0].label).not.toMatch(/\d/);
    expect(items[0].value).toBe("last value");
  });

  it("has nothing to show for a node the run never mentioned", () => {
    expect(resultItems(undefined)).toEqual([]);
  });

  it("reads the value of the pass that was asked for", () => {
    const state = runState({
      iterations: [
        { iteration: [0], status: "ok", preview: { value: "a" } },
        { iteration: [1], status: "ok", preview: { value: "b" } },
      ],
    });
    expect(observedAt(state, [1])).toEqual({ value: "b" });
    // An unknown pass falls back to the most recent value, never to nothing.
    expect(observedAt(state, [9])).toEqual({ value: "b" });
    expect(observedAt(undefined, null)).toBeUndefined();
  });
});

describe("trace freshness — stale and unknown never read as current", () => {
  it("only `current` is current", () => {
    expect(traceNotice("current").current).toBe(true);
    expect(traceNotice("stale").current).toBe(false);
    expect(traceNotice("unknown").current).toBe(false);
  });

  it("says a stale run belongs to an earlier version of the flow", () => {
    const notice = traceNotice("stale");
    expect(notice.tone).toBe("warn");
    expect(`${notice.title} ${notice.text}`.toLowerCase()).toContain("earlier version");
  });

  it("renders an unattached run as uncertainty, not as fact", () => {
    const notice = traceNotice("unknown");
    expect(notice.tone).not.toBe("ok");
    expect(`${notice.title} ${notice.text}`.toLowerCase()).toContain("out of date");
  });
});

/* -------------------------------------------------------------------------- */
/* the run badge                                                               */
/* -------------------------------------------------------------------------- */

describe("run badge — a node with emits but no lifecycle event is not 'in progress'", () => {
  it("reads an emit-only node as having sent output, not as running", () => {
    const state = runState({
      runs: 0,
      status: "running",
      emits: [{ nodeId: "n", at: 1, kind: "log", payload: "hello" }],
    });
    const kind = runBadgeKind(state, false);
    expect(kind).toBe("emitted-only");
    expect(isCompleted(kind)).toBe(false);
  });

  it("says nothing was reported when the run mentions a node and nothing else", () => {
    expect(runBadgeKind(runState({ runs: 0, status: "running" }), false)).toBe("reported-nothing");
  });

  it("never draws a skipped step as a completed one", () => {
    const kind = runBadgeKind(runState({ runs: 1, status: "skipped" }), false);
    expect(kind).toBe("skipped");
    expect(isCompleted(kind)).toBe(false);
  });

  it("still reads a real container as in progress", () => {
    expect(runBadgeKind(runState({ runs: 1, status: "running" }), false)).toBe("container");
    expect(runBadgeKind(runState({ runs: 1, status: "running" }), true)).toBe("running");
    expect(runBadgeKind(runState({ runs: 2, status: "ok", totalMs: 12 }), false)).toBe("ok");
  });
});

/* -------------------------------------------------------------------------- */
/* the renderer seam                                                           */
/* -------------------------------------------------------------------------- */

describe("renderer seam", () => {
  const context = { value: { a: 1 }, kind: null, nodeId: "n" };

  it("takes the first host renderer that matches, in the host's order", () => {
    const first = { id: "a", match: () => true, render: () => null };
    const second = { id: "b", match: () => true, render: () => null };
    expect(pickPreviewRenderer([first, second], context)?.id).toBe("a");
  });

  it("falls through to the built-in when nothing matches, or when a matcher throws", () => {
    expect(pickPreviewRenderer([], context)).toBeNull();
    const broken = { id: "boom", match: () => { throw new Error("nope"); }, render: () => null };
    expect(pickPreviewRenderer([broken], context)).toBeNull();
  });

  it("renders a string as itself and anything else as JSON", () => {
    expect(previewText("hello")).toBe("hello");
    expect(previewText({ a: 1 })).toBe('{\n  "a": 1\n}');
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(previewText(cyclic)).toContain("object");
  });

  it("resolves a registered node renderer, and ignores a malformed one", () => {
    const component = (): null => null;
    const registry = {
      getNode: (type: string) =>
        type === "chart"
          ? ({ type, label: "Chart", editableFields: [], renderer: component } as never)
          : type === "odd"
            ? ({ type, label: "Odd", editableFields: [], renderer: 42 } as never)
            : undefined,
      getTool: () => undefined,
      getFunction: () => undefined,
      listTools: () => [],
      listFunctions: () => [],
      listNodes: () => [],
    } as never;

    expect(resolveNodeRenderer(registry, "chart")).toEqual({
      component,
      height: DEFAULT_NODE_BODY_HEIGHT,
    });
    expect(resolveNodeRenderer(registry, "odd")).toBeNull();
    expect(resolveNodeRenderer(null, "chart")).toBeNull();
  });

  it("lays a custom node out at the height its renderer declared", () => {
    const component = (): null => null;
    const registry = {
      getNode: (type: string) =>
        type === "chart"
          ? ({ type, label: "Chart", editableFields: [], renderer: { height: 90, render: component } } as never)
          : undefined,
      getTool: () => undefined,
      getFunction: () => undefined,
      listTools: () => [],
      listFunctions: () => [],
      listNodes: () => [],
    } as never;

    const custom = fixtureNode({ id: "n_chart", type: "chart" as never, label: "Chart", path: "flow/chart#0" });
    const measure = rendererMeasurer(registry);
    // The card measured with the renderer's body is exactly the card measured
    // without it, with the declared body swapped in — which is what keeps the
    // rendered card inside the box ELK gave it.
    expect(measure(custom, "expanded", null, null).height).toBe(
      measureNode(custom, "expanded", null, null, 90).height,
    );
    // The beginner level is one line per step, renderer or not.
    expect(measure(custom, "compact", null, null)).toEqual(measureNode(custom, "compact", null, null));
  });

  it("leaves every built-in node type measured exactly as before", async () => {
    const { graph } = await analyzed();
    const measure = rendererMeasurer(null);
    for (const candidate of graph.nodes) {
      expect(measure(candidate, "expanded", null, null)).toEqual(
        measureNode(candidate, "expanded", null, null),
      );
    }
  });
});
