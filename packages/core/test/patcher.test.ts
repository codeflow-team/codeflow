/**
 * Patch engine unit tests — 06-patch-engine.md.
 *
 * The fixture corpus covers the happy paths character by character; this file
 * covers the rules that have to hold *around* them: what the engine refuses,
 * what it says when it refuses, and that a refusal never leaves a half-written
 * source behind.
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow } from "../src/session.js";
import { createRegistry } from "../src/registry/index.js";
import { CodeFlowError } from "../src/errors.js";
import { suggestVariableName } from "../src/patcher/index.js";
import { renderStringLiteral } from "../src/patcher/values.js";
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

/* -------------------------------------------------------------------------- */
/* 06 §1 — when a field is editable at all                                     */
/* -------------------------------------------------------------------------- */

describe("editable fields (06 §1)", () => {
  it("refuses to edit a call whose argument is a variable — no guessing", async () => {
    const { session, graph } = await open(
      flowSource(`  const payload = { channel: "#a", message: "b" };
  await tools.slack.send(payload);`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, { channel: "#b" }),
    );
    expect(error.code).toBe("patch-not-editable");
    expect(error.message).toContain("code view");
  });

  it("edits a property written after a spread", async () => {
    const { session, graph, source } = await open(
      flowSource(`  const defaults = { message: "b" };
  await tools.slack.send({ ...defaults, channel: "#security" });`),
    );
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      channel: "#engineering",
    });
    expect(result.source).toBe(source.replace('"#security"', '"#engineering"'));
  });

  it("refuses a property written before a spread — its value is not visible", async () => {
    const { session, graph } = await open(
      flowSource(`  const defaults = { channel: "#b" };
  await tools.slack.send({ channel: "#security", ...defaults });`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, { channel: "#engineering" }),
    );
    expect(error.code).toBe("patch-not-editable");
    expect(error.message).toContain("spread");
  });

  it("never adds a property after a spread to override an invisible value", async () => {
    const { session, graph } = await open(
      flowSource(`  const defaults = { channel: "#b" };
  await tools.slack.send({ ...defaults });`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, { message: "hi" }),
    );
    expect(error.code).toBe("patch-not-editable");
    expect(error.message).toContain("not visible in the source");
  });

  it("refuses a field the definition does not declare editable", async () => {
    const registry = createRegistry();
    registry.registerTool({
      name: "slack.send",
      label: "Slack Send",
      inputSchema: { channel: "string", message: "string" },
      editableFields: ["message"],
    });
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`),
      registry,
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, { channel: "#b" }),
    );
    expect(error.code).toBe("patch-not-editable");
    expect(error.message).toContain("editable fields are message");
  });

  it("refuses to add a property that is not in the input schema", async () => {
    const registry = createRegistry();
    registry.registerTool({
      name: "slack.send",
      label: "Slack Send",
      inputSchema: { channel: "string", message: "string" },
    });
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`),
      registry,
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, { $set: { threadId: "x" } }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("input schema");
  });
});

/* -------------------------------------------------------------------------- */
/* 06 §3 — values are patched relative to the AST form they replace            */
/* -------------------------------------------------------------------------- */

