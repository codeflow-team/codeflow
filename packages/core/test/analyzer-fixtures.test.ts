/**
 * Golden fixture corpus — 11-testing.md §3.2, and the invariants it guards.
 *
 * Regenerate the goldens (then READ every diff) with:
 *     CODEFLOW_REGEN=1 npx vitest run test/analyzer-fixtures.test.ts
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/analyzer/index.js";
import { coldNodeId, computeEdgeId, computeGraphId } from "../src/mapper/index.js";
import { sha256Hex } from "../src/util/sha256.js";
import { FIXTURE_FILE, listFixtures, loadFixture, normalizeGraph } from "./harness/fixture.js";
import { checkStatementOwnership } from "./harness/invariants.js";

const REGENERATE = process.env["CODEFLOW_REGEN"] === "1";
const HEX64 = /^[0-9a-f]{64}$/;

const names = listFixtures();

describe("golden fixture corpus", () => {
  it("has the expected cases", () => {
    expect(names.length).toBeGreaterThanOrEqual(33);
    expect(names).toContain("01-canonical");
  });

  for (const name of names) {
    describe(name, () => {
      const fixture = loadFixture(name);
      const graph = analyzeSource(fixture.source, fixture.registry, fixture.options);
      const normalized = normalizeGraph(graph);

      if (REGENERATE) {
        writeFileSync(
          join(fixture.dir, "expected-graph.json"),
          `${JSON.stringify(normalized, null, 2)}\n`,
          "utf8",
        );
      }

      it("matches the reviewed expected graph", () => {
        expect(existsSync(join(fixture.dir, "expected-graph.json"))).toBe(true);
        const expected = loadFixture(name).expected;
        expect(normalized).toEqual(expected);
      });

      it("derives graph/source/registry metadata correctly", () => {
        const contentHash = sha256Hex(fixture.source);
        expect(graph.source).toEqual({
          file: FIXTURE_FILE,
          content: fixture.source,
          contentHash,
        });
        expect(graph.registryHash).toBe(fixture.registry.registryHash());
        expect(graph.version).toBe(1);
        expect(graph.id).toBe(computeGraphId(FIXTURE_FILE, contentHash, graph.registryHash));
      });

      it("derives every node id from its semantic path (I2, 03 §5.0)", () => {
        const paths = new Set<string>();
        const ids = new Set<string>();
        for (const node of graph.nodes) {
          expect(node.id).toBe(coldNodeId(node.source.semanticPath));
          expect(node.source.file).toBe(FIXTURE_FILE);
          expect(node.source.fingerprint).toMatch(HEX64);
          expect(paths.has(node.source.semanticPath)).toBe(false);
          expect(ids.has(node.id)).toBe(false);
          paths.add(node.source.semanticPath);
          ids.add(node.id);
        }
      });

      it("derives every edge id from its endpoints and ports", () => {
        const ids = new Set<string>();
        const nodeIds = new Set(graph.nodes.map((node) => node.id));
        for (const edge of graph.edges) {
          expect(edge.id).toBe(
            computeEdgeId(edge.source, edge.target, edge.kind, edge.sourcePort, edge.targetPort),
          );
          expect(nodeIds.has(edge.source)).toBe(true);
          expect(nodeIds.has(edge.target)).toBe(true);
          expect(ids.has(edge.id)).toBe(false);
          ids.add(edge.id);
        }
      });

      it("I1 — every flow statement belongs to exactly one node", () => {
        expect(checkStatementOwnership(fixture.source, graph, FIXTURE_FILE)).toEqual([]);
      });

      it("I2 — analyzing twice is byte-identical, ids included", () => {
        const again = analyzeSource(fixture.source, fixture.registry, fixture.options);
        expect(JSON.stringify(again)).toBe(JSON.stringify(graph));
      });

      it("source ranges are well formed", () => {
        for (const node of graph.nodes) {
          expect(node.source.start.offset).toBeLessThanOrEqual(node.source.end.offset);
          expect(node.source.end.offset).toBeLessThanOrEqual(fixture.source.length);
          expect(node.source.start.line).toBeGreaterThanOrEqual(1);
          expect(node.source.start.column).toBeGreaterThanOrEqual(1);
        }
      });
    });
  }
});
