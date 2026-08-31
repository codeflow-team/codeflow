/**
 * Per-node scope table — `WorkflowGraph.scopes` (03 §6, model/scope.ts).
 *
 * The question this table answers is "what data can the user drag into THIS
 * node", so every case here is a way of getting that answer wrong: a binding
 * that is not visible yet, one that is shadowed, one the node produces itself,
 * one that only exists inside a loop body or a catch clause.
 */

import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/analyzer/index.js";
import { createCodeFlow } from "../src/session.js";
import { createSampleRegistry } from "./fixtures.js";
import type { ScopeBinding, WorkflowGraph, WorkflowNode } from "../src/model/index.js";

const FILE = "flow.ts";

function flowSource(body: string, imports = ""): string {
  return `import type { Tools } from "../generated/tools";
${imports}
export default async function flow(input: { repository: string }, tools: Tools) {
${body}
}
`;
}

function analyze(body: string, imports = ""): WorkflowGraph {
  return analyzeSource(flowSource(body, imports), createSampleRegistry(), { file: FILE });
}

function node(graph: WorkflowGraph, path: string): WorkflowNode {
  const found = graph.nodes.find((candidate) => candidate.source.semanticPath === path);
  expect(found, `no node at ${path}`).toBeDefined();
  return found!;
}

function scopeAt(graph: WorkflowGraph, path: string): ScopeBinding[] {
  return graph.scopes[node(graph, path).id] ?? [];
}

function names(graph: WorkflowGraph, path: string): string[] {
  return scopeAt(graph, path).map((binding) => binding.name);
}

function pathsOf(graph: WorkflowGraph, binding: ScopeBinding): string[] {
  return binding.origins.map((origin) => {
    const owner = graph.nodes.find((candidate) => candidate.id === origin.nodeId);
    return `${owner?.source.semanticPath ?? origin.nodeId}:${origin.port ?? ""}`;
  });
}

function find(graph: WorkflowGraph, path: string, name: string): ScopeBinding {
  const binding = scopeAt(graph, path).find((candidate) => candidate.name === name);
  expect(binding, `no binding \`${name}\` in scope at ${path}`).toBeDefined();
  return binding!;
}

/* -------------------------------------------------------------------------- */
/* visibility                                                                  */
/* -------------------------------------------------------------------------- */

describe("what is visible at a node", () => {
  const graph = analyze(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr });
    await tools.slack.send({ channel: "#a", message: "b" });
  }
  await tools.slack.send({ channel: "#b", message: "c" });`);

  it("shows the loop item inside the body and nowhere else", () => {
    expect(names(graph, "flow/for[0]/call:slack.send[0]")).toContain("pr");
    // The same tool, the same file — outside the loop `pr` does not exist.
    expect(names(graph, "flow/call:slack.send[0]")).not.toContain("pr");
    expect(names(graph, "flow/call:github.getNewPRs[0]")).not.toContain("pr");
    expect(find(graph, "flow/for[0]/call:github.getFiles[0]", "pr").loopItem).toBe(true);
  });

  it("marks the loop item's origin as the loop node itself", () => {
    expect(pathsOf(graph, find(graph, "flow/for[0]/call:github.getFiles[0]", "pr"))).toEqual([
      "flow/for[0]:pr",
    ]);
  });

  it("does not list a binding the node itself declares", () => {
    // `const prs = await tools.github.getNewPRs(…)` — this node writes `prs`;
    // the value is not available at its own configuration.
    expect(names(graph, "flow/call:github.getNewPRs[0]")).not.toContain("prs");
    expect(names(graph, "flow/for[0]/call:github.getFiles[0]")).not.toContain("files");
    // …and the next node down sees it.
    expect(names(graph, "flow/for[0]/call:slack.send[0]")).toContain("files");
  });

  it("does not leak a binding declared after the node", () => {
    // `files` is declared inside the loop, after the loop node was emitted.
    expect(names(graph, "flow/for[0]")).not.toContain("files");
    expect(names(graph, "flow/call:github.getNewPRs[0]")).not.toContain("files");
  });

  it("keeps the kind of every binding, `tools` and imports included", () => {
    const scope = scopeAt(graph, "flow/for[0]/call:slack.send[0]");
    const kinds = Object.fromEntries(scope.map((binding) => [binding.name, binding.kind]));
    expect(kinds["tools"]).toBe("tools");
    expect(kinds["input"]).toBe("value");
    expect(kinds["prs"]).toBe("value");
  });

  it("flags the flow's own parameters", () => {
    expect(find(graph, "flow/call:github.getNewPRs[0]", "input").parameter).toBe(true);
    expect(find(graph, "flow/call:github.getNewPRs[0]", "tools").parameter).toBe(true);
    expect(find(graph, "flow/for[0]/call:slack.send[0]", "prs").parameter).toBeUndefined();
  });

  it("carries the declared output schema when there is exactly one origin", () => {
    expect(find(graph, "flow/for[0]/call:slack.send[0]", "prs").schema).toBe("PullRequest[]");
    expect(find(graph, "flow/for[0]/call:slack.send[0]", "files").schema).toBe("File[]");
    // The trigger's port carries the annotated type of `input` — as a *shape*
    // when the annotation is an object type literal, so the UI can offer
    // `input.repository` as a row of its own (analyzer/type-schema.ts).
    expect(find(graph, "flow/call:github.getNewPRs[0]", "input").schema).toEqual({
      repository: "string",
    });
  });

  it("resolves an import to its kind rather than dropping it", () => {
    const withImport = analyze(
      `  const files = await tools.github.getFiles({ pr: input.repository });
  const flagged = isAuthChange(files);
  await tools.slack.send({ channel: "#a", message: "b" });`,
      `import { isAuthChange } from "@flows/lib";
