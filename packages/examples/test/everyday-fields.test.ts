/**
 * The twelve everyday steps, configured the way the node editor configures them.
 *
 * A user opened the editor on these two flows and could not configure a single
 * one of the twelve: every node said *"the argument is not a visible object
 * literal (a variable, or several positional args) — fields are not editable"*.
 * The patch engine had been able to patch positional arguments all along
 * (`positionalEdits`, core's patcher/plan.ts); the graph reported
 * `argumentsEditable: false`, and the UI believed it.
 *
 * So this file is the round trip the editor performs, once per function:
 *
 *  1. the node reports `argumentStyle: "positional"`, one named field per
 *     parameter, each with the argument's source text and its position;
 *  2. a patch on one of those fields rewrites exactly that argument and not one
 *     byte more (I3);
 *  3. re-analysis lands on the same node, positional again, carrying the new
 *     value — so the editor can keep editing.
 *
 * Every function of the `common` registry has a case here, and the first test
 * fails if a thirteenth is added without one: a step nobody has patched is a
 * step nobody knows is patchable.
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow, createRegistry, inputSchemaFieldNames } from "@codeflow-team/core";
import type { WorkflowGraph, WorkflowNode } from "@codeflow-team/core";

import { EXAMPLES, REGISTRIES, registryFor } from "../src/index.js";
import type { FlowExample } from "../src/types.js";

const COMMON = REGISTRIES["common"]!;

function exampleFor(id: string): FlowExample {
  const example = EXAMPLES.find((candidate) => candidate.id === id);
  if (example === undefined) throw new Error(`no example "${id}"`);
  return example;
}

async function open(id: string) {
  const example = exampleFor(id);
  const { tools, functions } = registryFor(example);
  const session = createCodeFlow({ registry: createRegistry({ tools, functions }) });
  const file = `${example.id}.flow.ts`;
  const graph = await session.analyze(example.source, { file });
  return { session, graph, source: example.source };
}

/** The first node calling `functionName` — the flows call each step once, or twice with the same shape. */
function callNode(graph: WorkflowGraph, functionName: string): WorkflowNode {
  const found = graph.nodes.find(
    (node) => node.type === "function" && node.data["functionName"] === functionName,
  );
  expect(found, `no node calling ${functionName}`).toBeDefined();
  return found!;
}

function argumentsOf(node: WorkflowNode): Record<string, string> {
  return node.data["arguments"] as Record<string, string>;
}

/**
 * One editor gesture: which field of which step, and the value dropped into it.
 * `expected` is the exact text that must end up in the source — a literal keeps
 * its literal form, an expression is written verbatim (06 §3).
 */
interface FieldCase {
  fn: string;
  example: string;
  field: string;
  value: unknown;
  expected: string;
}

const CASES: FieldCase[] = [
  {
    fn: "extractJson",
    example: "everyday-order-digest",
    field: "raw",
    value: { kind: "expression", text: "String(file.content)" },
    expected: "String(file.content)",
  },
  {
    fn: "splitOutField",
    example: "everyday-order-digest",
    field: "field",
    value: "lines",
    expected: '"lines"',
  },
  {
    fn: "filterRecords",
    example: "everyday-order-digest",
    field: "predicate",
    value: { kind: "expression", text: "(order) => order.total > 100" },
    expected: "(order) => order.total > 100",
  },
  {
    fn: "sortRecords",
    example: "everyday-order-digest",
    field: "direction",
    value: "ascending",
    expected: '"ascending"',
  },
  {
    fn: "limitRecords",
    example: "everyday-order-digest",
    field: "count",
    value: 25,
    expected: "25",
  },
  {
    fn: "aggregateRecords",
    example: "everyday-order-digest",
    field: "operation",
    value: "max",
    expected: '"max"',
  },
  {
    fn: "formatText",
    example: "everyday-order-digest",
    field: "template",
    value: "{{ count }} order(s).",
    expected: '"{{ count }} order(s)."',
  },
  {
    fn: "dedupeRecords",
    example: "ticket-triage-agent",
    field: "key",
    value: "ticketId",
    expected: '"ticketId"',
  },
  {
    fn: "dateTimeStep",
    example: "ticket-triage-agent",
    field: "amount",
    value: 3,
    expected: "3",
  },
  {
    fn: "runAgentStep",
    example: "ticket-triage-agent",
    field: "temperature",
    value: 0.5,
    expected: "0.5",
  },
  {
    fn: "setFields",
    example: "ticket-triage-agent",
    field: "mode",
    value: "replace",
    expected: '"replace"',
  },
  {
    fn: "waitMs",
    example: "ticket-triage-agent",
    field: "ms",
    value: 250,
    expected: "250",
  },
];

