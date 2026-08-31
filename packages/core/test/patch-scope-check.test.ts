/**
 * Refusing an expression that references a name nothing binds here — I6 for
 * the drag gesture (03 §6, 06 §3, `patcher/scope-check.ts`).
 *
 * Dragging a value from the inspector's data pane into a field is an ordinary
 * field patch writing a TypeScript expression. Written verbatim, a mis-drag
 * produces code that parses, analyzes and type-checks nowhere in the browser —
 * and fails at run time with `pr is not defined` while the node looks
 * configured. Every case below is that failure, refused by name.
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow } from "../src/session.js";
import { CodeFlowError } from "../src/errors.js";
import { rootReferences, ALLOWED_GLOBALS } from "../src/patcher/scope-check.js";
import { createSampleRegistry } from "./fixtures.js";
import type { WorkflowGraph, WorkflowNode } from "../src/model/index.js";

const FILE = "flow.ts";

function flowSource(body: string, imports = ""): string {
  return `import type { Tools } from "../generated/tools";
${imports}
export default async function flow(input: { repository: string }, tools: Tools) {
${body}
}
`;
}

async function open(source: string, registry = createSampleRegistry()) {
  const session = createCodeFlow({ registry });
  const graph = await session.analyze(source, { file: FILE });
  return { session, graph, source };
}

function node(graph: WorkflowGraph, path: string): WorkflowNode {
  const found = graph.nodes.find((candidate) => candidate.source.semanticPath === path);
  expect(found, `no node at ${path}`).toBeDefined();
  return found!;
}

async function refusal(promise: Promise<unknown>): Promise<CodeFlowError> {
  const caught = await promise.catch((error: unknown) => error);
  expect(caught).toBeInstanceOf(CodeFlowError);
  return caught as CodeFlowError;
}

/** The flow the drag cases use: a loop with a `pr` item and a `files` output. */
const LOOP_FLOW = flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#before", message: "starting" });
  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr });
    await tools.slack.send({ channel: "#inside", message: "b" });
  }`);

/* -------------------------------------------------------------------------- */
/* the drag                                                                    */
/* -------------------------------------------------------------------------- */

describe("dragging a value into a field", () => {
  it("writes `pr.title` into a node inside the loop", async () => {
    const { session, graph, source } = await open(LOOP_FLOW);
    const result = await session.patchNode(node(graph, "flow/for[0]/call:slack.send[0]").id, {
      message: { kind: "expression", text: "pr.title" },
    });
    expect(result.source).toBe(source.replace('message: "b"', "message: pr.title"));
  });

  it("refuses the same drag onto a node before the loop, naming `pr`", async () => {
    const { session, graph } = await open(LOOP_FLOW);
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
        message: { kind: "expression", text: "pr.title" },
      }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("`pr` is not available here");
    // The message names what IS available, in the style of the other refusals.
    expect(error.message).toContain("values in scope at this step: input, prs");
    // …and only what is worth offering. `tools` is in scope and referencing it
    // is legal, but it is not a value, and a message answering "what can I put
    // here?" with `tools` points a non-developer at nonsense.
    expect(error.message).not.toContain("tools");
  });

  it("leaves the source byte-identical when it refuses", async () => {
    const { session, graph, source } = await open(LOOP_FLOW);
    await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
        message: { kind: "expression", text: "pr.title" },
      }),
    );
    expect(session.getGraph()?.source.content).toBe(source);
  });

  it("refuses a binding that is only declared further down", async () => {
    const { session, graph } = await open(LOOP_FLOW);
    // `files` exists inside the loop body, after this node.
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
        message: { kind: "expression", text: "files.length" },
      }),
    );
    expect(error.message).toContain("`files` is not available here");
  });

  it("refuses a reference to the node's own output binding", async () => {
    const { session, graph } = await open(
      flowSource(`  const files = await tools.github.getFiles({ pr: input.repository });`),
    );
    // `const files = await tools.github.getFiles({ pr: files })` is a TDZ error
    // at run time; the node writes `files`, it cannot read it.
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:github.getFiles[0]").id, {
        pr: { kind: "expression", text: "files[0]" },
      }),
    );
    expect(error.message).toContain("`files` is not available here");
  });
});

/* -------------------------------------------------------------------------- */
/* what is NOT an outside reference                                            */
/* -------------------------------------------------------------------------- */

describe("references the check must not flag", () => {
  const flow = flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const files = await tools.github.getFiles({ pr: prs });
  await tools.slack.send({ channel: "#a", message: "b" });`);

  it("accepts an arrow parameter bound inside the expression", async () => {
    const { session, graph, source } = await open(flow);
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      message: { kind: "expression", text: "files.filter(f => f.name)" },
    });
    expect(result.source).toBe(
      source.replace('message: "b"', "message: files.filter(f => f.name)"),
    );
  });

  it("accepts a destructured arrow parameter", async () => {
    const { session, graph } = await open(flow);
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      message: { kind: "expression", text: "files.map(({ path, size }) => path + size)" },
    });
    expect(result.source).toContain("files.map(({ path, size }) => path + size)");
  });

  it("accepts a `const` declared in an arrow's own body", async () => {
    const { session, graph } = await open(flow);
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      message: {
        kind: "expression",
        text: "files.map((entry) => { const label = entry.path; return label; })",
      },
    });
    expect(result.source).toContain("const label = entry.path");
  });

  it("accepts an allow-listed global", async () => {
    const { session, graph } = await open(flow);
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      message: { kind: "expression", text: "Math.max(files.length, prs.length)" },
    });
    expect(result.source).toContain("message: Math.max(files.length, prs.length)");
  });

  it("refuses an unbound name inside an allow-listed call", async () => {
    const { session, graph } = await open(flow);
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
        message: { kind: "expression", text: "Math.max(nope, 1)" },
      }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("`nope` is not available here");
    expect(error.message).not.toContain("`Math` is not available");
  });

  it("does not treat a property name or an object key as a reference", async () => {
    const { session, graph } = await open(flow);
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      message: { kind: "expression", text: "JSON.stringify({ nope: files.length, deep: prs })" },
    });
    expect(result.source).toContain("{ nope: files.length, deep: prs }");
  });

  it("keeps the allow-list small and explicit", () => {
    // A guard on the list itself: growing it is a deliberate act, not a drive-by.
    expect(ALLOWED_GLOBALS).toEqual([
      "Math",
      "JSON",
      "Object",
      "Array",
      "String",
      "Number",
      "Boolean",
      "Date",
      "Promise",
      "Set",
      "Map",
      "RegExp",
      "NaN",
      "Infinity",
      "undefined",
      "null",
      "true",
      "false",
      "console",
    ]);
    expect(ALLOWED_GLOBALS).not.toContain("fetch");
    expect(ALLOWED_GLOBALS).not.toContain("process");
  });
});