describe("expressions and literal forms (06 §3)", () => {
  it("keeps a string literal a string literal, even when the text contains ${", async () => {
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "plain" });`),
    );
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      message: "cost: ${amount}",
    });
    expect(result.source).toContain('message: "cost: ${amount}"');
  });

  it("changes the kind only when the edit says so explicitly", async () => {
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "plain" });`),
    );
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      message: { kind: "template", text: "PR ${input.repository}" },
    });
    expect(result.source).toContain("message: `PR ${input.repository}`");
  });

  it("refuses a bare string for a field that currently holds an expression", async () => {
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: input.repository, message: "b" });`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, { channel: "#a" }),
    );
    expect(error.code).toBe("patch-not-editable");
    expect(error.message).toContain("kind");
  });

  it("keeps an expression an expression when asked explicitly", async () => {
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: input.repository, message: "b" });`),
    );
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      channel: { kind: "expression", text: "input.repository.toLowerCase()" },
    });
    expect(result.source).toContain("channel: input.repository.toLowerCase()");
  });

  it("writes typed literals for typed values", async () => {
    const registry = createRegistry();
    registry.registerTool({
      name: "slack.send",
      label: "Slack Send",
      inputSchema: { channel: "string", message: "string", urgent: "boolean", retries: "number" },
    });
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`),
      registry,
    );
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      urgent: true,
      retries: 3,
    });
    expect(result.source).toContain('{ channel: "#a", message: "b", urgent: true, retries: 3 }');
  });

  it("escapes what has to be escaped and nothing else", () => {
    expect(renderStringLiteral('say "hi"', '"')).toBe('"say \\"hi\\""');
    expect(renderStringLiteral('say "hi"', "'")).toBe("'say \"hi\"'");
    expect(renderStringLiteral("a\\b", '"')).toBe('"a\\\\b"');
    expect(renderStringLiteral("line\nbreak", '"')).toBe('"line\\nbreak"');
    expect(renderStringLiteral("안전 🔒 ${x}", '"')).toBe('"안전 🔒 ${x}"');
  });
});

/* -------------------------------------------------------------------------- */
/* 06 §2 — scope of supported edits                                            */
/* -------------------------------------------------------------------------- */

describe("supported edit scope (06 §2)", () => {
  it("names unknown operations instead of ignoring them", async () => {
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, { $move: "up" }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("$move");
  });

  it("refuses to combine a whole-statement operation with anything else", async () => {
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, { $delete: true, channel: "#b" }),
    );
    expect(error.code).toBe("patch-unsupported");
  });

  it("refuses to delete a synthetic node", async () => {
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`),
    );
    const error = await refusal(session.patchNode(node(graph, "flow#trigger").id, { $delete: true }));
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("synthetic");
  });

  it("names every node that blocks a delete", async () => {
    const { session, graph } = await open(
      flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const files = await tools.github.getFiles({ pr: prs[0] });
  await tools.slack.send({ channel: "#a", message: String(files.length) });`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:github.getFiles[0]").id, { $delete: true }),
    );
    expect(error.code).toBe("patch-dependency");
    expect(error.message).toContain("Slack Send");
    expect(error.message).toContain("files");
  });

  it("refuses to change the tool of a call reached through an alias", async () => {
    const { session, graph } = await open(
      flowSource(`  const gh = tools.github;
  const prs = await gh.getNewPRs({ repo: input.repository });`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:github.getNewPRs[0]").id, {
        $tool: "github.getFiles",
      }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("alias");
  });

  it("refuses to change to a tool that is not registered", async () => {
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, { $tool: "slack.shout" }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(error.message).toContain("not in the registry");
  });

  it("refuses a condition edit on a node that has no condition", async () => {
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, { $condition: "true" }),
    );
    expect(error.code).toBe("patch-unsupported");
  });
});

/* -------------------------------------------------------------------------- */
/* palette insert — 06 §2                                                      */
/* -------------------------------------------------------------------------- */

describe("palette insert (06 §2)", () => {
  it("adds the import of a library function that is not imported yet", async () => {
    const { session, graph } = await open(
      flowSource(`  const files = await tools.github.getFiles({ pr: input.repository });`),
    );
    const result = await session.patchNode(node(graph, "flow/call:github.getFiles[0]").id, {
      $insert: {
        function: "isAuthChange",
        where: "after",
        arguments: { files: { kind: "expression", text: "files" } },
      },
    });
    expect(result.source).toContain('import { isAuthChange } from "@flows/lib";');
    expect(result.source.match(/@flows\/lib/g)?.length).toBe(1);
    expect(result.source).toContain("const isAuthChange2 = isAuthChange(files);");
  });

  it("adds a specifier to an existing import of the same module", async () => {
    const registry = createSampleRegistry();
    registry.registerFunction({
      name: "isDraft",
      label: "Is Draft",
      inputSchema: { pr: "PullRequest" },
      outputSchema: "boolean",
      code: "export function isDraft(pr: PullRequest) { return pr.draft; }",
      modulePath: "@flows/lib",
    });
    const { session, graph } = await open(
      flowSource(
        `  const files = await tools.github.getFiles({ pr: input.repository });`,
        `import { isAuthChange } from "@flows/lib";`,
      ),
      registry,
    );
    const result = await session.patchNode(node(graph, "flow/call:github.getFiles[0]").id, {
      $insert: {
        function: "isDraft",
        where: "after",
        variable: "draft",
        arguments: { pr: { kind: "expression", text: "input.repository" } },
      },
    });
    expect(result.source).toContain('import { isAuthChange, isDraft } from "@flows/lib";');
    expect(result.source).toContain("const draft = isDraft(input.repository);");
  });

  it("appends at the end of the flow when the trigger is the anchor", async () => {
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`),
    );
    const result = await session.patchNode(node(graph, "flow#trigger").id, {
      $insert: {
        tool: "slack.send",
        where: "append",
        arguments: { channel: "#last", message: "done" },
      },
    });
    expect(result.source).toBe(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });
  await tools.slack.send({ channel: "#last", message: "done" });`),
    );
  });

  it("names the binding after the tool, with a numeric suffix when taken", () => {
    expect(suggestVariableName("github.getFiles", new Set())).toBe("files");
    expect(suggestVariableName("github.getFiles", new Set(["files"]))).toBe("files2");
    expect(suggestVariableName("github.getFiles", new Set(["files", "files2"]))).toBe("files3");
    expect(suggestVariableName("slack.send", new Set())).toBe("send");
    expect(suggestVariableName("isAuthChange", new Set())).toBe("isAuthChange");
  });

  it("refuses to insert a tool that is not registered", async () => {
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`),
    );
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
        $insert: { tool: "slack.shout", where: "after" },
      }),
    );
    expect(error.code).toBe("patch-unsupported");
  });
});

