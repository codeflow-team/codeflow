/**
 * Analyzer + patch engine, driven by a registry built entirely from **real** MCP
 * captures (`test/real-schemas/*.json`).
 *
 * The corpus in `@codeflow/core` proves the analyzer against tools that were
 * invented to exercise it. These flows call `filesystem.editFile`,
 * `memory.createEntities` and `sequentialThinking.sequentialthinking` with the
 * schemas those servers actually publish — an array of objects two levels deep,
 * a tool with no `outputSchema`, a name that slugs away its underscores — inside
 * the control flow that makes analysis hard: nested loops, try/catch, calls in
 * both the try and the catch arm.
 *
 * 05 §3: "tool đến từ MCP hay local function hay REST SDK là không phân biệt
 * được và không cần phân biệt". These tests are that claim, checked.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it } from "vitest";
import { CodeFlowError, createCodeFlow, createRegistry, type Registry, type WorkflowGraph, type WorkflowNode } from "@codeflow/core";

import { mcpToolToDefinition, mcpToolsToDefinitions } from "../src/adapter.js";
import type { McpTool } from "../src/types.js";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "real-schemas");
const FILE = "flow.ts";

function capture(server: string): McpTool[] {
  return (JSON.parse(readFileSync(join(SCHEMA_DIR, `${server}.json`), "utf8")) as { tools: McpTool[] })
    .tools;
}

/** A registry of real MCP tools, mounted one namespace per server. */
function realRegistry(servers: readonly string[]): Registry {
  const registry = createRegistry();
  for (const server of servers) {
    for (const definition of mcpToolsToDefinitions(capture(server), {
      namespace: server.replace(/-/g, "_"),
      server,
    })) {
      registry.registerTool(definition);
    }
  }
  return registry;
}

function flowSource(body: string): string {
  return `import type { Tools } from "../generated/tools";

export default async function flow(input: { root: string }, tools: Tools) {
${body}
}
`;
}

function node(graph: WorkflowGraph, path: string): WorkflowNode {
  const found = graph.nodes.find((candidate) => candidate.source.semanticPath === path);
  expect(found, `no node at ${path}; have:\n${graph.nodes.map((n) => n.source.semanticPath).join("\n")}`).toBeDefined();
  return found!;
}

function paths(graph: WorkflowGraph): string[] {
  return graph.nodes.map((n) => n.source.semanticPath ?? "");
}

/* -------------------------------------------------------------------------- */

describe("a real flow across two MCP servers, nested loop + try/catch", () => {
  const SOURCE = flowSource(`  const listing = await tools.filesystem.listDirectory({ path: input.root });

  for (const line of listing.content.split("\\n")) {
    for (const part of line.split(" ")) {
      try {
        const file = await tools.filesystem.readTextFile({ path: part, head: 50 });
        await tools.memory.createEntities({
          entities: [{ name: part, entityType: "file", observations: [file.content] }],
        });
      } catch (error) {
        await tools.filesystem.writeFile({ path: "errors.log", content: String(error) });
      }
    }
  }

  await tools.filesystem.editFile({
    path: input.root,
    edits: [{ oldText: "TODO", newText: "DONE" }],
    dryRun: false,
  });

  return listing;`);

  let graph: WorkflowGraph;

  beforeEach(async () => {
    const session = createCodeFlow({ registry: realRegistry(["filesystem", "memory"]) });
    graph = await session.analyze(SOURCE, { file: FILE });
  });

  it("resolves every real tool call — no unknown nodes", () => {
    expect(graph.diagnostics).toEqual([]);
    expect(graph.nodes.filter((n) => n.type === "unknown")).toEqual([]);
    const tools = graph.nodes.filter((n) => n.type === "tool");
    expect(tools).toHaveLength(5);
    for (const tool of tools) expect(tool.data["resolved"]).toBe(true);
  });

  it("nests the graph exactly as the source nests", () => {
    expect(paths(graph)).toEqual([
      "flow#trigger",
      "flow/call:filesystem.listDirectory[0]",
      "flow/for[0]",
      "flow/for[0]/for[0]",
      "flow/for[0]/for[0]/try[0]",
      "flow/for[0]/for[0]/try[0]/call:filesystem.readTextFile[0]",
      "flow/for[0]/for[0]/try[0]/call:memory.createEntities[0]",
      "flow/for[0]/for[0]/try[0]/catch/call:filesystem.writeFile[0]",
      "flow/call:filesystem.editFile[0]",
      "flow/return[0]",
    ]);
  });

  it("labels nodes from the MCP title, not from the slug", () => {
    // `create_entities` has no `title`, so the label is humanized (05 §3).
    expect(node(graph, "flow/for[0]/for[0]/try[0]/call:memory.createEntities[0]").label).toBe(
      "Create Entities",
    );
    // `edit_file` publishes `"title": "Edit File"`.
    expect(node(graph, "flow/call:filesystem.editFile[0]").label).toBe("Edit File");
  });

  it("carries a data edge from readTextFile into the createEntities argument", () => {
    const from = node(graph, "flow/for[0]/for[0]/try[0]/call:filesystem.readTextFile[0]");
    const to = node(graph, "flow/for[0]/for[0]/try[0]/call:memory.createEntities[0]");
    const edge = graph.edges.find(
      (e) => e.source === from.id && e.target === to.id && e.kind === "data",
    );
    expect(edge, "expected a data edge readTextFile → createEntities").toBeDefined();
  });

  it("derives inspector fields from the server's own property order", () => {
    expect(node(graph, "flow/call:filesystem.editFile[0]").inputs.map((i) => i.id)).toEqual([
      "path",
      "edits",
      "dryRun",
    ]);
  });
});