import chalk from "chalk";`,
    );
    const scope = scopeAt(withImport, "flow/call:slack.send[0]");
    const kinds = Object.fromEntries(scope.map((binding) => [binding.name, binding.kind]));
    expect(kinds["isAuthChange"]).toBe("library-function");
    expect(kinds["chalk"]).toBe("foreign-import");
    // An import is produced by nothing in the graph.
    expect(find(withImport, "flow/call:slack.send[0]", "isAuthChange").origins).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* shadowing — 03 §6, `Scope.lookup` semantics                                 */
/* -------------------------------------------------------------------------- */

describe("shadowing", () => {
  it("shows the inner binding exactly once, never both", () => {
    const graph = analyze(`  const pr = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of pr) {
    await tools.slack.send({ channel: "#a", message: "b" });
  }`);

    const inside = scopeAt(graph, "flow/for[0]/call:slack.send[0]").filter(
      (binding) => binding.name === "pr",
    );
    expect(inside).toHaveLength(1);
    // The one that survives is the loop item, not the outer `const`.
    expect(inside[0].loopItem).toBe(true);
    expect(pathsOf(graph, inside[0])).toEqual(["flow/for[0]:pr"]);
  });

  it("keeps the outer binding visible outside the shadowing scope", () => {
    const graph = analyze(`  const pr = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of pr) {
    await tools.slack.send({ channel: "#a", message: "b" });
  }
  await tools.slack.send({ channel: "#b", message: "c" });`);

    const outside = scopeAt(graph, "flow/call:slack.send[0]").filter(
      (binding) => binding.name === "pr",
    );
    expect(outside).toHaveLength(1);
    expect(outside[0].loopItem).toBeUndefined();
    expect(pathsOf(graph, outside[0])).toEqual(["flow/call:github.getNewPRs[0]:pr"]);
  });
});

/* -------------------------------------------------------------------------- */
/* origins — 03 §6 union of writers                                            */
/* -------------------------------------------------------------------------- */

describe("origins", () => {
  it("gives a destructured output one origin per name, with the right port", () => {
    const graph = analyze(`  const { data, error } = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#a", message: "b" });`);

    expect(pathsOf(graph, find(graph, "flow/call:slack.send[0]", "data"))).toEqual([
      "flow/call:github.getNewPRs[0]:data",
    ]);
    expect(pathsOf(graph, find(graph, "flow/call:slack.send[0]", "error"))).toEqual([
      "flow/call:github.getNewPRs[0]:error",
    ]);
    // Several ports, so no single declared output type is claimed.
    expect(find(graph, "flow/call:slack.send[0]", "data").schema).toBeUndefined();
  });

  it("renames a destructured property to the local name but keeps the port", () => {
    const graph = analyze(`  const { data: rows } = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#a", message: "b" });`);
    expect(pathsOf(graph, find(graph, "flow/call:slack.send[0]", "rows"))).toEqual([
      "flow/call:github.getNewPRs[0]:data",
    ]);
  });

  it("lists every writer of a `let`, the later loop accumulator included", () => {
    const graph = analyze(`  let total = 0;
  const prs = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of prs) {
    total = total + 1;
  }
  await tools.slack.send({ channel: "#a", message: "b" });`);

    // A node *after* the loop sees both writers: the declaration and the
    // accumulating statement inside the body (03 §6, union of writers).
    const after = find(graph, "flow/call:slack.send[0]", "total");
    expect(after.origins.length).toBe(2);
    expect(pathsOf(graph, after)).toEqual(["flow/stmt[0]:total", "flow/for[0]/stmt[0]:total"]);

    // The accumulating node itself is not one of its own origins.
    const inside = find(graph, "flow/for[0]/stmt[0]", "total");
    expect(pathsOf(graph, inside)).toEqual(["flow/stmt[0]:total"]);
  });
});

/* -------------------------------------------------------------------------- */
/* catch — 04 §2.7                                                             */
/* -------------------------------------------------------------------------- */

