/**
 * Regression locks for every bug this project has actually hit — the rule of
 * 11 §4: "every real bug becomes a test, and the corpus only ever grows".
 *
 * Several of these pass today. That is the point: they were paid for once (in
 * a build log, an AI eval run, or a browser session), and this file is what
 * stops anyone paying for them twice. Each `describe` names where the bug came
 * from so a future reader knows what it costs to break it.
 */

import { describe, expect, it } from "vitest";

import { createCodeFlow } from "../../src/session.js";
import { createSampleRegistry } from "../fixtures.js";
import {
  FILE,
  LIB_IMPORT,
  diagnosticsOf,
  flowSource,
  lineAt,
  nodeAt,
  open,
  pathsOfType,
  positionOf,
} from "./helpers.js";

/* -------------------------------------------------------------------------- */
/* 1 — identity mis-binding (I5, 03 §5.2; NOTES "Phase 3")                      */
/* -------------------------------------------------------------------------- */

describe("1 — identity never mis-binds (I5)", () => {
  const one = flowSource(`  await tools.slack.send({ channel: "#security", message: "m" });`);
  const two = flowSource(
    `  await tools.slack.send({ channel: "#security", message: "m" });
  await tools.slack.send({ channel: "#security", message: "m" });`,
  );

  it("keeps a byte-identical call's id on exactly one node when a twin is inserted before it", async () => {
    const session = createCodeFlow({ registry: createSampleRegistry() });
    const before = await session.analyze(one, { file: FILE });
    const oldId = nodeAt(before, "flow/call:slack.send[0]").id;

    const after = await session.analyze(two, { file: FILE });
    const carriers = after.nodes.filter((node) => node.id === oldId);

    // Two siblings identical to the byte are genuinely indistinguishable
    // without provenance, so the spec commits to the *bijection*, not to which
    // twin wins (03 §5.2). What must never happen is the id vanishing, or
    // landing on two nodes at once.
    expect(carriers).toHaveLength(1);
    expect(carriers[0].type).toBe("tool");
    expect(carriers[0].data["toolName"]).toBe("slack.send");

    const resolution = session.lastResolution();
    expect(resolution).not.toBeNull();
    const previous = resolution!.matches.map((match) => match.previousId);
    const fresh = resolution!.matches.map((match) => match.freshId);
    expect(new Set(previous).size).toBe(previous.length);
    expect(new Set(fresh).size).toBe(fresh.length);
  });

  it("gives the second twin a genuinely new id", async () => {
    const session = createCodeFlow({ registry: createSampleRegistry() });
    const before = await session.analyze(one, { file: FILE });
    const oldIds = new Set(before.nodes.map((node) => node.id));

    const after = await session.analyze(two, { file: FILE });
    const sends = after.nodes.filter((node) => node.data["toolName"] === "slack.send");
    expect(sends).toHaveLength(2);
    expect(sends.filter((node) => oldIds.has(node.id))).toHaveLength(1);
    expect(new Set(sends.map((node) => node.id)).size).toBe(2);
  });

  it("follows each node when two calls of the same tool swap places", async () => {
    // Same tool, different arguments — the case a pure LCS alignment gets wrong
    // (it matches by position). Fingerprints are order-free, so each node's id
    // has to travel with its own arguments, not with its slot.
    const before = flowSource(
      `  await tools.slack.send({ channel: "#a", message: "m" });
  await tools.slack.send({ channel: "#b", message: "m" });`,
    );
    const after = flowSource(
      `  await tools.slack.send({ channel: "#b", message: "m" });
  await tools.slack.send({ channel: "#a", message: "m" });`,
    );
    const session = createCodeFlow({ registry: createSampleRegistry() });
    const first = await session.analyze(before, { file: FILE });
    const idOf = (graph: typeof first, channel: string): string => {
      const node = graph.nodes.find((candidate) => {
        const args = candidate.data["arguments"] as Record<string, string> | null;
        return args !== null && args !== undefined && args["channel"] === `"${channel}"`;
      });
      expect(node, `no node with channel ${channel}`).toBeDefined();
      return node!.id;
    };
    const idA = idOf(first, "#a");
    const idB = idOf(first, "#b");
    expect(idA).not.toBe(idB);

    const second = await session.analyze(after, { file: FILE });
    expect(idOf(second, "#a")).toBe(idA);
    expect(idOf(second, "#b")).toBe(idB);
    // …and they really did swap position, so this is not a trivial pass.
    expect(nodeAt(second, "flow/call:slack.send[0]").id).toBe(idB);
    expect(nodeAt(second, "flow/call:slack.send[1]").id).toBe(idA);
  });
});

