/**
 * Graph diff — 03-data-model.md §10, 04-analyzer.md §4.
 *
 * The diff is what a session emits after a re-analyze so the UI can update
 * incrementally (07 §7). It is taken after identity resolution, which is what
 * makes it small: without carried ids every re-analyze would read as a complete
 * replacement.
 */

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/analyzer/index.js";
import { diffGraphs, diffNode } from "../src/diff/index.js";
import { createCodeFlow } from "../src/session.js";
import { createSampleRegistry } from "./fixtures.js";
import { changesOf, flowSource, idsOf, nodeByPath, reanalyze } from "./harness/reanalyze.js";

const BASE = flowSource(
  `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#security", message: "Auth change detected" });`,
);

/* -------------------------------------------------------------------------- */
/* k — an unchanged re-analyze                                                 */
/* -------------------------------------------------------------------------- */

describe("k — analyzing the same source twice in a session", () => {
  it("produces identical ids and an empty diff", async () => {
    const session = createCodeFlow({ registry: createSampleRegistry() });
    const first = await session.analyze(BASE);
    const second = await session.analyze(BASE);

    expect(idsOf(second)).toEqual(idsOf(first));
    expect(second.edges.map((edge) => edge.id)).toEqual(first.edges.map((edge) => edge.id));
    expect(session.lastChanges()).toEqual([]);
    expect(second.version).toBe(2);
    expect(session.getGraph()).toBe(second);
  });

  it("stays empty over repeated analyses", async () => {
    const session = createCodeFlow({ registry: createSampleRegistry() });
    await session.analyze(BASE);
    for (let round = 0; round < 3; round++) {
      await session.analyze(BASE);
      expect(session.lastChanges()).toEqual([]);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* session surface                                                             */
/* -------------------------------------------------------------------------- */

describe("session diff surface", () => {
  it("has no changes and no resolution before or on the first analyze", async () => {
    const session = createCodeFlow({ registry: createSampleRegistry() });
    expect(session.lastChanges()).toEqual([]);
    expect(session.lastResolution()).toBeNull();

    await session.analyze(BASE);
    // The first analyze is cold: the whole graph is the result, there is nothing
    // to diff it against (03 §5.0).
    expect(session.lastChanges()).toEqual([]);
    expect(session.lastResolution()).toBeNull();
  });

  it("hands out a copy, so a caller cannot corrupt session state", async () => {
    const session = createCodeFlow({ registry: createSampleRegistry() });
    await session.analyze(BASE);
    await session.analyze(flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });`));
    const changes = session.lastChanges();
    expect(changes.length).toBeGreaterThan(0);
    changes.length = 0;
    expect(session.lastChanges().length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------------------------------- */
/* change kinds                                                                */
/* -------------------------------------------------------------------------- */

describe("node changes", () => {
  it("reports an addition with the new node id", async () => {
    const after = flowSource(
      `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#security", message: "Auth change detected" });
  await tools.slack.send({ channel: "#ops", message: "done" });`,
    );
    const { after: second, changes } = await reanalyze(BASE, after);
    const added = changesOf(changes, "node.added");
    expect(added).toHaveLength(1);
    expect(added[0].nodeId).toBe(nodeByPath(second, "flow/call:slack.send[1]").id);
    expect(added[0].changes).toBeUndefined();
  });

  it("reports a removal with the old node id", async () => {
    const after = flowSource(`  const prs = await tools.github.getNewPRs({ repo: input.repository });`);
    const { before: first, changes } = await reanalyze(BASE, after);
    const removed = changesOf(changes, "node.removed");
    expect(removed.map((change) => change.nodeId)).toContain(
      nodeByPath(first, "flow/call:slack.send[0]").id,
    );
  });

  it("reports an update as a shallow field diff carrying from/to", async () => {
    const after = flowSource(
      `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#engineering", message: "Auth change detected" });`,
    );
    const { before: first, changes } = await reanalyze(BASE, after);
    const slack = nodeByPath(first, "flow/call:slack.send[0]");
    const update = changesOf(changes, "node.updated").find((change) => change.nodeId === slack.id);

    expect(update).toBeDefined();
    const fields = update!.changes as Record<string, { from: unknown; to: unknown }>;
    expect(Object.keys(fields).sort()).toEqual(["data", "source"]);
    expect((fields["data"].from as Record<string, unknown>)["argumentText"]).toContain("#security");
    expect((fields["data"].to as Record<string, unknown>)["argumentText"]).toContain("#engineering");
  });

  it("survives a tool leaving the registry: same node, now unknown", async () => {
    const registry = createSampleRegistry();
    const session = createCodeFlow({ registry });
    const first = await session.analyze(BASE);
    const slack = nodeByPath(first, "flow/call:slack.send[0]");
    expect(slack.type).toBe("tool");

    registry.unregisterTool("slack.send");
    const second = await session.analyze(BASE);

    const carrier = second.nodes.find((node) => node.id === slack.id);
    expect(carrier?.type).toBe("unknown");
    const update = session
      .lastChanges()
      .find((change) => change.type === "node.updated" && change.nodeId === slack.id);
    expect(Object.keys(update?.changes ?? {})).toContain("type");
  });
});

describe("edge changes", () => {
  it("reports removed and added edges when the control flow is rewired", async () => {
    const after = flowSource(
      `  await tools.slack.send({ channel: "#security", message: "Auth change detected" });
  const prs = await tools.github.getNewPRs({ repo: input.repository });`,
    );
    const { before: first, after: second, changes } = await reanalyze(BASE, after);

    const removed = new Set(changesOf(changes, "edge.removed").map((change) => change.edgeId));
    const added = new Set(changesOf(changes, "edge.added").map((change) => change.edgeId));
    expect(removed.size).toBeGreaterThan(0);
    expect(added.size).toBeGreaterThan(0);

    const beforeEdges = new Set(first.edges.map((edge) => edge.id));
    const afterEdges = new Set(second.edges.map((edge) => edge.id));
    for (const id of removed) expect(afterEdges.has(id!)).toBe(false);
    for (const id of added) expect(beforeEdges.has(id!)).toBe(false);
  });

  it("does not report edges that kept both endpoints", async () => {
    const after = flowSource(
      `  const prs = await tools.github.getNewPRs({ repo: input.repository });
  await tools.slack.send({ channel: "#engineering", message: "Auth change detected" });`,
    );
    const { changes } = await reanalyze(BASE, after);
    expect(changesOf(changes, "edge.added")).toEqual([]);
    expect(changesOf(changes, "edge.removed")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* diffGraphs / diffNode as functions                                          */
/* -------------------------------------------------------------------------- */

describe("diffGraphs", () => {
  const registry = createSampleRegistry();

  it("is deterministic and ordered: removals, additions, updates, then edges", () => {
    const first = analyzeSource(BASE, registry);
    const second = analyzeSource(
      flowSource(`  await tools.github.getFiles({ pr: input.repository });`),
      registry,
    );
    const once = diffGraphs(first, second);
    expect(diffGraphs(first, second)).toEqual(once);

    const order = ["node.removed", "node.added", "node.updated", "edge.removed", "edge.added"];
    const indexes = once.map((change) => order.indexOf(change.type));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("reports nothing for a graph compared with itself", () => {
    const graph = analyzeSource(BASE, registry);
    expect(diffGraphs(graph, graph)).toEqual([]);
  });

  it("without identity resolution a re-analyze looks like a full replacement", () => {
    // Why resolution has to run first: cold ids are keyed on the semantic path,
    // so inserting a call ahead of another renames it.
    const first = analyzeSource(
      flowSource(`  await tools.slack.send({ channel: "#security", message: "one" });`),
      registry,
    );
    const second = analyzeSource(
      flowSource(
        `  await tools.slack.send({ channel: "#ops", message: "two" });
  await tools.slack.send({ channel: "#security", message: "one" });`,
      ),
      registry,
    );
    const raw = diffGraphs(first, second);
    expect(raw.some((change) => change.type === "node.updated")).toBe(true);
    // …whereas the session path reports one clean addition (see identity.test.ts).
    expect(raw.filter((change) => change.type === "node.added")).toHaveLength(1);
  });
});

describe("diffNode", () => {
  const registry = createSampleRegistry();

  it("returns null when nothing changed", () => {
    const graph = analyzeSource(BASE, registry);
    const node = nodeByPath(graph, "flow/call:slack.send[0]");
    expect(diffNode(node, node)).toBeNull();
  });

  it("compares canonically — key order is not a change", () => {
    const graph = analyzeSource(BASE, registry);
    const node = nodeByPath(graph, "flow/call:slack.send[0]");
    const reordered = {
      ...node,
      data: Object.fromEntries(Object.entries(node.data).reverse()),
    };
    expect(diffNode(node, reordered)).toBeNull();
  });

  it("reports each changed top-level field once", () => {
    const graph = analyzeSource(BASE, registry);
    const node = nodeByPath(graph, "flow/call:slack.send[0]");
    const renamed = { ...node, label: "Something Else" };
    expect(diffNode(node, renamed)).toEqual({
      label: { from: node.label, to: "Something Else" },
    });
  });
});