/* -------------------------------------------------------------------------- */

describe("patching a field nested two levels inside a real schema", () => {
  const SOURCE = flowSource(`  await tools.filesystem.editFile({
    path: input.root,
    edits: [{ oldText: "TODO", newText: "DONE" }],
    dryRun: false,
  });

  await tools.memory.createEntities({
    entities: [
      { name: "a", entityType: "file", observations: ["seen"] },
    ],
  });`);

  async function open() {
    const session = createCodeFlow({ registry: realRegistry(["filesystem", "memory"]) });
    const graph = await session.analyze(SOURCE, { file: FILE });
    return { session, graph };
  }

  it("rewrites only the array literal, byte for byte", async () => {
    const { session, graph } = await open();
    const result = await session.patchNode(node(graph, "flow/call:filesystem.editFile[0]").id, {
      edits: { kind: "expression", text: `[{ oldText: "FIXME", newText: "FIXED" }]` },
    });

    // Minimal: one edit, covering the value and nothing else.
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0]!.oldText).toBe(`[{ oldText: "TODO", newText: "DONE" }]`);
    expect(result.patches[0]!.newText).toBe(`[{ oldText: "FIXME", newText: "FIXED" }]`);

    // The sibling call and the surrounding formatting are untouched.
    expect(result.source).toContain(`    dryRun: false,`);
    expect(result.source).toContain(`      { name: "a", entityType: "file", observations: ["seen"] },`);
    expect(result.source.split("\n")).toHaveLength(SOURCE.split("\n").length);
  });

  it("refuses a raw object value rather than guessing how to render it", async () => {
    const { session, graph } = await open();
    const error = await session
      .patchNode(node(graph, "flow/call:filesystem.editFile[0]").id, {
        edits: [{ oldText: "FIXME", newText: "FIXED" }],
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CodeFlowError);
    expect((error as CodeFlowError).code).toBe("patch-unsupported");
  });

  it("still patches a plain scalar on the same call", async () => {
    const { session, graph } = await open();
    const result = await session.patchNode(node(graph, "flow/call:filesystem.editFile[0]").id, {
      dryRun: true,
    });
    expect(result.patches).toHaveLength(1);
    expect(result.source).toContain("dryRun: true,");
    expect(result.source).toContain(`edits: [{ oldText: "TODO", newText: "DONE" }],`);
  });

  it("re-analyzes to the same node ids after the patch (03 §5.2)", async () => {
    const { session, graph } = await open();
    const before = graph.nodes.map((n) => n.id);
    const result = await session.patchNode(node(graph, "flow/call:filesystem.editFile[0]").id, {
      dryRun: true,
    });
    expect(result.graph.nodes.map((n) => n.id)).toEqual(before);
  });
});

/* -------------------------------------------------------------------------- */