/* -------------------------------------------------------------------------- */
/* transactionality — 06 §4                                                    */
/* -------------------------------------------------------------------------- */

describe("transactionality (06 §4)", () => {
  it("aborts when the candidate would not parse, leaving the source untouched", async () => {
    const source = flowSource(`  const total = items.reduce((a, b) => a + b, 0);
  await tools.slack.send({ channel: "#a", message: String(total) });`);
    const { session, graph } = await open(source);
    const error = await refusal(
      session.patchNode(node(graph, "flow/stmt[0]").id, { $code: "const total = (;" }),
    );
    expect(error.code).toBe("patch-invalid");
    expect(error.message).toContain("would not parse");
    expect(session.getGraph()!.source.content).toBe(source);
    expect(session.getGraph()).toBe(graph);
  });

  it("aborts when the candidate would break the flow contract", async () => {
    const source = flowSource(`  const total = 1 + 1;
  await tools.slack.send({ channel: "#a", message: String(total) });`);
    const { session, graph } = await open(source);
    const error = await refusal(
      session.patchNode(node(graph, "flow/stmt[0]").id, {
        $code: "} function stray() {} async function flow2() {",
      }),
    );
    expect(["patch-invalid"]).toContain(error.code);
    expect(session.getGraph()!.source.content).toBe(source);
  });

  it("reports the patched ranges as non-overlapping text patches", async () => {
    const source = flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`);
    const { session, graph } = await open(source);
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      channel: "#c",
      message: "d",
    });
    expect(result.patches).toHaveLength(2);
    expect(result.patches[0].range.start.offset).toBeLessThan(result.patches[1].range.start.offset);
    expect(result.patches[0].range.end.offset).toBeLessThanOrEqual(
      result.patches[1].range.start.offset,
    );
    expect(result.patches.map((patch) => patch.oldText)).toEqual(['"#a"', '"b"']);
    expect(result.patches.map((patch) => patch.newText)).toEqual(['"#c"', '"d"']);
  });
});

/* -------------------------------------------------------------------------- */
/* formatting fidelity — 06 §4                                                 */
/* -------------------------------------------------------------------------- */

describe("formatting fidelity (06 §4)", () => {
  const one = (body: string) => flowSource(`  ${body}`);

  it("removes a property from a single-line literal with exactly one separator", async () => {
    const { session, graph } = await open(
      one(`await tools.slack.send({ channel: "#a", message: "b" });`),
    );
    const first = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      message: { kind: "remove" },
    });
    expect(first.source).toBe(one(`await tools.slack.send({ channel: "#a" });`));

    const { session: second, graph: graph2 } = await open(
      one(`await tools.slack.send({ channel: "#a", message: "b" });`),
    );
    const other = await second.patchNode(node(graph2, "flow/call:slack.send[0]").id, {
      channel: { kind: "remove" },
    });
    expect(other.source).toBe(one(`await tools.slack.send({ message: "b" });`));
  });

  it("takes the neighbouring comma when the literal itself has no trailing comma", async () => {
    // The file's other literal uses a trailing comma; this one does not. The
    // literal being edited decides, not the file's average.
    const source = flowSource(`  const prs = await tools.github.getNewPRs({
    repo: input.repository,
  });
  await tools.slack.send({
    channel: "#a",
    message: "b"
  });`);
    const { session, graph } = await open(source);
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      message: { kind: "remove" },
    });
    expect(result.source).toBe(
      flowSource(`  const prs = await tools.github.getNewPRs({
    repo: input.repository,
  });
  await tools.slack.send({
    channel: "#a"
  });`),
    );
  });

  it("fills an empty literal without leaving stray whitespace", async () => {
    const { session, graph } = await open(one(`await tools.slack.send({});`));
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      channel: "#a",
    });
    expect(result.source).toBe(one(`await tools.slack.send({ channel: "#a" });`));
  });

  it("deletes a statement that shares its line without shifting its neighbour", async () => {
    const { session, graph } = await open(
      one(`await tools.slack.send({ channel: "#a", message: "b" }); await tools.slack.send({ channel: "#c", message: "d" });`),
    );
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      $delete: true,
    });
    expect(result.source).toBe(one(`await tools.slack.send({ channel: "#c", message: "d" });`));
  });

  it("keeps CRLF line endings when inserting a line", async () => {
    const source = one(`await tools.slack.send({ channel: "#a", message: "b" });`).replace(
      /\n/g,
      "\r\n",
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      $insert: { tool: "slack.send", where: "after", arguments: { channel: "#z", message: "z" } },
    });
    expect(result.source).toContain('\r\n  await tools.slack.send({ channel: "#z", message: "z" });\r\n');
    expect(result.source.includes("\n  await tools.slack.send({ channel: \"#z\"")).toBe(true);
    expect(/[^\r]\n/.test(result.source)).toBe(false);
  });

  it("follows a file that writes no semicolons", async () => {
    const source = `import type { Tools } from "../generated/tools"

export default async function flow(input: { repository: string }, tools: Tools) {
  await tools.slack.send({ channel: "#a", message: "b" })
}
`;
    const { session, graph } = await open(source);
    const result = await session.patchNode(node(graph, "flow/call:slack.send[0]").id, {
      $insert: { tool: "slack.send", where: "after", arguments: { channel: "#z", message: "z" } },
    });
    expect(result.source).toContain('  await tools.slack.send({ channel: "#z", message: "z" })\n');
    expect(result.source).not.toContain('"z" });');
  });
});

/* -------------------------------------------------------------------------- */
/* conflict detection — 06 §5                                                  */
/* -------------------------------------------------------------------------- */

describe("conflict detection (06 §5)", () => {
  it("refuses to patch against a registry that has moved", async () => {
    const registry = createSampleRegistry();
    const { session, graph } = await open(
      flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`),
      registry,
    );
    registry.registerTool({
      name: "slack.shout",
      label: "Slack Shout",
      inputSchema: { channel: "string" },
    });
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, { channel: "#b" }),
    );
    expect(error.code).toBe("patch-conflict");
    expect(error.message).toContain("registry changed");
  });

  it("refuses when the node's own text changed outside CodeFlow", async () => {
    const source = flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`);
    const { session, graph } = await open(source);
    const edited = source.replace('message: "b"', 'message: "edited by someone else"');
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, { channel: "#b" }, { source: edited }),
    );
    expect(error.code).toBe("patch-conflict");
    expect(error.message).toContain("reload");
  });

  it("refuses when only a comment inside the node's region changed (raw text, not fingerprint)", async () => {
    const source = flowSource(`  await tools.slack.send({
    channel: "#a",
    message: "b"
  });`);
    const { session, graph } = await open(source);
    const edited = source.replace('channel: "#a",', 'channel: "#a", // keep this');
    const error = await refusal(
      session.patchNode(node(graph, "flow/call:slack.send[0]").id, { channel: "#b" }, { source: edited }),
    );
    expect(error.code).toBe("patch-conflict");
  });

  it("re-analyzes and patches when the change was elsewhere in the file", async () => {
    const source = flowSource(`  await tools.slack.send({ channel: "#a", message: "b" });`);
    const { session, graph } = await open(source);
    const edited = source.replace(
      "export default async function flow",
      "// an unrelated comment\nexport default async function flow",
    );
    const result = await session.patchNode(
      node(graph, "flow/call:slack.send[0]").id,
      { channel: "#b" },
      { source: edited },
    );
    expect(result.source).toBe(edited.replace('"#a"', '"#b"'));
    // The node kept its identity across the outside change and the patch.
    expect(result.graph.nodes.map((candidate) => candidate.id)).toContain(
      node(graph, "flow/call:slack.send[0]").id,
    );
  });
});
