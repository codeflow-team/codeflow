/**
 * Targeted analyzer rules — the corners the fixture corpus exercises only
 * implicitly. Every assertion cites the rule it protects.
 */

import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/analyzer/index.js";
import { createRegistry, type Registry } from "../src/registry/index.js";
import type { WorkflowGraph, WorkflowNode } from "../src/model/index.js";

function registry(): Registry {
  return createRegistry({
    tools: [
      { name: "github.getFiles", label: "Get PR Files", inputSchema: { pr: "string" } },
      { name: "github.getPRs", label: "Get PRs", inputSchema: { repo: "string" } },
      { name: "slack.send", label: "Slack Send", inputSchema: { channel: "string", message: "string" } },
    ],
    functions: [
      {
        name: "isAuthChange",
        label: "Is Auth Change",
        inputSchema: { files: "File[]" },
        outputSchema: "boolean",
        code: "export function isAuthChange(files: File[]) { return true; }",
        modulePath: "@flows/lib",
      },
    ],
  });
}

function analyze(body: string, options?: { imports?: string; registry?: Registry }): WorkflowGraph {
  const source = `${options?.imports ?? ""}export default async function flow(input: { repo: string }, tools: Tools) {\n${body}\n}\n`;
  return analyzeSource(source, options?.registry ?? registry(), { file: "flow.ts" });
}

const LIB = 'import { isAuthChange } from "@flows/lib";\n';

function types(graph: WorkflowGraph): string[] {
  return graph.nodes.map((node) => node.type);
}
function codes(graph: WorkflowGraph): string[] {
  return graph.diagnostics.map((d) => d.code);
}
function byPath(graph: WorkflowGraph, suffix: string): WorkflowNode {
  const node = graph.nodes.find((n) => n.source.semanticPath.endsWith(suffix));
  if (node === undefined) {
    throw new Error(`no node matching ${suffix}; have ${graph.nodes.map((n) => n.source.semanticPath).join(", ")}`);
  }
  return node;
}

/* -------------------------------------------------------------------------- */

describe("tool resolution is binding-rooted (04 §1.2)", () => {
  it("resolves through a whole-object alias", () => {
    const graph = analyze(`  const t = tools;\n  await t.slack.send({ channel: "#a", message: "m" });`);
    expect(byPath(graph, "call:slack.send[0]").type).toBe("tool");
  });

  it("resolves through a partial alias", () => {
    const graph = analyze(`  const gh = tools.github;\n  await gh.getFiles({ pr: "1" });`);
    expect(byPath(graph, "call:github.getFiles[0]").type).toBe("tool");
  });

  it("resolves through a destructured alias", () => {
    const graph = analyze(`  const { github } = tools;\n  await github.getFiles({ pr: "1" });`);
    expect(byPath(graph, "call:github.getFiles[0]").type).toBe("tool");
  });

  it("does NOT resolve an unrelated object with the same shape", () => {
    const graph = analyze(
      `  const fake = { github: { getFiles: async (a: unknown) => [a] } };\n  await fake.github.getFiles({ pr: "1" });`,
    );
    expect(types(graph).filter((t) => t === "tool")).toHaveLength(0);
    expect(types(graph)).toContain("code");
  });

  it("does NOT resolve a nested binding that shadows `tools`", () => {
    const graph = analyze(
      `  if (input.repo) {\n    const tools = { slack: { send: async (a: unknown) => a } };\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }`,
    );
    expect(types(graph).filter((t) => t === "tool")).toHaveLength(0);
  });

  it("honours whatever the second parameter is called", () => {
    const source = `export default async function flow(input: { repo: string }, kit: Tools) {\n  await kit.slack.send({ channel: "#a", message: "m" });\n}\n`;
    const graph = analyzeSource(source, registry(), { file: "flow.ts" });
    expect(byPath(graph, "call:slack.send[0]").type).toBe("tool");
  });

  it("does not resolve dynamic element access", () => {
    const graph = analyze(`  await tools["slack"].send({ channel: "#a", message: "m" });`);
    expect(types(graph)).toContain("code");
    expect(types(graph)).not.toContain("tool");
  });

  it("produces an unknown node plus an error when the tool is absent", () => {
    const graph = analyze(`  await tools.github.nope({ pr: "1" });`);
    expect(byPath(graph, "call:github.nope[0]").type).toBe("unknown");
    expect(codes(graph)).toContain("unresolved-tool");
  });

  it("an empty registry makes every tool call unknown — the system still works (6b)", () => {
    const graph = analyze(`  await tools.slack.send({ channel: "#a", message: "m" });`, {
      registry: createRegistry(),
    });
    expect(byPath(graph, "call:slack.send[0]").type).toBe("unknown");
  });
});

