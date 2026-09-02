/**
 * `data.argumentStyle` — how a call passes its arguments, and therefore what
 * the inspector may offer (04 §2.1/§2.2, 06 §1).
 *
 * Found by driving the editor: every one of the twelve "everyday steps" — Edit
 * Fields, Filter, Sort, Limit, Aggregate, Agent … — refused to show a single
 * editable field, with *"the argument is not a visible object literal (a
 * variable, or several positional args)"*. That refusal was wrong. The patch
 * engine has patched positional arguments all along (`positionalEdits`, plan.ts
 * §"argument fields"); the graph simply said `argumentsEditable: false` and the
 * UI, correctly, believed it.
 *
 * So the graph now says which of three things a call is, rather than leaving a
 * boolean to be interpreted:
 *
 *   object      one visible object literal — a tool's argument
 *   positional  a parameter list lined up with the registered inputSchema
 *   opaque      a spread, a variable standing in for the whole object, an
 *               arity that does not match the schema, a callee nothing names
 *
 * The two refusals that were already right are asserted here too, because they
 * are what makes the new permission safe: removing a positional argument shifts
 * every argument after it, and the scope check runs on a positional value
 * exactly as it does on an object-literal field.
 */

import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/analyzer/index.js";
import { createCodeFlow } from "../src/session.js";
import { CodeFlowError } from "../src/errors.js";
import { createSampleRegistry } from "./fixtures.js";
import type { Registry } from "../src/registry/index.js";
import type { WorkflowGraph, WorkflowNode } from "../src/model/index.js";

const FILE = "flow.ts";
const LIB = "@flows/lib";

/**
 * The sample registry plus two library functions: one called positionally, one
 * declared `argumentStyle: "object"` — the two shapes 05 §4 allows.
 */
function registryWithSteps(): Registry {
  const registry = createSampleRegistry();
  registry.registerFunction({
    name: "imageGen",
    label: "Image Gen",
    argumentStyle: "object",
    inputSchema: { prompt: "string", variants: { type: "number" } },
    outputSchema: "string[]",
    code: `export async function imageGen(args: { prompt: string; variants: number }): Promise<string[]> {
  return [];
}`,
    modulePath: LIB,
  });
  registry.registerFunction({
    name: "limitRecords",
    label: "Limit",
    inputSchema: {
      records: "Record<string, unknown>[]",
      count: { type: "number" },
      keep: { type: "string", enum: ["first", "last"] },
    },
    outputSchema: "Record<string, unknown>[]",
    code: `export function limitRecords(records: Record<string, unknown>[], count: number, keep: string) {
  return keep === "last" ? records.slice(-count) : records.slice(0, count);
}`,
    modulePath: LIB,
    editableFields: ["records", "count", "keep"],
  });
  return registry;
}

const IMPORTS = `import { isAuthChange, limitRecords } from "@flows/lib";`;
const OBJECT_IMPORTS = `import { imageGen } from "@flows/lib";`;

function flowSource(body: string, imports = IMPORTS): string {
  return `import type { Tools } from "../generated/tools";
${imports}

export default async function flow(input: { repository: string }, tools: Tools) {
${body}
}
`;
}

function analyze(body: string, imports?: string): WorkflowGraph {
  return analyzeSource(flowSource(body, imports), registryWithSteps(), { file: FILE });
}

function node(graph: WorkflowGraph, path: string): WorkflowNode {
  const found = graph.nodes.find((candidate) => candidate.source.semanticPath === path);
  expect(found, `no node at ${path}`).toBeDefined();
  return found!;
}

async function open(body: string, imports?: string) {
  const source = flowSource(body, imports);
  const session = createCodeFlow({ registry: registryWithSteps() });
  const graph = await session.analyze(source, { file: FILE });
  return { session, graph, source };
}

async function refusal(promise: Promise<unknown>): Promise<CodeFlowError> {
  const caught = await promise.catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(CodeFlowError);
  return caught as CodeFlowError;
}

/* -------------------------------------------------------------------------- */
/* the three styles                                                            */
/* -------------------------------------------------------------------------- */

