/**
 * Round-trip suite — the most important gate of the project (11 §3.4, 08 §4).
 *
 *     Code → Graph → Edit → Code' → Graph'
 *
 * For every fixture × every edit case:
 *
 *   1. the diff is exactly the reviewed one, not one character more (I3);
 *   2. the new graph differs only in the node that was edited, and every other
 *      node keeps its id (I4/I5);
 *   3. running the loop again is stable, and an empty edit changes nothing (I4).
 *
 * Regenerate the expected diffs (then READ every one of them) with:
 *     CODEFLOW_REGEN=1 npx vitest run test/roundtrip.test.ts
 */

import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/analyzer/index.js";
import { CodeFlowError } from "../src/errors.js";
import { createCodeFlow } from "../src/session.js";
import type { GraphChange, WorkflowGraph, WorkflowNode } from "../src/model/index.js";
import { unifiedDiff } from "./harness/diff.js";
import { listEdits, type EditCase } from "./harness/edits.js";
import { listFixtures, loadFixture, normalizeGraph, type Fixture } from "./harness/fixture.js";

const REGENERATE = process.env["CODEFLOW_REGEN"] === "1";

function nodeByPath(graph: WorkflowGraph, path: string): WorkflowNode {
  const node = graph.nodes.find((candidate) => candidate.source.semanticPath === path);
  expect(node, `no node at ${path}`).toBeDefined();
  return node!;
}

/** Node changes that go beyond a moved source range (I4). */
function substantiveUpdates(changes: readonly GraphChange[], graph: WorkflowGraph): string[] {
  const paths: string[] = [];
  for (const change of changes) {
    if (change.type !== "node.updated" || change.changes === undefined) continue;
    const fields = Object.keys(change.changes).filter((field) => field !== "source");
    if (fields.length === 0) continue;
    const node = graph.nodes.find((candidate) => candidate.id === change.nodeId);
    paths.push(node?.source.semanticPath ?? String(change.nodeId));
  }
  return paths.sort();
}

/** Text outside the patched ranges, which must survive byte for byte (I3). */
function outside(source: string, ranges: Array<{ start: number; end: number }>): string {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const range of sorted) {
    out += source.slice(cursor, range.start);
    cursor = range.end;
  }
  return out + source.slice(cursor);
}

async function analyzeFixture(fixture: Fixture) {
  const session = createCodeFlow({ registry: fixture.registry });
  const graph = await session.analyze(fixture.source, fixture.options);
  return { session, graph };
}

const fixtures = listFixtures().map((name) => loadFixture(name));
const withEdits = fixtures
  .map((fixture) => ({ fixture, edits: listEdits(fixture.dir, fixture.name) }))
  .filter((entry) => entry.edits.length > 0);

describe("round-trip suite", () => {
  it("covers at least twelve fixtures", () => {
    expect(withEdits.length).toBeGreaterThanOrEqual(12);
  });

  for (const { fixture, edits } of withEdits) {
    describe(fixture.name, () => {
      for (const edit of edits) {
        describe(`${edit.name} — ${edit.description}`, () => {
          runEdit(fixture, edit);
        });
      }

      it("empty edit changes nothing — not one byte (I4)", async () => {
        const { session, graph } = await analyzeFixture(fixture);
        const node = nodeByPath(graph, edits[0].node);
        const result = await session.patchNode(node.id, {});
        expect(result.source).toBe(fixture.source);
        expect(result.patches).toEqual([]);
        expect(result.changes).toEqual([]);
        expect(result.graph).toBe(graph);
      });
    });
  }
});

