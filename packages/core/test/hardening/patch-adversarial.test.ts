/**
 * Patching under conditions designed to make a minimal patch look ambiguous.
 *
 * I3 is a byte claim: "the patch touches the field that was edited, and nothing
 * else". The way to break it is to give the engine a reason to guess — five
 * copies of the string it is looking for, a comma whose owner just disappeared,
 * a value that lives inside another node's template. If the engine ever reaches
 * for a text search, one of these fails.
 *
 * I4 is the other half: patch, re-analyze, patch again, undo — and land back on
 * the same bytes with the same ids.
 */

import { describe, expect, it } from "vitest";

import { createRegistry } from "../../src/registry/index.js";
import type { WorkflowGraph } from "../../src/model/index.js";
import { FILE, flowSource, nodeAt, open, refusal, threeFieldRegistry, toolNode } from "./helpers.js";

/* -------------------------------------------------------------------------- */
/* ambiguity                                                                   */
/* -------------------------------------------------------------------------- */

describe("the patch finds the field, never the text", () => {
  it("changes one of six identical strings — the one in the edited field", async () => {
    const source = flowSource(
      `  const a = "#security";
  const b = { x: "#security" };
  // #security is also mentioned here
  await tools.slack.send({ channel: "#security", message: "#security" });
  const c = \`about #security\`;
  return { a, b, c };`,
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(toolNode(graph, "slack.send").id, { channel: "#engineering" });

    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].oldText).toBe('"#security"');
    expect(result.source).toBe(
      source.replace('channel: "#security"', 'channel: "#engineering"'),
    );
    // Five occurrences left, exactly as before.
    expect(result.source.split("#security").length - 1).toBe(5);
  });

  it("changes a value that is identical to its sibling field's value", async () => {
    const source = flowSource('  await tools.slack.send({ channel: "same", message: "same" });');
    const { session, graph } = await open(source);
    const result = await session.patchNode(toolNode(graph, "slack.send").id, { message: "other" });
    expect(result.source).toBe(flowSource('  await tools.slack.send({ channel: "same", message: "other" });'));
  });

  it("edits one of two byte-identical calls without touching its twin", async () => {
    const source = flowSource(
      `  await tools.slack.send({ channel: "#security", message: "m" });
  await tools.slack.send({ channel: "#security", message: "m" });`,
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(nodeAt(graph, "flow/call:slack.send[1]").id, {
      channel: "#engineering",
    });
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].range.start.line).toBe(5);
    expect(result.source).toBe(
      flowSource(
        `  await tools.slack.send({ channel: "#security", message: "m" });
  await tools.slack.send({ channel: "#engineering", message: "m" });`,
      ),
    );
  });

  it("edits a node whose value also appears in another node's template literal", async () => {
    const source = flowSource(
      `  const prs = await tools.github.getNewPRs({ repo: "#security" });
  await tools.slack.send({ channel: "#security", message: \`repo #security \${prs.length}\` });`,
    );
    const { session, graph } = await open(source);
    const result = await session.patchNode(toolNode(graph, "slack.send").id, { channel: "#eng" });
    expect(result.source).toContain('repo: "#security"');
    expect(result.source).toContain("message: `repo #security ${prs.length}`");
    expect(result.source).toContain('channel: "#eng"');
  });

  it("changes two fields of one object in a single patch, as two ranges", async () => {
    const source = flowSource('  await tools.slack.send({ channel: "#security", message: "m" });');
    const { session, graph } = await open(source);
    const result = await session.patchNode(toolNode(graph, "slack.send").id, {
      channel: "#engineering",
      message: "n",
    });
    expect(result.patches.map((patch) => [patch.oldText, patch.newText])).toEqual([
      ['"#security"', '"#engineering"'],
      ['"m"', '"n"'],
    ]);
    expect(result.source).toBe(flowSource('  await tools.slack.send({ channel: "#engineering", message: "n" });'));
  });
});