/* -------------------------------------------------------------------------- */
/* 2 — code node keeps its identity when the run grows (I5, 04 §2.11)          */
/* -------------------------------------------------------------------------- */

describe("2 — a code node absorbs a neighbour without losing its id", () => {
  const before = flowSource(
    `  const a = 1 + 2;
  await tools.slack.send({ channel: "#a", message: "m" });`,
  );
  const after = flowSource(
    `  const a = 1 + 2;
  const b = a * 3;
  await tools.slack.send({ channel: "#a", message: "m" });`,
  );

  it("reports node.updated, not removed + added", async () => {
    const session = createCodeFlow({ registry: createSampleRegistry() });
    const first = await session.analyze(before, { file: FILE });
    const codeId = nodeAt(first, "flow/stmt[0]").id;

    const second = await session.analyze(after, { file: FILE });
    const changes = session.lastChanges();

    // The run grew from stmt[0] to stmt[0..1]: a different semantic path, the
    // same node. Statement-fingerprint overlap is what carries the id across
    // (04 §2.11) — without it the user would watch their code node disappear
    // and a stranger take its place.
    const code = nodeAt(second, "flow/stmt[0..1]");
    expect(code.id).toBe(codeId);
    expect(changes.filter((change) => change.type === "node.added")).toEqual([]);
    expect(changes.filter((change) => change.type === "node.removed")).toEqual([]);
    expect(
      changes.some((change) => change.type === "node.updated" && change.nodeId === codeId),
    ).toBe(true);
  });

  it("keeps the id when the run shrinks again", async () => {
    const session = createCodeFlow({ registry: createSampleRegistry() });
    await session.analyze(before, { file: FILE });
    const grown = await session.analyze(after, { file: FILE });
    const codeId = nodeAt(grown, "flow/stmt[0..1]").id;
    const shrunk = await session.analyze(before, { file: FILE });
    expect(nodeAt(shrunk, "flow/stmt[0]").id).toBe(codeId);
  });
});

/* -------------------------------------------------------------------------- */
/* 3 — hoisted promises (the AI conformance bug, NOTES "Phase 5")              */
/* -------------------------------------------------------------------------- */

describe("3 — hoisted promises never become a fake parallel node", () => {
  const source = flowSource(
    `  const aP = tools.github.getNewPRs({ repo: input.repository });
  const bP = tools.github.getFiles({ pr: input.repository });
  const [a, b] = await Promise.all([aP, bP]);
  return { a, b };`,
  );

  it("degrades the Promise.all to a code node instead of inventing branches", async () => {
    const { graph } = await open(source);

    // The model that produced this code got L1 instead of L2 and the eval
    // caught it. The failure mode being locked out is the *opposite* one: an
    // analyzer generous enough to call `Promise.all([aP, bP])` a parallel node
    // would draw two branches whose calls happened somewhere else entirely.
    expect(pathsOfType(graph, "parallel")).toEqual([]);
    expect(pathsOfType(graph, "code")).toEqual(["flow/stmt[2]"]);
    expect(diagnosticsOf(graph, "unsupported-construct").map((d) => d.source?.semanticPath)).toEqual([
      "flow/stmt[2]",
    ]);
  });

  it("names the buried Promise.all in the conformance diagnostic", async () => {
    // `inline-logic-in-code-node` is a *validation* diagnostic (10 §5), not an
    // analyze one: analyzing already-committed source is not the moment to
    // grade it. It has to name the expression, or the retry prompt cannot tell
    // the model what to move.
    const { session } = await open(source);
    const result = await session.validate(source);
    const inline = result.diagnostics.filter((d) => d.code === "inline-logic-in-code-node");
    expect(inline).toHaveLength(1);
    expect(inline[0].message).toContain("Promise.all([aP, bP])");
  });

  it("keeps the two hoisted calls visible as their own tool nodes", async () => {
    const { graph } = await open(source);
    // They are still calls-as-statements, so they are still steps — the graph
    // does not lose the work, only the (absent) parallelism.
    expect(graph.nodes.filter((node) => node.type === "tool").map((node) => node.data["toolName"])).toEqual([
      "github.getNewPRs",
      "github.getFiles",
    ]);
  });

  it("scores below L2 so the retry loop asks for a rewrite", async () => {
    const { session } = await open(source);
    const result = await session.validate(source);
    expect(result.level).not.toBe("L2");
    expect(result.level).toBe("L1");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain("inline-logic-in-code-node");
  });

  it("reaches L2 once the calls are awaited inside Promise.all", async () => {
    // The fix the style guide now teaches — proof the L2 gate is not simply
    // unreachable for parallel code.
    const fixed = flowSource(
      `  const [a, b] = await Promise.all([
    tools.github.getNewPRs({ repo: input.repository }),
    tools.github.getFiles({ pr: input.repository }),
  ]);
  return { a, b };`,
    );
    const { session, graph } = await open(fixed);
    expect(pathsOfType(graph, "parallel")).toEqual(["flow/parallel[0]"]);
    expect((await session.validate(fixed)).level).toBe("L2");
  });
});