/* -------------------------------------------------------------------------- */
/* templates — 06 §3                                                           */
/* -------------------------------------------------------------------------- */

describe("templates", () => {
  it("refuses a template whose interpolation is not in scope", async () => {
    const { session, graph } = await open(LOOP_FLOW);
    const error = await refusal(
      session.patchNode(node(graph, "flow/for[0]/call:slack.send[0]").id, {
        message: { kind: "template", text: "${pr.title} in ${nope}" },
      }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("`nope` is not available here");
    expect(error.message).toContain("pr");
  });

  it("accepts a template whose interpolations are all in scope", async () => {
    const { session, graph } = await open(LOOP_FLOW);
    const result = await session.patchNode(node(graph, "flow/for[0]/call:slack.send[0]").id, {
      message: { kind: "template", text: "${pr.title} has ${files.length} files" },
    });
    expect(result.source).toContain("message: `${pr.title} has ${files.length} files`");
  });

  it("checks a bare string written against a field that already holds a template", async () => {
    const { session, graph } = await open(
      flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#a", message: \`PRs: \${prs.length}\` });`),
    );
    // A bare string against a template field is the template *body* (06 §3), so
    // its interpolations are references like any other.
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
        message: "PRs: ${nope.length}",
      }),
    );
    expect(error.message).toContain("`nope` is not available here");
  });

  it("does not touch a plain string literal", async () => {
    const { session, graph, source } = await open(LOOP_FLOW);
    // `${nope}` inside a string literal is four characters, not an expression.
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      message: "hello ${nope}",
    });
    expect(result.source).toBe(source.replace('"starting"', '"hello ${nope}"'));
  });
});

/* -------------------------------------------------------------------------- */
/* the other paths that write an expression                                    */
/* -------------------------------------------------------------------------- */

