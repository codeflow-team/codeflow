/**
 * I2 — determinism on the cold-analyze path (11 §2, 03 §5.0).
 *
 * Same (source, registry) → same graph, node ids included. And identity is
 * structural, not textual: reformatting the canonical flow, adding comments and
 * unicode must leave every node id untouched.
 */

import { describe, expect, it } from "vitest";
import { analyzeSource } from "../src/analyzer/index.js";
import { createCodeFlow } from "../src/index.js";
import { loadFixture, listFixtures } from "./harness/fixture.js";

describe("I2 — cold analyze is deterministic", () => {
  for (const name of listFixtures()) {
    it(`${name}: two independent analyses are byte-identical`, () => {
      const first = loadFixture(name);
      const second = loadFixture(name);
      const a = analyzeSource(first.source, first.registry, first.options);
      const b = analyzeSource(second.source, second.registry, second.options);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    });
  }

  it("a fresh session produces the same graph as a standalone cold analyze", async () => {
    const fixture = loadFixture("01-canonical");
    const direct = analyzeSource(fixture.source, fixture.registry, fixture.options);
    const session = createCodeFlow({ registry: fixture.registry });
    const viaSession = await session.analyze(fixture.source, fixture.options);
    expect(JSON.stringify(viaSession)).toBe(JSON.stringify(direct));
  });

  it("re-analyzing in a session bumps version but keeps cold ids (phase 2)", async () => {
    const fixture = loadFixture("01-canonical");
    const session = createCodeFlow({ registry: fixture.registry });
    const first = await session.analyze(fixture.source, fixture.options);
    const second = await session.analyze(fixture.source, fixture.options);
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    expect(second.nodes.map((n) => n.id)).toEqual(first.nodes.map((n) => n.id));
    expect(session.getGraph()).toBe(second);
  });
});

describe("I2 — identity survives formatting, comments and unicode", () => {
  it("23-weird-formatting has exactly the node ids of 01-canonical", () => {
    const canonical = loadFixture("01-canonical");
    const weird = loadFixture("23-weird-formatting-comments-unicode");

    const a = analyzeSource(canonical.source, canonical.registry, canonical.options);
    const b = analyzeSource(weird.source, weird.registry, weird.options);

    expect(b.nodes.map((n) => n.id).sort()).toEqual(a.nodes.map((n) => n.id).sort());
    expect(b.nodes.map((n) => n.source.semanticPath).sort()).toEqual(
      a.nodes.map((n) => n.source.semanticPath).sort(),
    );
    expect(b.edges.map((e) => e.id).sort()).toEqual(a.edges.map((e) => e.id).sort());
    expect(b.nodes.map((n) => n.type).sort()).toEqual(a.nodes.map((n) => n.type).sort());
  });

  it("but source ranges legitimately differ", () => {
    const canonical = loadFixture("01-canonical");
    const weird = loadFixture("23-weird-formatting-comments-unicode");
    const a = analyzeSource(canonical.source, canonical.registry, canonical.options);
    const b = analyzeSource(weird.source, weird.registry, weird.options);
    const byPath = new Map(b.nodes.map((n) => [n.source.semanticPath, n]));
    const slack = a.nodes.find((n) => n.source.semanticPath.endsWith("call:slack.send[0]"));
    expect(slack).toBeDefined();
    expect(byPath.get(slack!.source.semanticPath)!.source.start.offset).not.toBe(
      slack!.source.start.offset,
    );
  });

  it("adding an unrelated statement keeps the ids of everything before it", () => {
    const fixture = loadFixture("14-no-return-synthetic-output");
    const before = analyzeSource(fixture.source, fixture.registry, fixture.options);
    const patched = fixture.source.replace(
      "  await tools.slack.send",
      "  // an unrelated comment\n  await tools.slack.send",
    );
    const after = analyzeSource(patched, fixture.registry, fixture.options);
    expect(after.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
  });
});