/* -------------------------------------------------------------------------- */

describe("hidden-call rule (04 §1.4)", () => {
  it("degrades an await inside an if condition", () => {
    const graph = analyze(`  if (await tools.github.getFiles({ pr: "1" })) {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }`);
    expect(types(graph)).toContain("code");
    expect(types(graph)).not.toContain("condition");
    expect(codes(graph)).toContain("hidden-call-in-expression");
  });

  it("degrades a tool call hidden in another call's argument", () => {
    const graph = analyze(
      `  await tools.slack.send({ channel: "#a", message: String(await tools.github.getFiles({ pr: "1" })) });`,
    );
    expect(types(graph)).toContain("code");
    expect(codes(graph)).toContain("hidden-call-in-expression");
  });

  it("degrades a tool call hidden in a for-of iterable", () => {
    const graph = analyze(`  for (const pr of await tools.github.getPRs({ repo: input.repo })) {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }`);
    expect(types(graph)).not.toContain("loop");
    expect(codes(graph)).toContain("hidden-call-in-expression");
  });

  it("degrades a tool call hidden in a while condition", () => {
    const graph = analyze(`  while (await tools.github.getFiles({ pr: "1" })) {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }`);
    expect(types(graph)).not.toContain("loop");
    expect(codes(graph)).toContain("hidden-call-in-expression");
  });

  it("degrades a tool call hidden in a return expression", () => {
    const graph = analyze(`  return await tools.github.getFiles({ pr: "1" });`);
    expect(types(graph)).toContain("code");
    expect(codes(graph)).toContain("hidden-call-in-expression");
  });

  it("reports one diagnostic per hidden call, not one per nested node", () => {
    const graph = analyze(`  if (await tools.github.getFiles({ pr: "1" })) {\n    return null;\n  }`);
    expect(codes(graph).filter((c) => c === "hidden-call-in-expression")).toHaveLength(1);
  });

  it("a function REFERENCE used as a callback is the documented exception", () => {
    const graph = analyze(
      `  const files = await tools.github.getFiles({ pr: "1" });\n  if (files.some(isAuthChange)) {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }`,
      { imports: LIB },
    );
    expect(byPath(graph, "if[0]").type).toBe("condition");
    expect(codes(graph)).not.toContain("hidden-call-in-expression");
  });

  it("optional chaining on tools degrades with its own diagnostic (01 §2)", () => {
    const graph = analyze(`  await tools.slack?.send?.({ channel: "#a", message: "m" });`);
    expect(types(graph)).toContain("code");
    expect(codes(graph)).toContain("unsupported-optional-chaining");
    expect(codes(graph)).not.toContain("hidden-call-in-expression");
  });
});

/* -------------------------------------------------------------------------- */