describe("the twelve everyday steps", () => {
  it("all twelve have a configured field here", () => {
    const covered = [...new Set(CASES.map((testCase) => testCase.fn))].sort();
    const registered = COMMON.functions.map((fn) => fn.name).sort();
    expect(covered).toEqual(registered);
    expect(registered).toHaveLength(12);
  });

  it.each(CASES.map((testCase) => [testCase.fn, testCase] as const))(
    "%s exposes one named field per parameter",
    async (fn, testCase) => {
      const { graph } = await open(testCase.example);
      const node = callNode(graph, fn);
      const definition = COMMON.functions.find((candidate) => candidate.name === fn)!;
      const names = inputSchemaFieldNames(definition.inputSchema)!;

      expect(node.data["argumentStyle"], fn).toBe("positional");
      expect(node.data["argumentsEditable"], fn).toBe(true);
      expect(node.capabilities.editable, fn).toBe(true);

      // Every parameter is a field, named by the schema and placed by the call.
      expect(Object.keys(argumentsOf(node)), fn).toEqual(names);
      expect(node.data["argumentPositions"], fn).toEqual(
        Object.fromEntries(names.map((name, index) => [name, index])),
      );
      // And every field's value is the argument's own source text.
      for (const [name, text] of Object.entries(argumentsOf(node))) {
        expect(node.source.file, fn).toBeDefined();
        expect(typeof text, `${fn}.${name}`).toBe("string");
      }
      expect(node.data["argumentText"], fn).toContain(argumentsOf(node)[names[0]]);
    },
  );

  it.each(CASES.map((testCase) => [`${testCase.fn}.${testCase.field}`, testCase] as const))(
    "%s patches exactly its own argument and re-analyzes stably",
    async (name, testCase) => {
      const { session, graph, source } = await open(testCase.example);
      const node = callNode(graph, testCase.fn);
      const before = argumentsOf(node)[testCase.field];
      expect(before, name).toBeDefined();
      expect(before, name).not.toBe(testCase.expected);

      const result = await session.patchNode(node.id, { [testCase.field]: testCase.value });

      // Minimal: one range, holding exactly the old argument, and the rest of
      // the file byte-identical around it (I3).
      expect(result.patches, name).toHaveLength(1);
      const patch = result.patches[0];
      expect(patch.oldText, name).toBe(before);
      expect(patch.newText, name).toBe(testCase.expected);
      const start = patch.range.start.offset;
      const end = patch.range.end.offset;
      expect(source.slice(start, end), name).toBe(before);
      expect(result.source, name).toBe(
        source.slice(0, start) + testCase.expected + source.slice(end),
      );

      // Stable: the same node, still positional, carrying the new value — the
      // editor can go straight on editing the next field.
      const after = result.graph.nodes.find(
        (candidate) => candidate.source.semanticPath === node.source.semanticPath,
      );
      expect(after, name).toBeDefined();
      expect(after!.id, name).toBe(node.id);
      expect(after!.data["argumentStyle"], name).toBe("positional");
      expect(argumentsOf(after!)[testCase.field], name).toBe(testCase.expected);
      expect(
        result.graph.diagnostics.filter((diagnostic) => diagnostic.severity === "error"),
        name,
      ).toEqual([]);
    },
  );

  it("refuses to remove a positional argument, whichever step it is", async () => {
    // Removing argument 2 of 3 turns argument 3 into argument 2 — a silent
    // change of meaning, refused by name (06 §2).
    const { session, graph } = await open("everyday-order-digest");
    const node = callNode(graph, "limitRecords");
    const caught = await session
      .patchNode(node.id, { count: { kind: "remove" } })
      .catch((error: unknown) => error);
    expect((caught as Error).message).toContain("shift every argument after it");
  });

  it("still refuses a name nothing binds at the step", async () => {
    // The scope check runs on a positional argument exactly as on an
    // object-literal field (03 §6, 06 §3): the drag gesture is the same gesture.
    const { session, graph } = await open("everyday-order-digest");
    const node = callNode(graph, "limitRecords");
    const caught = await session
      .patchNode(node.id, { records: { kind: "expression", text: "tickets" } })
      .catch((error: unknown) => error);
    expect((caught as Error).message).toContain("`tickets` is not available here");
  });

  it("leaves the local helper opaque — nothing names its parameters", async () => {
    // `collectTriaged` is declared in the flow file, so no registered input
    // schema names its parameters and the patcher has no field to edit. Saying
    // "editable" there would be the same lie in the other direction.
    const { graph } = await open("ticket-triage-agent");
    const node = graph.nodes.find((candidate) => candidate.data["functionName"] === "collectTriaged");
    expect(node).toBeDefined();
    expect(node!.data["functionSource"]).toBe("local");
    expect(node!.data["argumentStyle"]).toBe("opaque");
    expect(node!.data["argumentsEditable"]).toBe(false);
  });

  it("keeps the filesystem tools on the object style", async () => {
    // Tools are called with one object literal; nothing about this change moves
    // them onto the positional path (06 §1).
    const { graph } = await open("everyday-order-digest");
    const tool = graph.nodes.find((candidate) => candidate.type === "tool");
    expect(tool).toBeDefined();
    expect(tool!.data["argumentStyle"]).toBe("object");
    expect(tool!.data["argumentPositions"]).toBeUndefined();
  });

  it("gives the flow's own input a shape to drag from", async () => {
    // Defect one, seen from the flow that exposed it: `input.ticketsPath` has to
    // be reachable as a row of its own in the left pane (03 §11).
    const { graph } = await open("ticket-triage-agent");
    const step = callNode(graph, "extractJson");
    const binding = (graph.scopes[step.id] ?? []).find((candidate) => candidate.name === "input");
    expect(binding).toBeDefined();
    expect(binding!.schema).toEqual({
      ticketsPath: "string",
      summaryPath: "string",
      maxTickets: "number",
      pauseMs: "number",
    });
  });
});
