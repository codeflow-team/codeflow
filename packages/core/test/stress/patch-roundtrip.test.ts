/**
 * The round-trip gate (11 §3.4) run against the big flows.
 *
 * The acceptance test of 08 §4 does this on a twenty-line file. The question
 * here is whether the same guarantees survive a 343-line one: edit a field on a
 * node buried inside a `try` inside three loops inside a `try`, and
 *
 *   1. exactly one region of the file changes (I3);
 *   2. every other node keeps its id (I5);
 *   3. re-running the same edit is a no-op, and a cold re-analyze of the new
 *      source agrees with the session's graph (I4).
 *
 * Then the two edits that are not field edits — inserting a node in the middle
 * of the file, and being refused a delete that would break a data dependency.
 */

import { describe, expect, it } from "vitest";

import { exampleById, fileOf, nodeAt, open, registryOf } from "./helpers.js";
import { createCodeFlow } from "../../src/session.js";
import { CodeFlowError } from "../../src/errors.js";
import { unifiedDiff } from "../harness/diff.js";
import { assertIntegrity } from "../harness/reanalyze.js";
import type { WorkflowGraph } from "../../src/model/index.js";

function idsByPath(graph: WorkflowGraph): Record<string, string> {
  const map: Record<string, string> = {};
  for (const node of graph.nodes) map[node.source.semanticPath] = node.id;
  return map;
}