describe("condition, merge and label sugar (04 §2.2b, §2.4)", () => {
  it("uses the registry label for `fn(args)` as the whole condition", () => {
    const graph = analyze(
      `  const files = await tools.github.getFiles({ pr: "1" });\n  if (isAuthChange(files)) {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }`,
      { imports: LIB },
    );
    const condition = byPath(graph, "if[0]");
    expect(condition.label).toBe("Is Auth Change");
    expect(condition.data["labelSource"]).toBe("registry");
  });

  it("uses the registry label for xs.every(fn)", () => {
    const graph = analyze(
      `  const files = await tools.github.getFiles({ pr: "1" });\n  if (files.every(isAuthChange)) {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }`,
      { imports: LIB },
    );
    expect(byPath(graph, "if[0]").label).toBe("Is Auth Change");
  });

  it("refuses sugar for a negated condition — a wrong label is failure mode I6", () => {
    const graph = analyze(
      `  const files = await tools.github.getFiles({ pr: "1" });\n  if (!files.some(isAuthChange)) {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }`,
      { imports: LIB },
    );
    const condition = byPath(graph, "if[0]");
    expect(condition.label).toBe("!files.some(isAuthChange)");
    expect(condition.data["labelSource"]).toBe("expression");
  });

  it("refuses sugar for a combined condition", () => {
    const graph = analyze(
      `  const files = await tools.github.getFiles({ pr: "1" });\n  if (files.length > 0 && files.some(isAuthChange)) {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }`,
      { imports: LIB },
    );
    expect(byPath(graph, "if[0]").data["labelSource"]).toBe("expression");
  });

  it("refuses sugar for a LOCAL function of the same name (resolution is by symbol)", () => {
    const source = `function isAuthChange(files: unknown[]) { return files.length > 0; }\nexport default async function flow(input: { repo: string }, tools: Tools) {\n  const files = await tools.github.getFiles({ pr: "1" });\n  if (isAuthChange(files)) {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }\n}\n`;
    const graph = analyzeSource(source, registry(), { file: "flow.ts" });
    expect(byPath(graph, "if[0]").data["labelSource"]).toBe("expression");
  });

  it("creates a merge node when a statement follows the branch", () => {
    const graph = analyze(
      `  if (input.repo) {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }\n  await tools.slack.send({ channel: "#b", message: "m" });`,
    );
    expect(types(graph)).toContain("merge");
  });

  it("creates NO merge node when the branch ends the block", () => {
    const graph = analyze(
      `  if (input.repo) {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }`,
    );
    expect(types(graph)).not.toContain("merge");
    // Both branches reach the block boundary — here, the synthetic output.
    const output = byPath(graph, "flow#output");
    const incoming = graph.edges.filter((e) => e.target === output.id && e.kind === "control");
    expect(incoming.map((e) => e.sourcePort ?? "-").sort()).toEqual(["-", "false"]);
  });

  it("an else-if chain shares the outermost merge", () => {
    const graph = analyze(
      `  if (input.repo === "a") {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  } else if (input.repo === "b") {\n    await tools.slack.send({ channel: "#b", message: "m" });\n  } else {\n    await tools.slack.send({ channel: "#c", message: "m" });\n  }\n  await tools.slack.send({ channel: "#d", message: "m" });`,
    );
    const merges = graph.nodes.filter((n) => n.type === "merge");
    expect(merges).toHaveLength(1);
    expect(merges[0].source.semanticPath).toBe("flow/if[0]#merge");
    expect(byPath(graph, "flow/if[0]/else/if[0]").type).toBe("condition");
    expect(graph.edges.filter((e) => e.target === merges[0].id && e.kind === "control")).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- */

describe("parallel (04 §2.6)", () => {
  it("rejects a non-array argument", () => {
    const graph = analyze(`  const xs = [1];\n  await Promise.all(xs.map(async (x) => tools.github.getFiles({ pr: String(x) })));`);
    expect(types(graph)).not.toContain("parallel");
    expect(codes(graph)).toContain("hidden-call-in-expression");
  });

  it("rejects an element that is not a single call", () => {
    const graph = analyze(
      `  await Promise.all([tools.github.getFiles({ pr: "1" }), input.repo ? tools.github.getFiles({ pr: "2" }) : null]);`,
    );
    expect(types(graph)).not.toContain("parallel");
    expect(codes(graph)).toContain("hidden-call-in-expression");
  });

  it("rejects an element that awaits (the await belongs to Promise.all)", () => {
    const graph = analyze(
      `  await Promise.all([await tools.github.getFiles({ pr: "1" }), tools.github.getFiles({ pr: "2" })]);`,
    );
    expect(types(graph)).not.toContain("parallel");
    expect(codes(graph)).toContain("hidden-call-in-expression");
  });

  it("accepts an array literal of single calls and converges on a merge", () => {
    const graph = analyze(
      `  await Promise.all([tools.github.getFiles({ pr: "1" }), tools.github.getFiles({ pr: "2" })]);`,
    );
    expect(types(graph)).toContain("parallel");
    const merge = byPath(graph, "parallel[0]#merge");
    expect(graph.edges.filter((e) => e.target === merge.id && e.kind === "control")).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */

describe("try / catch / finally (04 §2.7)", () => {
  it("routes a return inside the body through finally", () => {
    const graph = analyze(
      `  try {\n    return input.repo;\n  } finally {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }`,
    );
    const ret = byPath(graph, "try[0]/return[0]");
    const fin = byPath(graph, "try[0]/finally/call:slack.send[0]");
    expect(graph.edges.some((e) => e.source === ret.id && e.target === fin.id)).toBe(true);
  });

  it("does NOT route a break that targets a loop nested inside the try", () => {
    const graph = analyze(
      `  try {\n    for (const x of [1]) {\n      break;\n    }\n  } finally {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }`,
    );
    const jump = byPath(graph, "break[0]");
    const fin = byPath(graph, "try[0]/finally/call:slack.send[0]");
    expect(graph.edges.some((e) => e.source === jump.id && e.target === fin.id)).toBe(false);
  });

  it("catch without a binding is valid and simply has no data edge", () => {
    const graph = analyze(
      `  try {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  } catch {\n    await tools.slack.send({ channel: "#b", message: "m" });\n  }`,
    );
    const tryNode = byPath(graph, "try[0]");
    expect(tryNode.outputs).toHaveLength(0);
    expect(tryNode.data["catchParam"]).toBeNull();
    expect(graph.edges.filter((e) => e.source === tryNode.id && e.kind === "data")).toHaveLength(0);
  });

  it("try/finally with no catch has no error edge", () => {
    const graph = analyze(
      `  try {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  } finally {\n    await tools.slack.send({ channel: "#b", message: "m" });\n  }`,
    );
    expect(graph.edges.some((e) => e.label === "error")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("loops (04 §2.5, §2.8)", () => {
  it("recognises a counter bound", () => {
    const graph = analyze(`  let n = 0;\n  while (n < 5) {\n    n += 1;\n  }`);
    expect(byPath(graph, "while[0]").data["bounded"]).toBe(true);
    expect(codes(graph)).not.toContain("unbounded-loop-risk");
  });

  it("recognises a flag assigned in the body", () => {
    const graph = analyze(`  let done = false;\n  while (!done) {\n    done = true;\n  }`);
    expect(byPath(graph, "while[0]").data["bounded"]).toBe(true);
  });

  it("warns when no bound is recognisable", () => {
    const graph = analyze(`  while (true) {\n    await tools.slack.send({ channel: "#a", message: "m" });\n  }`);
    expect(byPath(graph, "while[0]").data["bounded"]).toBe(false);
    expect(codes(graph)).toContain("unbounded-loop-risk");
  });

  it("classic for and do-while fall back to code nodes", () => {
    const forGraph = analyze(`  for (let i = 0; i < 3; i++) {\n    console.log(i);\n  }`);
    expect(types(forGraph)).toContain("code");
    expect(types(forGraph)).not.toContain("loop");

    const doGraph = analyze(`  let i = 0;\n  do {\n    i++;\n  } while (i < 3);`);
    expect(types(doGraph)).not.toContain("loop");
  });

  it("for await records its kind so the patcher keeps the await", () => {
    const graph = analyze(`  for await (const x of [1]) {\n    await tools.slack.send({ channel: "#a", message: String(x) });\n  }`);
    expect(byPath(graph, "for[0]").data["kind"]).toBe("forAwaitOf");
  });

  it("body exits are not wired back — no reverse loop edge (04 §2.5)", () => {
    const graph = analyze(`  for (const x of [1]) {\n    await tools.slack.send({ channel: "#a", message: String(x) });\n  }`);
    const loop = byPath(graph, "for[0]");
    const send = byPath(graph, "for[0]/call:slack.send[0]");
    expect(graph.edges.some((e) => e.source === send.id && e.target === loop.id)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("data flow (03 §6)", () => {
  it("one binding used at N nodes yields N edges from the same port", () => {
    const graph = analyze(
      `  const files = await tools.github.getFiles({ pr: "1" });\n  await tools.slack.send({ channel: "#a", message: String(files) });\n  await tools.slack.send({ channel: "#b", message: String(files) });`,
    );
    const producer = byPath(graph, "call:github.getFiles[0]");
    const dataEdges = graph.edges.filter((e) => e.source === producer.id && e.kind === "data");
    expect(dataEdges).toHaveLength(2);
    expect(dataEdges.every((e) => e.sourcePort === "files")).toBe(true);
  });

  it("shorthand property counts as a read", () => {
    const graph = analyze(
      `  const pr = await tools.github.getFiles({ pr: "1" });\n  await tools.github.getFiles({ pr });`,
    );
    const first = byPath(graph, "call:github.getFiles[0]");
    const second = byPath(graph, "call:github.getFiles[1]");
    expect(graph.edges.some((e) => e.source === first.id && e.target === second.id && e.kind === "data")).toBe(true);
  });

  it("object literal keys are not reads", () => {
    const graph = analyze(
      `  const channel = "#a";\n  await tools.slack.send({ channel: "#b", message: "m" });`,
    );
    const send = byPath(graph, "call:slack.send[0]");
    expect(graph.edges.filter((e) => e.target === send.id && e.kind === "data")).toHaveLength(0);
  });

  it("a code node that only reads a binding still gets a reader edge", () => {
    const graph = analyze(
      `  const files = await tools.github.getFiles({ pr: "1" });\n  files.push("x");`,
    );
    const producer = byPath(graph, "call:github.getFiles[0]");
    const code = byPath(graph, "stmt[1]");
    expect(graph.edges.some((e) => e.source === producer.id && e.target === code.id && e.kind === "data")).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe("flow contract (01 §1, §4)", () => {
  it("errors when there is no default export", () => {
    const graph = analyzeSource("export const x = 1;\n", registry(), { file: "flow.ts" });
    expect(codes(graph)).toEqual(["invalid-flow-contract"]);
    expect(graph.nodes).toHaveLength(0);
  });

  it("errors when the default export is not async", () => {
    const graph = analyzeSource(
      "export default function flow(input: unknown, tools: unknown) {}\n",
      registry(),
      { file: "flow.ts" },
    );
    expect(codes(graph)).toContain("invalid-flow-contract");
  });

  it("errors on the wrong parameter count but still analyzes the body", () => {
    const graph = analyzeSource(
      "export default async function flow(input: { repo: string }) {\n  const x = input.repo;\n}\n",
      registry(),
      { file: "flow.ts" },
    );
    expect(codes(graph)).toContain("invalid-flow-contract");
    expect(types(graph)).toContain("code");
  });

  it("warns about extra exports and analyzes only the default one", () => {
    const graph = analyzeSource(
      "export function helper() { return 1; }\nexport default async function flow(input: unknown, tools: Tools) {\n  await tools.slack.send({ channel: \"#a\", message: \"m\" });\n}\n",
      registry(),
      { file: "flow.ts" },
    );
    expect(codes(graph)).toContain("multiple-exports");
    expect(byPath(graph, "call:slack.send[0]").type).toBe("tool");
  });

  it("follows `export default <identifier>` to its declaration", () => {
    const graph = analyzeSource(
      "async function flow(input: unknown, tools: Tools) {\n  await tools.slack.send({ channel: \"#a\", message: \"m\" });\n}\nexport default flow;\n",
      registry(),
      { file: "flow.ts" },
    );
    expect(byPath(graph, "call:slack.send[0]").type).toBe("tool");
  });

  it("builds the trigger from the input parameter's type", () => {
    const graph = analyze(`  const x = input.repo;`);
    const trigger = byPath(graph, "flow#trigger");
    expect(trigger.data["inputType"]).toBe("{ repo: string }");
    expect(trigger.outputs[0].id).toBe("input");
    expect(trigger.capabilities).toEqual({ editable: false, deletable: false, expandable: false });
  });

  it("uses TriggerMetadata from AnalyzeOptions when the host supplies it (03 §9)", () => {
    const source = `export default async function flow(input: { repo: string }, tools: Tools) {\n  const x = input.repo;\n}\n`;
    const graph = analyzeSource(source, registry(), {
      file: "flow.ts",
      trigger: { kind: "cron", label: "Every day 9am", config: { cron: "0 9 * * *" } },
    });
    const trigger = byPath(graph, "flow#trigger");
    expect(trigger.label).toBe("Every day 9am");
    expect(trigger.data["triggerKind"]).toBe("cron");
    expect(trigger.data["config"]).toEqual({ cron: "0 9 * * *" });
  });
});

/* -------------------------------------------------------------------------- */

describe("code nodes (04 §2.11)", () => {
  it("merges consecutive unsupported statements into one node", () => {
    const graph = analyze(`  const a = 1;\n  const b = a + 1;\n  const c = b + 1;`);
    const code = graph.nodes.filter((n) => n.type === "code");
    expect(code).toHaveLength(1);
    expect(code[0].source.semanticPath).toBe("flow/stmt[0..2]");
    expect(code[0].data["statementCount"]).toBe(3);
    expect((code[0].data["statementFingerprints"] as string[])).toHaveLength(3);
  });

  it("splits a run when a supported construct interrupts it", () => {
    const graph = analyze(
      `  const a = 1;\n  await tools.slack.send({ channel: "#a", message: "m" });\n  const b = 2;`,
    );
    const paths = graph.nodes.filter((n) => n.type === "code").map((n) => n.source.semanticPath);
    expect(paths).toEqual(["flow/stmt[0]", "flow/stmt[2]"]);
  });

  it("marks an unsupported region with an info diagnostic, never silence", () => {
    const graph = analyze(`  const a = someUnknownHelper(1);`);
    expect(codes(graph)).toContain("unsupported-construct");
  });
});
