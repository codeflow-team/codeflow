/**
 * The trigger's `input` port — a shape when the syntax states one, a name when
 * it does not (03 §11, `analyzer/type-schema.ts`).
 *
 * Found by driving the editor: a flow declared
 * `input: { ticketsPath: string; … }` and the left pane showed one row whose
 * value was the raw text `{ ticketsPath: string; summaryPath:` — no children,
 * so `input.ticketsPath`, the most obvious thing to drag in the whole flow,
 * could not be dragged. The port carried a `TsTypeRef`, and a type ref is a
 * name: `scopeRows`/`childrenOf` in packages/react are right to refuse to walk
 * one without a checker. An object type **literal** needs no checker, so it is
 * emitted as a `NamedFieldsSchema` instead.
 *
 * The other half of the file is the refusals. Every shape whose members live
 * behind the type checker resolves to nothing and keeps the string it always
 * had — inventing members for `Ticket` would be I6 with extra steps.
 */

import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/analyzer/index.js";
import { namedFieldsFromTypeNode } from "../src/analyzer/type-schema.js";
import { createCodeFlow } from "../src/session.js";
import { CodeFlowError } from "../src/errors.js";
import { createSampleRegistry } from "./fixtures.js";
import type { Schema, WorkflowGraph, WorkflowNode } from "../src/model/index.js";

const FILE = "flow.ts";

function flowSource(inputType: string, body = `  await tools.slack.send({ channel: "#a", message: "b" });`): string {
  return `import type { Tools } from "../generated/tools";

export default async function flow(input: ${inputType}, tools: Tools) {
${body}
}
`;
}

function analyze(inputType: string, body?: string): WorkflowGraph {
  return analyzeSource(flowSource(inputType, body), createSampleRegistry(), { file: FILE });
}

function node(graph: WorkflowGraph, path: string): WorkflowNode {
  const found = graph.nodes.find((candidate) => candidate.source.semanticPath === path);
  expect(found, `no node at ${path}`).toBeDefined();
  return found!;
}

/** Schema of the trigger's single output port. */
function inputSchema(inputType: string): Schema | undefined {
  const trigger = node(analyze(inputType), "flow#trigger");
  expect(trigger.outputs).toHaveLength(1);
  return trigger.outputs[0].schema;
}

describe("an object type literal becomes a shape", () => {
  it("names every member of a flat literal", () => {
    expect(inputSchema("{ ticketsPath: string; summaryPath: string; maxTickets: number }")).toEqual({
      ticketsPath: "string",
      summaryPath: "string",
      maxTickets: "number",
    });
  });

  it("recurses into a nested literal", () => {
    expect(inputSchema("{ user: { id: string; name: string }; retries: number }")).toEqual({
      user: { id: "string", name: "string" },
      retries: "number",
    });
  });

  it("keeps an optional member — it is a name the user can still reach", () => {
    // The union has no way to spell "optional" (03 §11). Dropping the member
    // would hide a field that exists; showing it is the lesser claim.
    expect(inputSchema("{ path: string; head?: number }")).toEqual({
      path: "string",
      head: "number",
    });
  });

  it("carries a member whose type is a name as that name", () => {
    // `Ticket[]` is not walkable, but it is exactly what the source says the
    // field's type is — the string belongs on the field, not on the object.
    expect(inputSchema("{ tickets: Ticket[]; since: string }")).toEqual({
      tickets: "Ticket[]",
      since: "string",
    });
  });

  it("normalises the spacing the source happened to use", () => {
    expect(inputSchema("{  repository :   string  }")).toEqual({ repository: "string" });
  });

  it("resolves an empty literal to an empty map", () => {
    expect(inputSchema("{}")).toEqual({});
  });
});