/** Lines whose text differs — the readable form of "only this region moved". */
function changedLines(before: string, after: string): string[] {
  return unifiedDiff(before, after)
    .split("\n")
    .filter((line) => (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---"));
}

describe("a field edit on a node four levels deep", () => {
  /**
   * `tools.fs.readTextFile` inside:
   *   try → for(root) → for(directory) → for(entry) → try
   * which is as far from the top of the file as anything in the corpus gets —
   * and there are three other `fs.readTextFile` calls in the same file for it
   * to be confused with.
   */
  const DEEP_PATH = "flow/try[0]/for[0]/for[0]/for[0]/try[0]/call:fs.readTextFile[0]";

  it("changes exactly one line and keeps every id", async () => {
    const example = exampleById("repo-triage-bot");
    const { session, graph } = await open(example);

    const deep = nodeAt(graph, DEEP_PATH);
    expect(deep.type).toBe("tool");
    expect(deep.data["toolName"]).toBe("fs.readTextFile");

    const before = idsByPath(graph);

    const result = await session.patchNode(deep.id, { head: 120 });

    // I3 — one region, one line, and the line is the one the node owns.
    expect(result.patches).toHaveLength(1);
    const lines = changedLines(example.source, result.source);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("head: 400");
    expect(lines[1]).toContain("head: 120");

    // The two other `fs.readTextFile` calls are untouched — the classic
    // "edited the wrong identical-looking thing" failure.
    expect(result.source.split("tools.fs.readTextFile(")).toHaveLength(4);
    expect(result.source).toContain("head: 60");
    expect(result.source).toContain("/CODEOWNERS");

    // I5 — nothing else moved.
    assertIntegrity(result.graph);
    const after = idsByPath(result.graph);
    for (const [path, id] of Object.entries(before)) {
      expect(after[path], path).toBe(id);
    }
  });

  it("is idempotent, and a cold re-analyze agrees with the session (I4)", async () => {
    const example = exampleById("repo-triage-bot");
    const { session, graph } = await open(example);
    const deep = nodeAt(graph, DEEP_PATH);

    const first = await session.patchNode(deep.id, { head: 120 });

    // The same edit again writes nothing (I4 — an empty edit is zero bytes).
    const again = await session.patchNode(deep.id, { head: 120 });
    expect(again.patches).toEqual([]);
    expect(again.source).toBe(first.source);

    // A cold analyze of the patched source produces the same graph shape.
    const cold = createCodeFlow({ registry: registryOf(example) });
    const coldGraph = await cold.analyze(first.source, { file: fileOf(example) });
    expect(coldGraph.nodes.map((node) => node.source.semanticPath).sort()).toEqual(
      first.graph.nodes.map((node) => node.source.semanticPath).sort(),
    );
    expect(coldGraph.edges).toHaveLength(first.graph.edges.length);
    expect(coldGraph.diagnostics).toHaveLength(first.graph.diagnostics.length);
  });

  it("rewrites a whole nested argument without touching its siblings", async () => {
    const example = exampleById("repo-triage-bot");
    const { session, graph } = await open(example);

    // `memory.createEntities` in the `high` branch, five levels down, whose
    // only editable field is an array of objects spread over six lines.
    const deep = nodeAt(
      graph,
      "flow/try[0]/for[0]/for[0]/for[0]/try[0]/if[1]/call:memory.createEntities[0]",
    );

    const result = await session.patchNode(deep.id, {
      entities: {
        kind: "expression",
        text: '[{ name: candidate, entityType: "hazard", observations: verdict.reasons }]',
      },
    });

    expect(result.patches).toHaveLength(1);
    expect(result.source).toContain('entityType: "hazard"');
    // The `createRelations` call two statements below passes a structurally
    // identical literal and must be byte-identical afterwards.
    expect(result.source).toContain('relationType: "has-high-risk-file"');
    expect(result.source).toContain("from: input.repository,");
    assertIntegrity(result.graph);
  });

  it("touches nothing outside the edited property", async () => {
    const example = exampleById("browser-qa-runner");
    const { session, graph } = await open(example);

    // The screenshot taken in the step `catch`, five levels down, whose
    // argument object holds four fields.
    const shot = graph.nodes.find(
      (node) =>
        node.data["toolName"] === "browser.takeScreenshot" &&
        String(node.source.semanticPath).includes("try[0]/catch"),
    );
    expect(shot).toBeDefined();

    const result = await session.patchNode(shot!.id, { type: "jpeg" });

    expect(result.patches).toHaveLength(1);
    const lines = changedLines(example.source, result.source);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('type: "png"');
    expect(lines[1]).toContain('type: "jpeg"');

    // Everything else — including the other takeScreenshot call — is
    // byte-for-byte what it was.
    expect(result.source.split('scale: "device"')).toHaveLength(2);
    expect(result.source.split("fullPage: true")).toHaveLength(2);
    expect(result.source.split('type: "png"')).toHaveLength(2);
  });
});

describe("inserting a node in the middle of a long flow", () => {
  it("adds one statement, one node, and leaves every existing id alone", async () => {
    const example = exampleById("research-agent");
    const { session, graph } = await open(example);

    const anchor = graph.nodes.find(
      (node) => node.data["toolName"] === "memory.createRelations",
    );
    expect(anchor).toBeDefined();

    const before = idsByPath(graph);
    const beforeIds = new Set(graph.nodes.map((node) => node.id));

    const result = await session.patchNode(anchor!.id, {
      $insert: {
        tool: "memory.addObservations",
        where: "after",
        variable: "audit",
        arguments: {
          observations: {
            kind: "expression",
            text: '[{ entityName: input.topic, contents: ["linked"] }]',
          },
        },
      },
    });

    expect(result.patches).toHaveLength(1);
    expect(result.source).toContain("const audit = await tools.memory.addObservations(");
    expect(result.graph.nodes).toHaveLength(graph.nodes.length + 1);

    // Every previous node survives with its id...
    const survivors = result.graph.nodes.filter((node) => beforeIds.has(node.id));
    expect(survivors).toHaveLength(graph.nodes.length);

    // ...and the ones *after* the insertion point, whose semantic paths all
    // shifted by one, kept theirs too.
    const after = idsByPath(result.graph);
    const anchorPath = anchor!.source.semanticPath;
    expect(after[anchorPath]).toBe(before[anchorPath]);

    // The new statement parses, resolves, and is not flagged.
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const inserted = result.graph.nodes.find((node) => !beforeIds.has(node.id));
    expect(inserted?.type).toBe("tool");
    expect(inserted?.data["toolName"]).toBe("memory.addObservations");
    expect(inserted?.data["needsConfiguration"]).toBeUndefined();
  });

  it("re-analyzing the inserted source cold reproduces the same graph shape", async () => {
    const example = exampleById("research-agent");
    const { session, graph } = await open(example);
    const anchor = graph.nodes.find((node) => node.data["toolName"] === "memory.createRelations")!;

    const result = await session.patchNode(anchor.id, {
      $insert: {
        tool: "memory.addObservations",
        where: "after",
        variable: "audit",
        arguments: {
          observations: {
            kind: "expression",
            text: '[{ entityName: input.topic, contents: ["linked"] }]',
          },
        },
      },
    });

    const cold = createCodeFlow({ registry: registryOf(example) });
    const coldGraph = await cold.analyze(result.source, { file: fileOf(example) });
    expect(coldGraph.nodes).toHaveLength(result.graph.nodes.length);
    expect(coldGraph.edges).toHaveLength(result.graph.edges.length);
  });
});

describe("deleting a node the rest of the flow depends on", () => {
  it("is refused, and names what depends on it (06 §2)", async () => {
    const example = exampleById("data-pipeline");
    const { session, graph } = await open(example);

    // `const inbox = await tools.fs.listDirectory(...)` — the very first step,
    // whose `inbox` binding the next statement reads.
    const producer = graph.nodes.find((node) => node.data["toolName"] === "fs.listDirectory");
    expect(producer).toBeDefined();

    const error = await session
      .patchNode(producer!.id, { $delete: true })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CodeFlowError);
    expect((error as CodeFlowError).message).toMatch(/inbox/);

    // Refused means refused: the session still holds the original graph and no
    // byte of the source moved.
    expect(session.getGraph()?.source.content).toBe(example.source);
  });

  it("allows the delete once nothing reads the binding", async () => {
    const example = exampleById("data-pipeline");
    const session = createCodeFlow({ registry: registryOf(example) });
    const file = fileOf(example);

    // A tool call whose result nobody binds: the progress `echo` at the end of
    // the drop loop.
    const graph = await session.analyze(example.source, { file });
    const echo = graph.nodes.find(
      (node) =>
        node.data["toolName"] === "everything.echo" &&
        node.source.semanticPath === "flow/for[0]/call:everything.echo[0]",
    );
    expect(echo).toBeDefined();

    const result = await session.patchNode(echo!.id, { $delete: true });

    expect(result.graph.nodes).toHaveLength(graph.nodes.length - 1);
    expect(example.source.split("tools.everything.echo(")).toHaveLength(6);
    expect(result.source.split("tools.everything.echo(")).toHaveLength(5);
    expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    assertIntegrity(result.graph);
  });
});

describe("five patches in a row on one long flow", () => {
  it("each lands where it should and no id is lost along the way", async () => {
    const example = exampleById("browser-qa-runner");
    const { session, graph } = await open(example);

    const original = idsByPath(graph);
    let source = example.source;

    const edits: { toolName: string; changes: Record<string, unknown> }[] = [
      { toolName: "browser.resize", changes: { width: 1440 } },
      { toolName: "browser.waitFor", changes: { text: "app-ready" } },
      { toolName: "browser.consoleMessages", changes: { level: "warning" } },
      { toolName: "browser.networkRequests", changes: { filter: "fetch" } },
      {
        toolName: "fs.createDirectory",
        changes: { path: { kind: "expression", text: "`${input.artifactDir}/run`" } },
      },
    ];

    for (const edit of edits) {
      const current = session.getGraph()!;
      const node = current.nodes.find((candidate) => candidate.data["toolName"] === edit.toolName);
      expect(node, edit.toolName).toBeDefined();
      const result = await session.patchNode(node!.id, edit.changes);
      expect(result.patches.length, edit.toolName).toBe(1);
      source = result.source;
      assertIntegrity(result.graph);
    }

    expect(source).toContain("width: 1440");
    expect(source).toContain('text: "app-ready"');
    expect(source).toContain('level: "warning"');
    expect(source).toContain('filter: "fetch"');
    expect(source).toContain("path: `${input.artifactDir}/run`");

    // Every node of the original graph still carries its original id.
    const final = idsByPath(session.getGraph()!);
    for (const [path, id] of Object.entries(original)) {
      expect(final[path], path).toBe(id);
    }
  });
});