/* -------------------------------------------------------------------------- */
/* commas                                                                      */
/* -------------------------------------------------------------------------- */

describe("removing a property leaves the commas correct in all three positions", () => {
  const multiline = flowSource(
    `  await tools.slack.send({
    channel: "#security",
    message: "m",
    thread: "t"
  });`,
  );

  async function removeFrom(source: string, field: string): Promise<string> {
    const { session, graph } = await open(source, threeFieldRegistry());
    const result = await session.patchNode(toolNode(graph, "slack.send").id, {
      [field]: { kind: "remove" },
    });
    return result.source;
  }

  it("removes the first property", async () => {
    expect(await removeFrom(multiline, "channel")).toBe(
      flowSource(
        `  await tools.slack.send({
    message: "m",
    thread: "t"
  });`,
      ),
    );
  });

  it("removes a middle property", async () => {
    expect(await removeFrom(multiline, "message")).toBe(
      flowSource(
        `  await tools.slack.send({
    channel: "#security",
    thread: "t"
  });`,
      ),
    );
  });

  it("removes the last property and takes the preceding comma with it", async () => {
    expect(await removeFrom(multiline, "thread")).toBe(
      flowSource(
        `  await tools.slack.send({
    channel: "#security",
    message: "m"
  });`,
      ),
    );
  });

  it("removes the last property of a literal that keeps a trailing comma", async () => {
    const trailing = flowSource(
      `  await tools.slack.send({
    channel: "#security",
    message: "m",
    thread: "t",
  });`,
    );
    expect(await removeFrom(trailing, "thread")).toBe(
      flowSource(
        `  await tools.slack.send({
    channel: "#security",
    message: "m",
  });`,
      ),
    );
  });

  it("removes a property from a single-line literal", async () => {
    const oneLine = flowSource('  await tools.slack.send({ channel: "#security", message: "m", thread: "t" });');
    const source = await removeFrom(oneLine, "message");
    expect(source).toContain('{ channel: "#security", thread: "t" }');
    // Still parses, and still one tool node.
    const { graph } = await open(source, threeFieldRegistry());
    expect(graph.nodes.filter((node) => node.type === "tool")).toHaveLength(1);
  });

  it("removes a property together with the comment on its line", async () => {
    const commented = flowSource(
      `  await tools.slack.send({
    channel: "#security",
    message: "m", // what we say
    thread: "t"
  });`,
    );
    const source = await removeFrom(commented, "message");
    expect(source).not.toContain("what we say");
    expect(source).toContain('channel: "#security",');
    expect(source).toContain('thread: "t"');
  });

  it("removes two properties in one patch without leaving a stray comma", async () => {
    const { session, graph } = await open(multiline, threeFieldRegistry());
    const result = await session.patchNode(toolNode(graph, "slack.send").id, {
      channel: { kind: "remove" },
      message: { kind: "remove" },
    });
    expect(result.source).toBe(
      flowSource(
        `  await tools.slack.send({
    thread: "t"
  });`,
      ),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* repeated patching                                                           */
/* -------------------------------------------------------------------------- */

describe("five patches in a row, then undo", () => {
  const source = flowSource(
    `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#security", message: \`PR \${prs.length}\` });
  return prs;`,
  );

  function signature(graph: WorkflowGraph): string[] {
    return graph.nodes.map((node) => `${node.source.semanticPath}=${node.id}`);
  }

  it("keeps every node id stable across all five re-analyses", async () => {
    const { session, graph } = await open(source);
    const before = signature(graph);
    let current = graph;
    for (let round = 1; round <= 5; round++) {
      const result = await session.patchNode(toolNode(current, "slack.send").id, { channel: `#c${String(round)}` });
      current = result.graph;
      expect(signature(current)).toEqual(before);
    }
  });

  it("lands on the source the last patch asked for, and only that", async () => {
    const { session, graph } = await open(source);
    let current = graph;
    let text = source;
    for (let round = 1; round <= 5; round++) {
      const result = await session.patchNode(toolNode(current, "slack.send").id, { channel: `#c${String(round)}` });
      current = result.graph;
      text = result.source;
      expect(result.patches).toHaveLength(1);
    }
    expect(text).toBe(source.replace('"#security"', '"#c5"'));
  });

  it("returns to the original file byte for byte when the edit is reversed", async () => {
    const { session, graph } = await open(source);
    const forward = await session.patchNode(toolNode(graph, "slack.send").id, { channel: "#engineering" });
    expect(forward.source).not.toBe(source);
    const back = await session.patchNode(toolNode(forward.graph, "slack.send").id, { channel: "#security" });
    expect(back.source).toBe(source);
    expect(signature(back.graph)).toEqual(signature(graph));
  });

  it("reverses a property removal by adding it back — same text, same order", async () => {
    const three = flowSource(
      `  await tools.slack.send({
    channel: "#security",
    message: "m"
  });`,
    );
    const { session, graph } = await open(three, threeFieldRegistry());
    const removed = await session.patchNode(toolNode(graph, "slack.send").id, {
      message: { kind: "remove" },
    });
    const restored = await session.patchNode(toolNode(removed.graph, "slack.send").id, { message: "m" });
    expect(restored.source).toBe(three);
  });
});

/* -------------------------------------------------------------------------- */
/* round trip across the whole set                                             */
/* -------------------------------------------------------------------------- */

describe("analyze → patch → analyze is stable and narrow (I4)", () => {
  const cases: Record<string, { source: string; field: string; value: string }> = {
    "single line": {
      source: flowSource('  await tools.slack.send({ channel: "#security", message: "m" });'),
      field: "channel",
      value: "#engineering",
    },
    "quoted key": {
      source: flowSource('  await tools.slack.send({ "channel": "#security", message: "m" });'),
      field: "channel",
      value: "#engineering",
    },
    crlf: {
      source: flowSource('  await tools.slack.send({ channel: "#security", message: "m" });').replace(
        /\n/g,
        "\r\n",
      ),
      field: "channel",
      value: "#engineering",
    },
    bom: {
      source: "﻿" + flowSource('  await tools.slack.send({ channel: "#security", message: "m" });'),
      field: "channel",
      value: "#engineering",
    },
    "inside a loop inside a try": {
      source: flowSource(
        `  try {
    for (const pr of [1]) {
      await tools.slack.send({ channel: "#security", message: "m" });
    }
  } catch (e) {
    await tools.slack.send({ channel: "#e", message: "e" });
  }`,
      ),
      field: "channel",
      value: "#engineering",
    },
    "with a template sibling": {
      source: flowSource(
        "  const prs = await tools.github.getNewPRs({ repo: input.repository });\n" +
          "  await tools.slack.send({ channel: \"#security\", message: `PR ${prs.length}` });",
      ),
      field: "channel",
      value: "#engineering",
    },
    unicode: {
      source: flowSource('  await tools.slack.send({ channel: "#security", message: "安全 🎉" });'),
      field: "channel",
      value: "#エンジニアリング",
    },
  };

  for (const [name, testCase] of Object.entries(cases)) {
    it(`${name}: only the edited node changes, and the second round is a no-op`, async () => {
      const { session, graph } = await open(testCase.source);
      const target = toolNode(graph, "slack.send");
      const idsBefore = graph.nodes.map((node) => node.id);

      const result = await session.patchNode(target.id, { [testCase.field]: testCase.value });
      expect(result.graph.nodes.map((node) => node.id)).toEqual(idsBefore);

      const updated = result.changes.filter((change) => change.type === "node.updated").map((c) => c.nodeId);
      expect(updated).toContain(target.id);
      expect(result.changes.filter((change) => change.type === "node.added")).toEqual([]);
      expect(result.changes.filter((change) => change.type === "node.removed")).toEqual([]);

      // Applying the same edit again is a no-op down to the byte (I4).
      const again = await session.patchNode(target.id, { [testCase.field]: testCase.value });
      expect(again.patches).toEqual([]);
      expect(again.source).toBe(result.source);

      // A cold re-analyze of the patched source produces the same shape.
      const cold = await open(result.source);
      expect(cold.graph.nodes.map((node) => node.source.semanticPath)).toEqual(
        result.graph.nodes.map((node) => node.source.semanticPath),
      );
    });
  }
});

/* -------------------------------------------------------------------------- */
/* deleting a statement that IS a body                                         */
/* -------------------------------------------------------------------------- */

describe("deleting the brace-less body of a construct leaves an empty block", () => {
  /** Delete the first node of `type` and return the flow body of the result. */
  async function deleteFirst(body: string, type: string): Promise<string> {
    const source = flowSource(body);
    const { session, graph } = await open(source);
    const target = graph.nodes.find((node) => node.type === type);
    expect(target, `no ${type} node`).toBeDefined();
    const result = await session.patchNode(target!.id, { $delete: true });
    return result.source.split("\n").slice(3, -2).join("\n");
  }

  it("does not hand the body to the next statement — the guard-pattern bug", async () => {
    // Regression: removing the text of `continue;` here left `if (pr > 1)` with
    // the *next* statement as its body. The file still parsed and still
    // type-checked, and the Slack message quietly became conditional. Silent
    // reinterpretation is the one outcome I6 rules out entirely.
    expect(
      await deleteFirst(
        `  for (const pr of [1]) {
    if (pr > 1) continue;
    await tools.slack.send({ channel: "#a", message: "m" });
  }`,
        "jump",
      ),
    ).toBe(
      `  for (const pr of [1]) {
    if (pr > 1) { }
    await tools.slack.send({ channel: "#a", message: "m" });
  }`,
    );
  });

  it("matches what the braced form already produced", async () => {
    expect(
      await deleteFirst(
        `  for (const pr of [1]) {
    if (pr > 1) { continue; }
    await tools.slack.send({ channel: "#a", message: "m" });
  }`,
        "jump",
      ),
    ).toBe(
      `  for (const pr of [1]) {
    if (pr > 1) { }
    await tools.slack.send({ channel: "#a", message: "m" });
  }`,
    );
  });

  it("covers an early return used as a brace-less `if` body", async () => {
    expect(
      await deleteFirst(
        `  if (input.repository === "x") return null;
  return 1;`,
        "output",
      ),
    ).toBe(
      `  if (input.repository === "x") { }
  return 1;`,
    );
  });

  it("covers a brace-less `else`", async () => {
    // This one used to fail as `patch-invalid` ("Expression expected") — the
    // transaction held, but the user was told nothing useful.
    expect(
      await deleteFirst(
        `  if (input.repository === "x") { await tools.slack.send({ channel: "#a", message: "m" }); }
  else return 2;`,
        "output",
      ),
    ).toBe(
      `  if (input.repository === "x") { await tools.slack.send({ channel: "#a", message: "m" }); }
  else { }`,
    );
  });

  it("covers a brace-less `for` body", async () => {
    expect(
      await deleteFirst(
        `  for (const pr of [1]) continue;
  await tools.slack.send({ channel: "#a", message: "m" });`,
        "jump",
      ),
    ).toBe(
      `  for (const pr of [1]) { }
  await tools.slack.send({ channel: "#a", message: "m" });`,
    );
  });

  it("covers a brace-less `while` body", async () => {
    expect(
      await deleteFirst(
        `  let n = 0;
  while (n < 3) break;
  await tools.slack.send({ channel: "#a", message: "m" });`,
        "jump",
      ),
    ).toBe(
      `  let n = 0;
  while (n < 3) { }
  await tools.slack.send({ channel: "#a", message: "m" });`,
    );
  });

  it("covers a tool call used as a brace-less `if` body", async () => {
    expect(
      await deleteFirst(
        `  if (input.repository === "x") await tools.slack.send({ channel: "#a", message: "m" });
  return 1;`,
        "tool",
      ),
    ).toBe(
      `  if (input.repository === "x") { }
  return 1;`,
    );
  });

  it("still removes the whole line when the statement is one of several in a block", async () => {
    expect(
      await deleteFirst(
        `  await tools.slack.send({ channel: "#a", message: "m" });
  return 1;`,
        "tool",
      ),
    ).toBe("  return 1;");
  });

  it("re-analyzes into a graph that matches the new source", async () => {
    const source = flowSource(
      `  for (const pr of [1]) {
    if (pr > 1) continue;
    await tools.slack.send({ channel: "#a", message: "m" });
  }`,
    );
    const { session, graph } = await open(source);
    const jump = graph.nodes.find((node) => node.type === "jump")!;
    const result = await session.patchNode(jump.id, { $delete: true });

    expect(result.graph.nodes.some((node) => node.id === jump.id)).toBe(false);
    // The Slack call is still a child of the loop, not of the condition.
    const send = toolNode(result.graph, "slack.send");
    const loop = result.graph.nodes.find((node) => node.type === "loop")!;
    expect(send.data["parentId"]).toBe(loop.id);
    expect(send.source.semanticPath).toBe("flow/for[0]/call:slack.send[0]");
  });
});

/* -------------------------------------------------------------------------- */
/* refusals leave the file alone                                               */
/* -------------------------------------------------------------------------- */

describe("a refused patch does not write a byte", () => {
  const source = flowSource('  await tools.slack.send({ channel: "#security", message: "m" });');

  it("refuses an unknown operation key", async () => {
    const { session, graph } = await open(source);
    const error = await refusal(session.patchNode(toolNode(graph, "slack.send").id, { $nope: 1 }));
    expect(error.code).toBe("patch-unsupported");
    expect(graph.source.content).toBe(source);
  });

  it("refuses to combine an exclusive operation with a field edit", async () => {
    const { session, graph } = await open(source);
    const error = await refusal(
      session.patchNode(toolNode(graph, "slack.send").id, { $delete: true, channel: "#x" }),
    );
    expect(error.code).toBe("patch-unsupported");
    expect(graph.source.content).toBe(source);
  });

  it("refuses a field that is not in the tool's input schema", async () => {
    const registry = createRegistry();
    registry.registerTool({
      name: "slack.send",
      label: "Slack Send",
      inputSchema: { channel: "string", message: "string" },
    });
    const { session, graph } = await open(source, registry);
    const error = await refusal(session.patchNode(toolNode(graph, "slack.send").id, { thread: "t" }));
    expect(error.code).toBe("patch-unsupported");
    expect(graph.source.content).toBe(source);
  });

  it("refuses when the file moved under it, and says so (06 §5)", async () => {
    const { session, graph } = await open(source);
    const edited = source.replace('"#security"', '"#hand-edited"');
    const error = await refusal(
      session.patchNode(toolNode(graph, "slack.send").id, { channel: "#x" }, { source: edited }),
    );
    expect(error.code).toBe("patch-conflict");
    expect(error.message).toContain("reload");
  });

  it("refuses when only a comment inside the node moved — trivia counts (06 §5)", async () => {
    const commented = flowSource(
      `  await tools.slack.send({ channel: "#security", /* keep */ message: "m" });`,
    );
    const { session, graph } = await open(commented);
    const edited = commented.replace("/* keep */", "/* changed */");
    const error = await refusal(
      session.patchNode(toolNode(graph, "slack.send").id, { channel: "#x" }, { source: edited }),
    );
    expect(error.code).toBe("patch-conflict");
  });

  it("still refuses after the graph was re-analyzed at the same file path", async () => {
    const { session, graph } = await open(source);
    await session.analyze(source, { file: FILE });
    const error = await refusal(session.patchNode(toolNode(graph, "slack.send").id, { $nope: 1 }));
    expect(error.code).toBe("patch-unsupported");
  });
});