describe("a type this module cannot read keeps its string", () => {
  it("leaves a bare type name alone", () => {
    expect(inputSchema("Ticket")).toBe("Ticket");
  });

  it("leaves an array of a named type alone", () => {
    expect(inputSchema("File[]")).toBe("File[]");
  });

  it("leaves an intersection alone rather than merging it", () => {
    expect(inputSchema("{ a: string } & { b: number }")).toBe("{ a: string } & { b: number }");
  });

  it("leaves a union alone rather than picking a side", () => {
    expect(inputSchema("{ a: string } | { b: number }")).toBe("{ a: string } | { b: number }");
  });

  it("leaves a mapped type alone", () => {
    expect(inputSchema("{ [K in \"a\" | \"b\"]: string }")).toBe("{ [K in \"a\" | \"b\"]: string }");
  });

  it("leaves a conditional type alone", () => {
    expect(inputSchema("Ticket extends object ? { a: string } : { b: string }")).toBe(
      "Ticket extends object ? { a: string } : { b: string }",
    );
  });

  it("drops a literal carrying a member this module cannot name", () => {
    // An index signature says "there are fields here nobody wrote down". Listing
    // only the ones that were written invites the reader to believe that is all.
    expect(inputSchema("{ known: string; [key: string]: unknown }")).toBe(
      "{ known: string; [key: string]: unknown }",
    );
  });

  it("drops a literal a consumer would read as a JSON Schema", () => {
    // `isJsonSchema` claims any record carrying a JSON Schema keyword (03 §11,
    // model/schema.ts). Emitting this map would make every consumer read it as
    // a schema of type `"string"` — a name mapped to a wrong meaning (I6).
    expect(inputSchema("{ type: string; name: string }")).toBe("{ type: string; name: string }");
  });

  it("says nothing at all when the parameter has no annotation", () => {
    const trigger = node(analyzeSource(
      `import type { Tools } from "../generated/tools";

export default async function flow(input, tools: Tools) {
  await tools.slack.send({ channel: "#a", message: "b" });
}
`,
      createSampleRegistry(),
      { file: FILE },
    ), "flow#trigger");
    expect(trigger.outputs[0].schema).toBeUndefined();
  });

  it("is not fooled by a non-type node", () => {
    expect(namedFieldsFromTypeNode(undefined)).toBeUndefined();
  });
});

describe("what the left pane can therefore offer", () => {
  const graph = analyze(
    "{ ticketsPath: string; summaryPath: string; maxTickets: number }",
    `  const file = await tools.github.getFiles({ pr: input.ticketsPath });
  await tools.slack.send({ channel: "#a", message: "b" });`,
  );

  it("lists `input` with its shape at a node in the body", () => {
    const target = node(graph, "flow/call:slack.send[0]");
    const binding = (graph.scopes[target.id] ?? []).find((candidate) => candidate.name === "input");
    expect(binding).toBeDefined();
    expect(binding!.parameter).toBe(true);
    // This is the whole point: a map has children, a string does not — so a UI
    // can offer `input.ticketsPath` as a row of its own.
    expect(binding!.schema).toEqual({
      ticketsPath: "string",
      summaryPath: "string",
      maxTickets: "number",
    });
  });

  it("keeps `data.inputType` as the text the source wrote", () => {
    // The inspector shows the annotation verbatim; the shape is the port's job.
    expect(node(graph, "flow#trigger").data["inputType"]).toBe(
      "{ ticketsPath: string; summaryPath: string; maxTickets: number }",
    );
  });
});

describe("dragging a property of `input` into a field", () => {
  const source = flowSource(
    "{ ticketsPath: string; summaryPath: string }",
    `  await tools.slack.send({ channel: "#a", message: "b" });`,
  );

  async function open() {
    const session = createCodeFlow({ registry: createSampleRegistry() });
    const graph = await session.analyze(source, { file: FILE });
    return { session, graph };
  }

  it("writes `input.ticketsPath` into a field", async () => {
    const { session, graph } = await open();
    const target = node(graph, "flow/call:slack.send[0]");
    const result = await session.patchNode(target.id, {
      channel: { kind: "expression", text: "input.ticketsPath" },
    });
    expect(result.source).toContain("channel: input.ticketsPath");
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].oldText).toBe('"#a"');
  });

  it("does NOT refuse `input.nope` — the check is about bindings, not properties", async () => {
    // Asserted so a future change is deliberate: `checkExpressionScope` answers
    // "is this name bound here", and `input` is. Whether `input` has a property
    // called `nope` is a question for the type checker, which does not run on
    // this path (04 §1.2). A patch that writes a field the schema does not name
    // is therefore accepted, and the graph re-analyzes cleanly.
    const { session, graph } = await open();
    const target = node(graph, "flow/call:slack.send[0]");
    const result = await session.patchNode(target.id, {
      channel: { kind: "expression", text: "input.nope" },
    });
    expect(result.source).toContain("channel: input.nope");
  });

  it("still refuses a name nothing binds", async () => {
    const { session, graph } = await open();
    const target = node(graph, "flow/call:slack.send[0]");
    const caught = await session
      .patchNode(target.id, { channel: { kind: "expression", text: "ticketsPath" } })
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(CodeFlowError);
    expect((caught as CodeFlowError).message).toContain("ticketsPath");
  });
});