describe("$condition, $iterable and $insert", () => {
  const flow = flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  if (prs.length > 0) {
    await tools.slack.send({ channel: "#a", message: "b" });
  }
  for (const pr of prs) {
    await tools.slack.send({ channel: "#c", message: "d" });
  }`);

  it("refuses an out-of-scope `$condition`", async () => {
    const { session, graph, source } = await open(flow);
    const error = await refusal(
      session.patchNode(node(graph, "flow/if[0]").id, { $condition: "nope.length > 0" }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("`nope` is not available here");
    expect(session.getGraph()?.source.content).toBe(source);
  });

  it("accepts an in-scope `$condition`", async () => {
    const { session, graph } = await open(flow);
    const result = await session.patchNode(node(graph, "flow/if[0]").id, {
      $condition: "prs.length > 1",
    });
    expect(result.source).toContain("if (prs.length > 1)");
  });

  it("refuses an out-of-scope `$iterable`", async () => {
    const { session, graph } = await open(flow);
    const error = await refusal(
      session.patchNode(node(graph, "flow/for[0]").id, { $iterable: "nope" }),
    );
    expect(error.message).toContain("`nope` is not available here");
  });

  it("refuses the loop's own item variable as its iterable", async () => {
    const { session, graph } = await open(flow);
    // `for (const pr of pr)` — the item is not in scope in the iterable.
    const error = await refusal(
      session.patchNode(node(graph, "flow/for[0]").id, { $iterable: "pr" }),
    );
    expect(error.message).toContain("`pr` is not available here");
  });

  it("refuses an inserted call whose argument is not in scope", async () => {
    const { session, graph, source } = await open(flow);
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:github.getNewPRs[0]").id, {
        $insert: {
          tool: "slack.send",
          where: "after",
          arguments: { channel: "#x", message: { kind: "expression", text: "nope.title" } },
        },
      }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("`nope` is not available here");
    expect(session.getGraph()?.source.content).toBe(source);
  });

  it("accepts an insert that references what the anchor node just produced", async () => {
    const { session, graph } = await open(flow);
    // Inserted *after* `const prs = …`, so `prs` is in scope at that point even
    // though it is not in scope *at* the anchor node itself.
    const result = await session.patchNode(node(graph, "flow/call:github.getNewPRs[0]").id, {
      $insert: {
        tool: "slack.send",
        where: "after",
        arguments: { channel: "#x", message: { kind: "expression", text: "prs.length" } },
      },
    });
    expect(result.source).toContain("message: prs.length");
  });

  it("refuses that same reference when inserting BEFORE the node that produces it", async () => {
    const { session, graph } = await open(flow);
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:github.getNewPRs[0]").id, {
        $insert: {
          tool: "slack.send",
          where: "before",
          arguments: { channel: "#x", message: { kind: "expression", text: "prs.length" } },
        },
      }),
    );
    expect(error.message).toContain("`prs` is not available here");
  });

  it("accepts an append into a loop body that uses the loop item", async () => {
    const { session, graph } = await open(flow);
    const result = await session.patchNode(node(graph, "flow/for[0]").id, {
      $insert: {
        tool: "slack.send",
        where: "append",
        arguments: { channel: "#x", message: { kind: "expression", text: "pr.title" } },
      },
    });
    expect(result.source).toContain("message: pr.title");
  });

  it("accepts an append at the end of the flow that uses a top-level binding", async () => {
    const { session, graph } = await open(flow);
    const result = await session.patchNode(node(graph, "flow#trigger").id, {
      $insert: {
        tool: "slack.send",
        where: "append",
        arguments: { channel: "#x", message: { kind: "expression", text: "prs.length" } },
      },
    });
    expect(result.source).toContain("message: prs.length");
  });
});

/* -------------------------------------------------------------------------- */
/* the reference extractor itself                                              */
/* -------------------------------------------------------------------------- */

describe("rootReferences", () => {
  it("takes the root of a property chain, not the properties", () => {
    expect(rootReferences("pr.title")).toEqual(["pr"]);
    expect(rootReferences("a.b.c.d")).toEqual(["a"]);
    expect(rootReferences("a[b].c")).toEqual(["a", "b"]);
  });

  it("reads a shorthand property but not a key", () => {
    expect(rootReferences("({ a: 1, b: c, pr })")).toEqual(["c", "pr"]);
  });

  it("ignores names bound inside the expression", () => {
    expect(rootReferences("files.filter(f => f.name)")).toEqual(["files"]);
    expect(rootReferences("xs.map(({ a }, i) => a + i + outer)")).toEqual(["xs", "outer"]);
    expect(rootReferences("(function self(n) { return self(n - 1); })(k)")).toEqual(["k"]);
  });

  it("ignores type positions", () => {
    expect(rootReferences("pr as PullRequest")).toEqual(["pr"]);
  });

  it("reads the interpolations of a template body", () => {
    expect(rootReferences("${pr.title} in ${nope}", "template")).toEqual(["pr", "nope"]);
    expect(rootReferences("no interpolation here", "template")).toEqual([]);
  });

  it("returns nothing for a snippet that does not parse", () => {
    // The candidate validation of 06 §4 refuses it a moment later, with a
    // message about the syntax rather than a made-up one about scope.
    expect(rootReferences("pr.")).toEqual([]);
    expect(rootReferences("((")).toEqual([]);
  });
});

/**
 * The check is permissive where the *message* is opinionated: a reference the
 * suggestion list does not advertise is still perfectly legal to write.
 */
describe("what is legal vs what is offered", () => {
  it("accepts a reference to `tools` even though the message never offers it", async () => {
    const { session, graph } = await open(LOOP_FLOW);
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      message: { kind: "expression", text: "typeof tools" },
    });
    expect(result.source).toContain("message: typeof tools");
  });
});