function runEdit(fixture: Fixture, edit: EditCase): void {
  if (edit.error !== undefined) {
    it(`is refused: ${edit.error.code}`, async () => {
      const { session, graph } = await analyzeFixture(fixture);
      const node = nodeByPath(graph, edit.node);
      const error = await session.patchNode(node.id, edit.changes).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CodeFlowError);
      expect((error as CodeFlowError).code).toBe(edit.error!.code);
      if (edit.error!.message !== undefined) {
        expect((error as CodeFlowError).message).toContain(edit.error!.message);
      }
      // A refused patch leaves the session exactly where it was.
      expect(session.getGraph()).toBe(graph);
      expect(session.getGraph()!.source.content).toBe(fixture.source);
    });
    return;
  }

  it("produces exactly the reviewed diff (I3)", async () => {
    const { session, graph } = await analyzeFixture(fixture);
    const node = nodeByPath(graph, edit.node);
    const result = await session.patchNode(node.id, edit.changes);

    const diff = unifiedDiff(fixture.source, result.source);
    if (REGENERATE) writeFileSync(edit.diffPath, diff, "utf8");
    expect(edit.expectedDiff, `missing ${edit.diffPath}`).not.toBeNull();
    expect(diff).toBe(edit.expectedDiff);
    expect(diff.length, "an edit that changes nothing needs no fixture").toBeGreaterThan(0);
  });

  it("touches only the patched ranges, byte for byte (I3)", async () => {
    const { session, graph } = await analyzeFixture(fixture);
    const node = nodeByPath(graph, edit.node);
    const result = await session.patchNode(node.id, edit.changes);

    const ranges = result.patches.map((patch) => ({
      start: patch.range.start.offset,
      end: patch.range.end.offset,
    }));
    for (const patch of result.patches) {
      expect(fixture.source.slice(patch.range.start.offset, patch.range.end.offset)).toBe(patch.oldText);
      expect(patch.oldText).not.toBe(patch.newText);
    }
    // Ranges are ordered and never overlap (03 §11).
    for (let index = 1; index < ranges.length; index++) {
      expect(ranges[index].start).toBeGreaterThanOrEqual(ranges[index - 1].end);
    }
    // Reapplying the patches to the original reproduces the result exactly…
    let rebuilt = "";
    let cursor = 0;
    for (const patch of result.patches) {
      rebuilt += fixture.source.slice(cursor, patch.range.start.offset);
      rebuilt += patch.newText;
      cursor = patch.range.end.offset;
    }
    rebuilt += fixture.source.slice(cursor);
    expect(rebuilt).toBe(result.source);
    // …and everything outside those ranges is untouched.
    const newRanges: Array<{ start: number; end: number }> = [];
    let shift = 0;
    for (const patch of result.patches) {
      const start = patch.range.start.offset + shift;
      newRanges.push({ start, end: start + patch.newText.length });
      shift += patch.newText.length - (patch.range.end.offset - patch.range.start.offset);
    }
    expect(outside(result.source, newRanges)).toBe(outside(fixture.source, ranges));
  });

  it("keeps every other node's identity and leaves the rest of the graph alone (I4/I5)", async () => {
    const { session, graph } = await analyzeFixture(fixture);
    const node = nodeByPath(graph, edit.node);
    const before = new Set(graph.nodes.map((candidate) => candidate.id));

    const result = await session.patchNode(node.id, edit.changes);
    const after = new Set(result.graph.nodes.map((candidate) => candidate.id));

    const removed = result.changes.filter((change) => change.type === "node.removed");
    const added = result.changes.filter((change) => change.type === "node.added");
    expect(removed.length).toBe(edit.expectRemoved ?? 0);
    expect(added.length).toBe(edit.expectAdded ?? 0);

    const removedIds = new Set(removed.map((change) => change.nodeId));
    for (const id of before) {
      if (removedIds.has(id)) continue;
      expect(after.has(id), `node ${id} lost its identity`).toBe(true);
    }
    // Ids are never recycled: an added node gets a genuinely new id.
    for (const change of added) expect(before.has(String(change.nodeId))).toBe(false);

    const expected = (
      edit.expectUpdated ?? [
        ...(edit.alsoUpdated ?? []),
        ...(removedIds.has(node.id) ? [] : [edit.updatedAs ?? edit.node]),
      ]
    ).sort();
    expect(substantiveUpdates(result.changes, result.graph)).toEqual(expected);

    if (edit.diagnostics !== undefined) {
      expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(edit.diagnostics);
    }
  });

  it("re-analyzes to the same graph and stays stable on a second round (I4)", async () => {
    const { session, graph } = await analyzeFixture(fixture);
    const node = nodeByPath(graph, edit.node);
    const result = await session.patchNode(node.id, edit.changes);

    // The session graph and a cold analysis of the patched source describe the
    // same workflow; only ids may differ (03 §5.0 — continuity vs determinism).
    const cold = analyzeSource(result.source, fixture.registry, fixture.options);
    expect(normalizeGraph(result.graph)).toEqual(normalizeGraph(cold));

    // Cold analysis of the patched source is itself deterministic (I2).
    const again = analyzeSource(result.source, fixture.registry, fixture.options);
    expect(JSON.stringify(again)).toBe(JSON.stringify(cold));

    if (edit.idempotent === false) return;
    const repeated = await session.patchNode(
      nodeByPath(result.graph, edit.updatedAs ?? edit.node).id,
      edit.changes,
    );
    expect(repeated.patches).toEqual([]);
    expect(repeated.source).toBe(result.source);
  });
}
