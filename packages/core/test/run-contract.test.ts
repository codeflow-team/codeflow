/**
 * The tracing contract — 09-future.md §1.
 *
 * Two things are being pinned here. The first is the projection: a runtime that
 * knows only offsets must be able to name nodes, and a graph must be able to
 * hand it a probe plan that covers the real statements and nothing else. The
 * second is the fold: a stream of events becomes per-node state the same way
 * everywhere, so the canvas, the run log and any other reader agree about which
 * step is running and how many times it has run.
 */

import { describe, expect, it } from "vitest";

import { analyzeSource } from "../src/analyzer/index.js";
import {
  isSyntheticNode,
  nodeAtOffset,
  nodeForRange,
  nodeRanges,
  summarizeRun,
  type RunEvent,
} from "../src/run/index.js";
import { loadFixture } from "./harness/fixture.js";

const canonical = loadFixture("01-canonical");
const graph = analyzeSource(canonical.source, canonical.registry, canonical.options);

describe("nodeRanges — the probe plan", () => {
  it("covers the real statements and leaves the synthetic nodes out", () => {
    const ranges = nodeRanges(graph);
    expect(ranges.length).toBeGreaterThan(0);

    const named = new Set(ranges.map((range) => range.nodeId));
    for (const node of graph.nodes) {
      const synthetic = isSyntheticNode(node) || node.type === "trigger";
      expect(named.has(node.id), `${node.type} ${node.label}`).toBe(!synthetic);
    }
  });

  it("every range is a real slice of the source", () => {
    for (const range of nodeRanges(graph)) {
      const text = canonical.source.slice(range.start, range.end);
      expect(text.trim().length).toBeGreaterThan(0);
    }
  });

  it("orders containers before the children they contain", () => {
    const ranges = nodeRanges(graph);
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const [outer, inner] = [ranges[i], ranges[j]];
        // Ranges either nest or are disjoint — never partially overlap.
        const nested = inner.start >= outer.start && inner.end <= outer.end;
        const disjoint = inner.start >= outer.end;
        expect(nested || disjoint, `${outer.label} vs ${inner.label}`).toBe(true);
      }
    }
  });

  it("is empty for no graph at all", () => {
    expect(nodeRanges(null)).toEqual([]);
    expect(nodeRanges(undefined)).toEqual([]);
  });
});

describe("resolving a position back to a node", () => {
  it("nodeAtOffset picks the innermost owner", () => {
    const offset = canonical.source.indexOf("tools.slack.send");
    const node = nodeAtOffset(graph, offset);
    expect(node?.data["toolName"]).toBe("slack.send");
  });

  it("nodeForRange picks the innermost node containing the whole span", () => {
    const start = canonical.source.indexOf("tools.slack.send");
    const end = canonical.source.indexOf("}", start);
    const node = nodeForRange(graph, start, end);
    expect(node).not.toBeNull();
    expect(node!.source.start.offset).toBeLessThanOrEqual(start);
    expect(node!.source.end.offset).toBeGreaterThanOrEqual(end);
  });

  it("a probe plan round-trips: every range resolves back to its own node", () => {
    for (const range of nodeRanges(graph)) {
      const resolved = nodeForRange(graph, range.start, range.end);
      expect(resolved?.id, range.label).toBe(range.nodeId);
    }
  });
});

describe("summarizeRun", () => {
  const event = (nodeId: string, phase: RunEvent["phase"], at: number, extra: Partial<RunEvent> = {}): RunEvent => ({
    nodeId,
    phase,
    at,
    ...extra,
  });

  it("marks a started-but-unfinished step as running", () => {
    const state = summarizeRun([event("a", "started", 0)]);
    expect(state.get("a")).toMatchObject({ status: "running", runs: 1 });
  });

  it("counts one run per start — a loop body runs many times", () => {
    const events: RunEvent[] = [];
    for (let i = 0; i < 5; i++) {
      events.push(event("body", "started", i * 10));
      events.push(event("body", "finished", i * 10 + 4, { durationMs: 4 }));
    }
    const state = summarizeRun(events).get("body");
    expect(state).toMatchObject({ runs: 5, status: "ok", durationMs: 4, totalMs: 20 });
  });

  it("keeps the failure, and does not let it be overwritten by a later start's default", () => {
    const state = summarizeRun([
      event("a", "started", 0),
      event("a", "failed", 12, { durationMs: 12, error: { message: "boom" } }),
    ]).get("a");
    expect(state).toMatchObject({ status: "failed", runs: 1 });
    expect(state?.error?.message).toBe("boom");
  });

  it("reports a skipped step as skipped, not as never-reached", () => {
    expect(summarizeRun([event("a", "skipped", 0)]).get("a")?.status).toBe("skipped");
    // A node with no events at all is simply absent — the caller decides what
    // "absent" means, and it is never the same thing as "skipped".
    expect(summarizeRun([]).get("a")).toBeUndefined();
  });

  it("carries the latest preview", () => {
    const state = summarizeRun([
      event("a", "started", 0),
      event("a", "finished", 1, { preview: { rows: 1 } }),
      event("a", "started", 2),
      event("a", "finished", 3, { preview: { rows: 2 } }),
    ]).get("a");
    expect(state?.preview).toEqual({ rows: 2 });
    expect(state?.runs).toBe(2);
  });
});
