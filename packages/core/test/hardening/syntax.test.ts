/**
 * Syntax the analyzer and the patch engine both have to survive.
 *
 * The theme: a call can be *spelled* many ways that mean the same thing, and a
 * key can be spelled many ways that bind the same property. Every one of those
 * spellings is a chance to either (a) miss the thing and degrade — fine, I6 —
 * or (b) half-recognise it and edit the wrong bytes — never fine. The tests
 * below pin which of the two happens for each spelling.
 */

import { describe, expect, it } from "vitest";

import { createRegistry } from "../../src/registry/index.js";
import {
  diagnosticsOf,
  flowSource,
  nodeAt,
  open,
  pathsOfType,
  refusal,
  threeFieldRegistry,
  toolNode,
} from "./helpers.js";

function slackOnly(fields: Record<string, string>, editable: string[]) {
  const registry = createRegistry();
  registry.registerTool({
    name: "slack.send",
    label: "Slack Send",
    inputSchema: fields,
    editableFields: editable,
  });
  return registry;
}

/* -------------------------------------------------------------------------- */
/* call spellings                                                              */
/* -------------------------------------------------------------------------- */

describe("call spellings that are not the canonical one", () => {
  it("degrades optional chaining on tools, and says why (04 §2.5 / 01 §2)", async () => {
    const { graph } = await open(
      flowSource(
        `  const prs = await tools.github?.getNewPRs?.({ repo: input.repository });
  return prs;`,
      ),
    );
    expect(pathsOfType(graph, "tool")).toEqual([]);
    const diagnostic = diagnosticsOf(graph, "unsupported-optional-chaining");
    expect(diagnostic).toHaveLength(1);
    expect(diagnostic[0].severity).toBe("warning");
    expect(diagnostic[0].message).toContain("tools.github?.getNewPRs?.");
  });

  it("degrades a non-null assertion on a tool call rather than editing through it", async () => {
    const { graph } = await open(
      flowSource(
        `  const files = await tools.github.getFiles({ pr: input.repository })!;
  return files;`,
      ),
    );
    // The awaited call is wrapped in a `!`, so the statement's initializer is
    // not the call — the analyzer refuses to look through the wrapper and the
    // hidden-call rule catches the buried call instead (04 §1.4).
    expect(pathsOfType(graph, "tool")).toEqual([]);
    expect(diagnosticsOf(graph, "hidden-call-in-expression")).toHaveLength(1);
  });

  it("still shows the node for `{...} as const`, but refuses to edit its fields", async () => {
    const source = flowSource(
      '  await tools.slack.send({ channel: "#security", message: "m" } as const);',
    );
    const { session, graph } = await open(source);
    const node = nodeAt(graph, "flow/call:slack.send[0]");
    expect(node.type).toBe("tool");
    expect(node.data["argumentsEditable"]).toBe(false);

    // Refusing is the conservative half of 06 §1: the effective argument is an
    // assertion expression, and rewriting inside it is an edit whose result the
    // type system, not the patcher, decides. Said out loud, never guessed.
    const error = await refusal(session.patchNode(node.id, { channel: "#eng" }));
    expect(error.code).toBe("patch-not-editable");
    expect(error.message).toContain("code view");
    expect(graph.source.content).toBe(source);
  });

  it("does the same for `satisfies`", async () => {
    const { session, graph } = await open(
      flowSource(
        '  await tools.slack.send({ channel: "#security", message: "m" } satisfies { channel: string; message: string });',
      ),
    );
    const node = nodeAt(graph, "flow/call:slack.send[0]");
    expect(node.type).toBe("tool");
    const error = await refusal(session.patchNode(node.id, { channel: "#eng" }));
    expect(error.code).toBe("patch-not-editable");
  });

  it("refuses a call that takes more than one argument", async () => {
    const { session, graph } = await open(
      flowSource('  await tools.slack.send({ channel: "#security", message: "m" }, { retry: true });'),
    );
    const error = await refusal(
      session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { channel: "#eng" }),
    );
    expect(error.code).toBe("patch-not-editable");
  });
});

/* -------------------------------------------------------------------------- */
/* how a key is spelled                                                        */
/* -------------------------------------------------------------------------- */