describe("a real tool with no outputSchema", () => {
  it("is a sequential step with no data edge leaving it", async () => {
    // playwright/browser_close publishes no outputSchema, so the graph gives the
    // node no output port and nothing downstream binds to it. (The signature says
    // Promise<unknown>: a value may well come back, we were simply not told what.)
    const session = createCodeFlow({ registry: realRegistry(["playwright"]) });
    const graph = await session.analyze(
      flowSource(`  await tools.playwright.browserNavigate({ url: input.root });
  await tools.playwright.browserClose({});
  await tools.playwright.browserNavigateBack({});`),
      { file: FILE },
    );

    expect(graph.diagnostics).toEqual([]);
    const close = node(graph, "flow/call:playwright.browserClose[0]");
    expect(close.outputs).toEqual([]);
    expect(graph.edges.filter((e) => e.source === close.id && e.kind === "data")).toEqual([]);
    // …but control still flows through it.
    expect(
      graph.edges.some((e) => e.source === close.id && e.kind === "control"),
    ).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */

describe("a tool whose MCP name loses information when slugged", () => {
  it("resolves through the slug and remembers the original", async () => {
    // `sequentialthinking` (one word, no separators) under a namespace that has
    // to be slugged itself: `sequential-thinking` → `sequentialThinking`.
    const registry = realRegistry(["sequential-thinking"]);
    const tool = registry.listTools()[0]!;
    expect(tool.name).toBe("sequentialThinking.sequentialthinking");

    const session = createCodeFlow({ registry });
    const graph = await session.analyze(
      flowSource(`  await tools.sequentialThinking.sequentialthinking({
    thought: "start",
    nextThoughtNeeded: true,
    thoughtNumber: 1,
    totalThoughts: 3,
  });`),
      { file: FILE },
    );
    expect(graph.diagnostics).toEqual([]);
    expect(node(graph, "flow/call:sequentialThinking.sequentialthinking[0]").data["resolved"]).toBe(
      true,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("two MCP servers mounted under one namespace", () => {
  const kebab = () => capture("filesystem").map((t) => ({ ...t, name: t.name.replace(/_/g, "-") }));

  it("refuses loudly instead of silently replacing a tool", () => {
    // Each `mcpToolsToDefinitions` call de-duplicates within itself; two
    // independent calls cannot know about each other. The registry catches it —
    // which is the right place, because a silent overwrite would make one
    // server's tool unreachable and the flow that called it an `unknown` node.
    const registry = createRegistry();
    for (const d of mcpToolsToDefinitions(capture("filesystem"), { namespace: "files" })) {
      registry.registerTool(d);
    }
    expect(() => {
      for (const d of mcpToolsToDefinitions(kebab(), { namespace: "files" })) {
        registry.registerTool(d);
      }
    }).toThrowError(/already registered/);
  });

  it("keeps both reachable when the caller threads one `taken` set", () => {
    const registry = createRegistry();
    const taken = new Set<string>();
    for (const tool of [...capture("filesystem"), ...kebab()]) {
      const definition = mcpToolToDefinition(tool, { namespace: "files", taken });
      taken.add(definition.mcp.method);
      registry.registerTool(definition);
    }
    expect(registry.listTools()).toHaveLength(capture("filesystem").length * 2);
    // `read_file` and `read-file` both survive; the second is suffixed.
    const names = registry.listTools().map((t) => t.name);
    expect(names).toContain("files.readFile");
    expect(names).toContain("files.readFile2");
  });

  it("a flow can call both colliding tools and the analyzer tells them apart", async () => {
    const registry = createRegistry();
    const taken = new Set<string>();
    for (const tool of [...capture("filesystem"), ...kebab()]) {
      const definition = mcpToolToDefinition(tool, { namespace: "files", taken });
      taken.add(definition.mcp.method);
      registry.registerTool(definition);
    }

    const session = createCodeFlow({ registry });
    const graph = await session.analyze(
      flowSource(`  const a = await tools.files.readFile({ path: input.root });
  const b = await tools.files.readFile2({ path: input.root });
  return [a, b];`),
      { file: FILE },
    );

    expect(graph.diagnostics).toEqual([]);
    expect(node(graph, "flow/call:files.readFile[0]").data["toolName"]).toBe("files.readFile");
    expect(node(graph, "flow/call:files.readFile2[0]").data["toolName"]).toBe("files.readFile2");
  });
});

/* -------------------------------------------------------------------------- */

describe("a tool that is not in the registry", () => {
  it("becomes an unknown node rather than a resolved one", async () => {
    const session = createCodeFlow({ registry: realRegistry(["memory"]) });
    const graph = await session.analyze(
      // `filesystem` is not mounted in this registry.
      flowSource(`  await tools.filesystem.readTextFile({ path: input.root });`),
      { file: FILE },
    );
    const call = graph.nodes.find((n) => n.type === "unknown" || n.data["resolved"] === false);
    expect(call, "expected an unresolved call node").toBeDefined();
  });
});