describe("argumentStyle", () => {
  it("is `object` for a tool called with an object literal", () => {
    const target = node(
      analyze(`  await tools.slack.send({ channel: "#eng", message: "hi" });`),
      "flow/call:slack.send[0]",
    );
    expect(target.data["argumentStyle"]).toBe("object");
    expect(target.data["argumentsEditable"]).toBe(true);
    expect(target.data["arguments"]).toEqual({ channel: '"#eng"', message: '"hi"' });
    // Positions belong to a parameter list; an object literal has none.
    expect(target.data["argumentPositions"]).toBeUndefined();
  });

  it("is `positional` for a library function whose arguments line up with its schema", () => {
    const target = node(
      analyze(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const top = limitRecords(prs, 10, "first");`),
      "flow/call:limitRecords[0]",
    );
    expect(target.data["argumentStyle"]).toBe("positional");
    expect(target.data["argumentsEditable"]).toBe(true);
    // Name → the argument's source text, exactly as an object literal's fields
    // are carried, so one UI path renders both.
    expect(target.data["arguments"]).toEqual({
      records: "prs",
      count: "10",
      keep: '"first"',
    });
    // …plus the position, which is the only thing a name does not say here.
    expect(target.data["argumentPositions"]).toEqual({ records: 0, count: 1, keep: 2 });
  });

  it("is `object` for a library function declared object-style", () => {
    // A library function may take one object argument instead of a parameter
    // list (05 §4). Then it is read exactly like a tool call: the keys of the
    // literal are the fields, and there are no positions to carry.
    const target = node(
      analyze(`  const heroes = await imageGen({ prompt: "x", variants: 3 });`, OBJECT_IMPORTS),
      "flow/call:imageGen[0]",
    );
    expect(target.data["argumentStyle"]).toBe("object");
    expect(target.data["argumentsEditable"]).toBe(true);
    expect(target.data["arguments"]).toEqual({ prompt: '"x"', variants: "3" });
    expect(target.data["argumentPositions"]).toBeUndefined();
  });

  it("is `opaque` when the argument is a bare variable standing in for the object", () => {
    const target = node(
      analyze(`  const payload = { channel: "#eng", message: "hi" };
  await tools.slack.send(payload);`),
      "flow/call:slack.send[0]",
    );
    expect(target.data["argumentStyle"]).toBe("opaque");
    expect(target.data["argumentsEditable"]).toBe(false);
    expect(target.data["arguments"]).toBeNull();
  });

  it("is `opaque` when a spread hides the arguments", () => {
    const graph = analyze(`  const parts = [{ channel: "#eng", message: "hi" }];
  await tools.slack.send(...parts);
  const rows = limitRecords(...parts);`);
    const tool = node(graph, "flow/call:slack.send[0]");
    expect(tool.data["argumentStyle"]).toBe("opaque");
    expect(tool.data["argumentsEditable"]).toBe(false);

    const fn = node(graph, "flow/call:limitRecords[0]");
    expect(fn.data["argumentStyle"]).toBe("opaque");
    expect(fn.data["argumentsEditable"]).toBe(false);
    expect(fn.data["argumentsHaveSpread"]).toBe(true);
  });

  it("is `opaque` when the arity does not match the schema", () => {
    // Two arguments against a three-field schema does not say which parameter
    // was skipped, and picking one would be a guess (I6). Writing the optional
    // argument out is what makes the call editable.
    const target = node(
      analyze(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const top = limitRecords(prs, 10);`),
      "flow/call:limitRecords[0]",
    );
    expect(target.data["argumentStyle"]).toBe("opaque");
    expect(target.data["argumentsEditable"]).toBe(false);
  });

  it("is `opaque` for a local function — nothing names its parameters", () => {
    // A local function has no registered input schema, so there is no
    // field → position bridge; `positionalEdits` refuses every field by name.
    // Saying "editable" here is the lie this defect was made of.
    const graph = analyzeSource(
      `import type { Tools } from "../generated/tools";

function collect(into: unknown[], record: unknown) {
  into.push(record);
}

export default async function flow(input: { repository: string }, tools: Tools) {
  const rows: unknown[] = [];
  collect(rows, { channel: "#eng" });
}
`,
      registryWithSteps(),
      { file: FILE },
    );
    const target = node(graph, "flow/call:collect[0]");
    expect(target.data["functionSource"]).toBe("local");
    expect(target.data["argumentStyle"]).toBe("opaque");
    expect(target.data["argumentsEditable"]).toBe(false);
  });

  it("marks a positional `undefined` as a placeholder, like an object field", () => {
    // What the palette writes for an input it has no value for (06 §2). Before
    // this, an inserted library function came up looking configured.
    const target = node(
      analyze(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const top = limitRecords(prs, undefined, "first");`),
      "flow/call:limitRecords[0]",
    );
    expect(target.data["needsConfiguration"]).toBe(true);
    expect(target.data["placeholders"]).toEqual(["count"]);
  });
});

/* -------------------------------------------------------------------------- */
/* patching what the style promises                                            */
/* -------------------------------------------------------------------------- */

describe("editing a positional field", () => {
  const BODY = `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const top = limitRecords(prs, 10, "first");
  await tools.slack.send({ channel: "#eng", message: "done" });`;

  it("patches exactly the one argument", async () => {
    const { session, graph, source } = await open(BODY);
    const target = node(graph, "flow/call:limitRecords[0]");
    const result = await session.patchNode(target.id, { count: 25 });

    expect(result.source).toContain("limitRecords(prs, 25, \"first\")");
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].oldText).toBe("10");
    expect(result.patches[0].newText).toBe("25");
    // Everything outside that one range is byte-identical (I3).
    const start = result.patches[0].range.start.offset;
    const end = result.patches[0].range.end.offset;
    expect(result.source.slice(0, start)).toBe(source.slice(0, start));
    expect(result.source.slice(start + 2)).toBe(source.slice(end));
  });

  it("re-analyzes to the same node with the new value", async () => {
    const { session, graph } = await open(BODY);
    const target = node(graph, "flow/call:limitRecords[0]");
    const result = await session.patchNode(target.id, { count: 25 });
    const after = node(result.graph, "flow/call:limitRecords[0]");
    expect(after.id).toBe(target.id);
    expect(after.data["argumentStyle"]).toBe("positional");
    expect(after.data["arguments"]).toEqual({ records: "prs", count: "25", keep: '"first"' });
  });

  it("runs the scope check on a positional argument, exactly as on a field", async () => {
    const { session, graph } = await open(BODY);
    const target = node(graph, "flow/call:limitRecords[0]");
    const error = await refusal(
      session.patchNode(target.id, { records: { kind: "expression", text: "pullRequests" } }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("`pullRequests` is not available here");
    // …and a name that IS bound goes through.
    const ok = await session.patchNode(target.id, {
      records: { kind: "expression", text: "prs" },
    });
    expect(ok.source).toContain("limitRecords(prs, 10, \"first\")");
  });

  it("refuses to remove a positional argument, and says why", async () => {
    // Already correct, asserted so it stays that way: removing argument 2 of 3
    // silently turns argument 3 into argument 2.
    const { session, graph } = await open(BODY);
    const target = node(graph, "flow/call:limitRecords[0]");
    const error = await refusal(session.patchNode(target.id, { count: { kind: "remove" } }));
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("shift every argument after it");
  });

  it("refuses a field the schema does not name", async () => {
    const { session, graph } = await open(BODY);
    const target = node(graph, "flow/call:limitRecords[0]");
    const error = await refusal(session.patchNode(target.id, { nope: 1 }));
    expect(error.code).toBe("patch-not-editable");
  });
});

/* -------------------------------------------------------------------------- */
/* writing an object-style function                                            */
/* -------------------------------------------------------------------------- */

describe("an object-style function call", () => {
  const BODY = `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#eng", message: "done" });`;

  it("is inserted as one object literal, with the import it needs", async () => {
    const { session, graph } = await open(BODY);
    const anchor = node(graph, "flow/call:github.getNewPRs[0]");
    const result = await session.patchNode(anchor.id, {
      $insert: { function: "imageGen", arguments: { prompt: "hero" }, await: true },
    });
    // Named fields, not `imageGen("hero", undefined)` — and the field with no
    // value is the same explicit placeholder a tool insert writes (06 §2).
    expect(result.source).toMatch(/await imageGen\(\{ prompt: "hero", variants: undefined \}\);/);
    expect(result.source).toMatch(/import \{[^}]*\bimageGen\b[^}]*\} from "@flows\/lib"/);
    expect(result.diagnostics.map((d) => d.code)).toContain("needs-configuration");
    const inserted = node(result.graph, "flow/call:imageGen[0]");
    expect(inserted.data["argumentStyle"]).toBe("object");
    expect(inserted.data["placeholders"]).toEqual(["variants"]);
  });

  it("is patched by editing the property, not the position", async () => {
    const { session, graph, source } = await open(
      `  const heroes = await imageGen({ prompt: "x", variants: 3 });`,
      OBJECT_IMPORTS,
    );
    const target = node(graph, "flow/call:imageGen[0]");
    const result = await session.patchNode(target.id, { variants: { kind: "literal", value: 6 } });

    expect(result.source).toContain("imageGen({ prompt: \"x\", variants: 6 })");
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].oldText).toBe("3");
    expect(result.patches[0].newText).toBe("6");
    // Everything outside that one range is byte-identical (I3).
    const start = result.patches[0].range.start.offset;
    const end = result.patches[0].range.end.offset;
    expect(result.source.slice(0, start)).toBe(source.slice(0, start));
    expect(result.source.slice(start + 1)).toBe(source.slice(end));
  });

  it("adds a field the call left out, which a positional function cannot do", async () => {
    // The refusal positional arguments have to make — appending would shift
    // every later argument — does not apply to a named property.
    const { session, graph } = await open(
      `  const heroes = await imageGen({ prompt: "x" });`,
      OBJECT_IMPORTS,
    );
    const target = node(graph, "flow/call:imageGen[0]");
    const result = await session.patchNode(target.id, { variants: 4 });
    expect(result.source).toContain("imageGen({ prompt: \"x\", variants: 4 })");
  });
});