describe("a property key is matched by what it binds, not how it is written", () => {
  it("edits a quoted key in place and keeps the quotes", async () => {
    // Regression: `getName()` returns the *text* of the key, so `"channel"`
    // never matched the field `channel`. The patcher then appended a second
    // `channel` at the end of the literal — the value on screen stayed put
    // while a duplicate silently overrode it (I6).
    const source = flowSource('  await tools.slack.send({ "channel": "#security", "message": "m" });');
    const { session, graph } = await open(source);
    const node = nodeAt(graph, "flow/call:slack.send[0]");
    expect(node.data["arguments"]).toEqual({ channel: '"#security"', message: '"m"' });

    const result = await session.patchNode(node.id, { channel: "#engineering" });
    expect(result.source).toBe(source.replace('"#security"', '"#engineering"'));
    expect(result.patches).toHaveLength(1);
    // Still exactly two properties — no duplicate key was introduced.
    const { graph: after } = await open(result.source);
    expect(Object.keys(toolNode(after, "slack.send").data["arguments"] as object)).toEqual([
      "channel",
      "message",
    ]);
  });

  it("edits a single-quoted key in a single-quoted file", async () => {
    const source = flowSource(`  await tools.slack.send({ 'channel': '#security', 'message': 'm' });`);
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      channel: "#engineering",
    });
    expect(result.source).toBe(source.replace("'#security'", "'#engineering'"));
  });

  it("edits a key written `[\"channel\"]` — a literal spelled the long way", async () => {
    const source = flowSource('  await tools.slack.send({ ["channel"]: "#security", message: "m" });');
    const { session, graph } = await open(source);
    expect((nodeAt(graph, "flow/call:slack.send[0]").data["arguments"] as object)).toHaveProperty("channel");
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      channel: "#engineering",
    });
    expect(result.source).toBe(source.replace('"#security"', '"#engineering"'));
  });

  it("edits a numeric key in place", async () => {
    const source = flowSource('  await tools.slack.send({ 1: "#security", message: "m" });');
    const { session, graph } = await open(source, slackOnly({ "1": "string", message: "string" }, ["1", "message"]));
    expect((nodeAt(graph, "flow/call:slack.send[0]").data["arguments"] as object)).toHaveProperty("1");
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { "1": "#eng" });
    expect(result.source).toBe(source.replace('"#security"', '"#eng"'));
  });

  it("refuses to add a field next to a computed key it cannot resolve", async () => {
    // `["chan" + "nel"]` may well *be* `channel`. Appending a second `channel`
    // would then override the value the user is looking at — the same silent
    // override 06 §1 forbids next to a spread.
    const source = flowSource('  await tools.slack.send({ ["chan" + "nel"]: "#security", message: "m" });');
    const { session, graph } = await open(source);
    const node = nodeAt(graph, "flow/call:slack.send[0]");
    expect(node.data["argumentsHaveOpaqueKey"]).toBe(true);
    expect(node.data["arguments"]).toEqual({ message: '"m"' });

    const error = await refusal(session.patchNode(node.id, { channel: "#engineering" }));
    expect(error.code).toBe("patch-not-editable");
    expect(error.message).toContain("computed key");
    expect(graph.source.content).toBe(source);
  });

  it("still edits the sibling fields it CAN see next to a computed key", async () => {
    const source = flowSource('  await tools.slack.send({ ["chan" + "nel"]: "#security", message: "m" });');
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { message: "n" });
    expect(result.source).toBe(source.replace('"m"', '"n"'));
  });

  it("rewrites a shorthand property to longhand — a defined behaviour, not a slip (06 §1)", async () => {
    const source = flowSource(
      `  const channel = "#security";
  await tools.slack.send({ channel, message: "m" });`,
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      channel: "#engineering",
    });
    expect(result.source).toBe(source.replace("{ channel, message", '{ channel: "#engineering", message'));
    // The data edge from the `channel` binding is gone, which is the correct
    // consequence: the value no longer comes from that variable.
    const { graph: after } = await open(result.source);
    expect(after.edges.filter((edge) => edge.kind === "data" && edge.label === "channel")).toEqual([]);
  });

  it("keeps a property before a spread out of reach", async () => {
    const source = flowSource(
      `  const defaults = { channel: "#b" };
  await tools.slack.send({ channel: "#security", ...defaults, message: "m" });`,
    );
    const { session, graph } = await open(source);
    const error = await refusal(
      session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { channel: "#eng" }),
    );
    expect(error.code).toBe("patch-not-editable");
    expect(error.message).toContain("spread");
  });

  it("edits a property written after a spread", async () => {
    const source = flowSource(
      `  const defaults = { channel: "#b" };
  await tools.slack.send({ ...defaults, channel: "#security", message: "m" });`,
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { channel: "#eng" });
    expect(result.source).toBe(source.replace('"#security"', '"#eng"'));
  });
});