describe("catch binding", () => {
  const graph = analyze(`  try {
    await tools.github.getNewPRs({ repo: input.repository });
  } catch (err) {
    await tools.slack.send({ channel: "#a", message: "b" });
  } finally {
    await tools.slack.send({ channel: "#b", message: "c" });
  }`);

  it("is in scope inside the catch slot only", () => {
    expect(names(graph, "flow/try[0]/catch/call:slack.send[0]")).toContain("err");
    expect(names(graph, "flow/try[0]/call:github.getNewPRs[0]")).not.toContain("err");
    expect(names(graph, "flow/try[0]/finally/call:slack.send[0]")).not.toContain("err");
    expect(names(graph, "flow/try[0]")).not.toContain("err");
  });

  it("points the catch binding at the try node's error port", () => {
    expect(pathsOf(graph, find(graph, "flow/try[0]/catch/call:slack.send[0]", "err"))).toEqual([
      "flow/try[0]:err",
    ]);
  });

  it("has nothing to add for `catch {}` without a binding", () => {
    const bare = analyze(`  try {
    await tools.github.getNewPRs({ repo: input.repository });
  } catch {
    await tools.slack.send({ channel: "#a", message: "b" });
  }`);
    expect(names(bare, "flow/try[0]/catch/call:slack.send[0]")).toEqual(["input", "tools"]);
  });
});

/* -------------------------------------------------------------------------- */
/* determinism — I2                                                            */
/* -------------------------------------------------------------------------- */

describe("determinism (I2)", () => {
  const body = `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  let total = 0;
  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr });
    total = total + files.length;
    await tools.slack.send({ channel: "#a", message: "b" });
  }`;

  it("is byte-identical across two cold analyses", () => {
    const first = analyze(body);
    const second = analyze(body);
    expect(JSON.stringify(second.scopes)).toBe(JSON.stringify(first.scopes));
  });

  it("sorts every node's bindings by name", () => {
    const graph = analyze(body);
    for (const bindings of Object.values(graph.scopes)) {
      const sorted = [...bindings].map((binding) => binding.name).sort();
      expect(bindings.map((binding) => binding.name)).toEqual(sorted);
    }
  });

  it("survives a reformat with the same bindings per node", () => {
    const graph = analyze(body);
    // Same code, reformatted: extra blank lines, comments, different spacing.
    const reformatted = analyze(`
  // fetch the pull requests
  const prs = await tools.github.getNewPRs({
    repo: input.repository,
  });

  let total = 0;

  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr }); // per PR
    total = total + files.length;
    await tools.slack.send({
      channel: "#a",
      message: "b",
    });
  }`);

    const byPath = (target: WorkflowGraph): Record<string, string[]> =>
      Object.fromEntries(
        target.nodes.map((candidate) => [
          candidate.source.semanticPath,
          (target.scopes[candidate.id] ?? []).map(
            (binding) => `${binding.name}:${binding.kind}:${String(binding.origins.length)}`,
          ),
        ]),
      );
    expect(byPath(reformatted)).toEqual(byPath(graph));
  });

  it("gives every node an entry, synthetic nodes included", () => {
    const graph = analyze(body);
    for (const candidate of graph.nodes) {
      expect(Array.isArray(graph.scopes[candidate.id]), candidate.source.semanticPath).toBe(true);
    }
    expect(Object.keys(graph.scopes)).toHaveLength(graph.nodes.length);
  });
});

/* -------------------------------------------------------------------------- */
/* session surface                                                             */
/* -------------------------------------------------------------------------- */

describe("CodeFlowSession.scopeAt", () => {
  it("answers [] for an unknown id and before the first analyze", async () => {
    const session = createCodeFlow({ registry: createSampleRegistry() });
    expect(session.scopeAt("nope")).toEqual([]);

    const graph = await session.analyze(
      flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#a", message: "b" });`),
      { file: FILE },
    );
    expect(session.scopeAt("nope")).toEqual([]);
    expect(session.scopeAt(node(graph, "flow/call:slack.send[0]").id).map((b) => b.name)).toEqual([
      "input",
      "prs",
      "tools",
    ]);
  });

  it("keeps the table keyed by the ids the session's graph actually uses", async () => {
    const session = createCodeFlow({ registry: createSampleRegistry() });
    const body = `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#a", message: "b" });`;
    await session.analyze(flowSource(body), { file: FILE });
    // A second analyze carries ids across (03 §5.0); the scope table has to be
    // remapped with them or it would key on ids no node has.
    const second = await session.analyze(flowSource(`${body}\n  // trailing comment`), {
      file: FILE,
    });

    const ids = new Set(second.nodes.map((candidate) => candidate.id));
    for (const key of Object.keys(second.scopes)) expect(ids.has(key)).toBe(true);
    for (const bindings of Object.values(second.scopes)) {
      for (const binding of bindings) {
        for (const origin of binding.origins) expect(ids.has(origin.nodeId)).toBe(true);
      }
    }
    const send = node(second, "flow/call:slack.send[0]");
    expect(session.scopeAt(send.id).map((binding) => binding.name)).toEqual([
      "input",
      "prs",
      "tools",
    ]);
  });
});