/* -------------------------------------------------------------------------- */
/* 4 — tools alias vs impostor (04 §1.2)                                       */
/* -------------------------------------------------------------------------- */

describe("4 — `tools` is resolved by binding, never by name", () => {
  it("resolves a call through `const t = tools`", async () => {
    const { graph } = await open(
      flowSource(
        `  const t = tools;
  const prs = await t.github.getNewPRs({ repo: input.repository });
  return prs;`,
      ),
    );
    const tool = nodeAt(graph, "flow/call:github.getNewPRs[0]");
    expect(tool.type).toBe("tool");
    expect(tool.data["toolName"]).toBe("github.getNewPRs");
    expect(tool.data["resolved"]).toBe(true);
  });

  it("resolves a call through a destructured alias `const { github } = tools`", async () => {
    const { graph } = await open(
      flowSource(
        `  const { github } = tools;
  const prs = await github.getNewPRs({ repo: input.repository });
  return prs;`,
      ),
    );
    expect(nodeAt(graph, "flow/call:github.getNewPRs[0]").type).toBe("tool");
  });

  it("does NOT mistake a hand-made object of the same shape for tools", async () => {
    const { graph } = await open(
      flowSource(
        `  const tools2 = { github: { getFiles: async (_a: unknown) => [] } };
  const files = await tools2.github.getFiles({ pr: input.repository });
  return files;`,
      ),
    );
    // A string match on "github.getFiles" would have produced a tool node here
    // and the graph would claim a GitHub call that never happens (I6).
    expect(graph.nodes.some((node) => node.type === "tool")).toBe(false);
    expect(pathsOfType(graph, "code")).toEqual(["flow/stmt[0..1]"]);
  });

  it("does not fall for a local variable literally named `tools`", async () => {
    const { graph } = await open(
      flowSource(
        `  for (const pr of [1]) {
    const tools = { slack: { send: async (_a: unknown) => undefined } };
    await tools.slack.send({ channel: "#a", message: "m" });
  }`,
      ),
    );
    // The inner binding shadows the parameter, so nothing in the loop body is a
    // tool call — resolution is by binding, and the shadow is a different one.
    expect(graph.nodes.some((node) => node.type === "tool")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* 5 — hidden calls (I1, 04 §1.4)                                              */
/* -------------------------------------------------------------------------- */

describe("5 — a call hidden in an expression degrades, and says where", () => {
  /** Analyze one statement and return its single hidden-call diagnostic. */
  async function hidden(body: string): Promise<{ source: string; line: number; column: number; message: string }> {
    const source = flowSource(body);
    const { graph } = await open(source);
    expect(graph.nodes.some((node) => node.type === "code")).toBe(true);
    const found = diagnosticsOf(graph, "hidden-call-in-expression");
    expect(found).toHaveLength(1);
    const at = found[0].source!;
    return { source, line: at.start.line, column: at.start.column, message: found[0].message };
  }

  it("in an if condition", async () => {
    const found = await hidden(
      `  if (await tools.github.getFiles({ pr: input.repository })) {
    await tools.slack.send({ channel: "#a", message: "m" });
  }`,
    );
    expect(found.message).toContain("tools.github.getFiles");
    expect(lineAt(found.source, found.line).slice(found.column - 1)).toMatch(/^await tools\.github\.getFiles/);
  });

  it("in a while condition", async () => {
    const found = await hidden(`  while (await tools.github.getFiles({ pr: input.repository })) { break; }`);
    expect(lineAt(found.source, found.line).slice(found.column - 1)).toMatch(/^await tools\.github\.getFiles/);
  });

  it("as the argument of another call", async () => {
    const found = await hidden(
      `  const n = String(await tools.github.getFiles({ pr: input.repository }));
  return n;`,
    );
    expect(lineAt(found.source, found.line).slice(found.column - 1)).toMatch(/^await tools\.github\.getFiles/);
  });

  it("inside a .map() callback", async () => {
    const found = await hidden(
      `  const all = await Promise.all([1].map((pr) => tools.github.getFiles({ pr })));
  return all;`,
    );
    // The call inside the callback, not the Promise.all, and not the statement.
    expect(lineAt(found.source, found.line).slice(found.column - 1)).toMatch(/^tools\.github\.getFiles\(\{ pr \}\)/);
  });

  it("inside a template-literal interpolation", async () => {
    const found = await hidden(
      "  const msg = `n=${await tools.github.getFiles({ pr: input.repository })}`;\n  return msg;",
    );
    expect(lineAt(found.source, found.line).slice(found.column - 1)).toMatch(/^await tools\.github\.getFiles/);
  });

  it("points at the call, not at the head of the code node that swallowed it", async () => {
    const source = flowSource(
      `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const label = "x";
  const msg = \`n=\${await tools.github.getFiles({ pr: prs[0] })}\`;
  return { label, msg };`,
    );
    const { graph } = await open(source);
    const code = graph.nodes.find((node) => node.type === "code")!;
    const diagnostic = diagnosticsOf(graph, "hidden-call-in-expression")[0];

    // The diagnostic is attached to the code node (there is nothing finer to
    // attach it to) but its *position* is the call's — otherwise the editor
    // would put the squiggle on an unrelated line and the user would go
    // looking for a problem that is not there.
    expect(diagnostic.source!.semanticPath).toBe(code.source.semanticPath);
    expect(diagnostic.source!.start.offset).toBeGreaterThan(code.source.start.offset);
    const at = positionOf(source, diagnostic.source!.start.offset);
    expect(lineAt(source, at.line)).toContain("await tools.github.getFiles");
  });

  it("emits one diagnostic per hidden call, not one per await+call pair", async () => {
    const { graph } = await open(
      flowSource(
        `  const a = String(await tools.github.getFiles({ pr: input.repository }));
  const b = String(await tools.github.getFiles({ pr: input.repository }));
  return { a, b };`,
      ),
    );
    expect(diagnosticsOf(graph, "hidden-call-in-expression")).toHaveLength(2);
  });

  it("leaves a sync library predicate alone — the rule is scoped on purpose (04 §1.4)", async () => {
    const { graph } = await open(
      flowSource(
        `  const files = await tools.github.getFiles({ pr: input.repository });
  if (files.some(isAuthChange) && files.length > 0) {
    await tools.slack.send({ channel: "#a", message: "m" });
  }`,
        LIB_IMPORT,
      ),
    );
    expect(diagnosticsOf(graph, "hidden-call-in-expression")).toEqual([]);
    expect(nodeAt(graph, "flow/if[0]").type).toBe("condition");
  });
});

/* -------------------------------------------------------------------------- */
/* 6 — callback sugar labels (I6, 04 §2.2b)                                    */
/* -------------------------------------------------------------------------- */

describe("6 — the registry label is used only where it is still true", () => {
  async function condition(expression: string) {
    const { graph } = await open(
      flowSource(
        `  const files = await tools.github.getFiles({ pr: input.repository });
  if (${expression}) {
    await tools.slack.send({ channel: "#a", message: "m" });
  }`,
        LIB_IMPORT,
      ),
    );
    return nodeAt(graph, "flow/if[0]");
  }

  it("labels `files.some(isAuthChange)` from the registry", async () => {
    const node = await condition("files.some(isAuthChange)");
    expect(node.label).toBe("Is Auth Change");
    expect(node.data["labelSource"]).toBe("registry");
    expect(node.data["functionName"]).toBe("isAuthChange");
  });

  it("labels `files.every(isAuthChange)` from the registry too", async () => {
    const node = await condition("files.every(isAuthChange)");
    expect(node.label).toBe("Is Auth Change");
    expect(node.data["labelSource"]).toBe("registry");
  });

  it("labels a direct call `isAuthChange(files[0])` from the registry", async () => {
    const node = await condition("isAuthChange(files[0])");
    expect(node.data["labelSource"]).toBe("registry");
  });

  it("refuses the label under negation — it would read as the opposite (I6)", async () => {
    const node = await condition("!files.some(isAuthChange)");
    expect(node.label).toBe("!files.some(isAuthChange)");
    expect(node.data["labelSource"]).toBe("expression");
    expect(node.data["functionName"]).toBeUndefined();
  });

  it("refuses the label for a conjunction — the node is more than the function", async () => {
    const node = await condition("isAuthChange(files[0]) && files.length > 3");
    expect(node.label).toBe("isAuthChange(files[0]) && files.length > 3");
    expect(node.data["labelSource"]).toBe("expression");
  });

  it("refuses the label for a disjunction of two registered calls", async () => {
    const node = await condition("isAuthChange(files[0]) || isAuthChange(files[1])");
    expect(node.data["labelSource"]).toBe("expression");
  });

  it("refuses the label for `.filter(fn).length > 0` — a different question", async () => {
    const node = await condition("files.filter(isAuthChange).length > 0");
    expect(node.data["labelSource"]).toBe("expression");
  });
});