/* -------------------------------------------------------------------------- */
/* layout, commas, comments                                                    */
/* -------------------------------------------------------------------------- */

describe("layout of the literal is the literal's, not the printer's", () => {
  it("keeps a comment between key and value", async () => {
    const source = flowSource(
      `  await tools.slack.send({
    channel: /* the room */ "#security",
    message: "m"
  });`,
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { channel: "#eng" });
    expect(result.source).toBe(source.replace('"#security"', '"#eng"'));
    expect(result.source).toContain("/* the room */");
  });

  it("keeps a comment inside the argument list", async () => {
    const source = flowSource(
      `  await tools.slack.send(
    // where to post
    { channel: "#security", message: "m" },
  );`,
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { channel: "#eng" });
    expect(result.source).toBe(source.replace('"#security"', '"#eng"'));
    expect(result.source).toContain("// where to post");
  });

  it("adds a property without a trailing comma when the literal has none", async () => {
    const source = flowSource(
      `  await tools.slack.send({
    channel: "#security"
  });`,
    );
    const { session, graph } = await open(source, threeFieldRegistry());
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { message: "m" });
    expect(result.source).toBe(
      source.replace('    channel: "#security"\n', '    channel: "#security",\n    message: "m"\n'),
    );
  });

  it("adds a property WITH a trailing comma when the literal keeps one", async () => {
    const source = flowSource(
      `  await tools.slack.send({
    channel: "#security",
  });`,
    );
    const { session, graph } = await open(source, threeFieldRegistry());
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { message: "m" });
    expect(result.source).toBe(
      source.replace('    channel: "#security",\n', '    channel: "#security",\n    message: "m",\n'),
    );
  });

  it("keeps a trailing comment on a line whose property survives", async () => {
    const source = flowSource(
      `  await tools.slack.send({
    channel: "#security", // security team only
    message: "m"
  });`,
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { channel: "#eng" });
    expect(result.source).toContain('channel: "#eng", // security team only');
  });
});

/* -------------------------------------------------------------------------- */
/* template literals                                                           */
/* -------------------------------------------------------------------------- */

describe("template literals", () => {
  it("leaves a template nested inside a template's interpolation intact", async () => {
    const source = flowSource(
      "  await tools.slack.send({ channel: \"#security\", message: `outer ${`inner ${input.repository}`} end` });",
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { channel: "#eng" });
    expect(result.source).toBe(source.replace('"#security"', '"#eng"'));
  });

  it("edits the text around an interpolation and stays a template (06 §3)", async () => {
    const source = flowSource(
      "  await tools.slack.send({ channel: \"#security\", message: `PR: ${input.repository}` });",
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      message: "Security PR: ${input.repository}",
    });
    expect(result.source).toContain("message: `Security PR: ${input.repository}`");
  });

  it("refuses a bare string against a field that holds an expression", async () => {
    const source = flowSource('  await tools.slack.send({ channel: input.repository, message: "m" });');
    const { session, graph } = await open(source);
    const error = await refusal(
      session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, { channel: "#eng" }),
    );
    expect(error.code).toBe("patch-not-editable");
    expect(error.message).toContain("expression");
  });

  it("accepts an explicit kind against that same field", async () => {
    const source = flowSource('  await tools.slack.send({ channel: input.repository, message: "m" });');
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[0]").id, {
      channel: { kind: "literal", value: "#eng" },
    });
    expect(result.source).toBe(source.replace("input.repository", '"#eng"'));
  });

  it("keeps a one-interpolation template and a bare expression apart", async () => {
    // They look identical in the inspector (`{{ pr.title }}`), and 06 §3 says
    // they must never be confused when patching: each is written back in its
    // own form.
    const asTemplate = flowSource(
      "  await tools.slack.send({ channel: \"#a\", message: `${input.repository}` });",
    );
    const asExpression = flowSource(
      '  await tools.slack.send({ channel: "#a", message: input.repository });',
    );
    const first = await open(asTemplate);
    const second = await open(asExpression);

    const patchedTemplate = await first.session.patchNode(
      nodeAt(first.graph, "flow/call:slack.send[0]").id,
      { message: "PR ${input.repository}" },
    );
    expect(patchedTemplate.source).toContain("message: `PR ${input.repository}`");

    const patchedExpression = await second.session.patchNode(
      nodeAt(second.graph, "flow/call:slack.send[0]").id,
      { message: { kind: "expression", text: "input.repository.toUpperCase()" } },
    );
    expect(patchedExpression.source).toContain("message: input.repository.toUpperCase()");
  });
});
