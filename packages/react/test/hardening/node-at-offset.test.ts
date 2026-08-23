/**
 * `nodeAtOffset` — the caret half of the two-way selection sync (07 §2).
 *
 * The failure this file exists for was found in a browser session: put the
 * caret at column 1 of an indented statement (press Home) and the selection
 * jumped to the enclosing `for` instead of the step on that line. Taken
 * literally the old answer was right — column 1 of an indented line really is
 * outside every statement on it — and that is exactly why "literally" was the
 * wrong rule. A reader pointing at a line means the thing on it.
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow, createRegistry, type WorkflowGraph } from "@codeflow/core";
import { nodeAtOffset } from "../../src/graph/index.js";

const SOURCE = `import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });
  for (const pr of prs) {
    try {
      await tools.slack.send({ channel: "#security", message: "m" });
    } catch (e) {
      await tools.slack.send({ channel: "#alerts", message: "failed" });
    }
  }
  return prs;
}
`;

/** A file that indents with tabs, to prove the rule is about whitespace not spaces. */
const TABBED = `import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
\tfor (const pr of [1]) {
\t\tawait tools.slack.send({ channel: "#security", message: "m" });
\t}
}
`;

function registry() {
  return createRegistry({
    tools: [
      {
        name: "github.getNewPRs",
        label: "Get New PRs",
        inputSchema: { repo: "string" },
        outputSchema: "PullRequest[]",
        editableFields: ["repo"],
      },
      {
        name: "slack.send",
        label: "Slack Send",
        inputSchema: { channel: "string", message: "string" },
        editableFields: ["channel", "message"],
      },
    ],
  });
}

async function analyze(source: string): Promise<WorkflowGraph> {
  return createCodeFlow({ registry: registry() }).analyze(source, { file: "flow.ts" });
}

/** Offset of the first character of line `line` (1-based). */
function startOfLine(source: string, line: number): number {
  const lines = source.split("\n");
  let offset = 0;
  for (let index = 0; index < line - 1; index++) offset += lines[index].length + 1;
  return offset;
}

/** Offset of the first non-whitespace character of line `line`. */
function firstTokenOfLine(source: string, line: number): number {
  const text = source.split("\n")[line - 1];
  return startOfLine(source, line) + Math.max(text.search(/\S/), 0);
}

describe("a caret in the indentation resolves to the statement on that line", () => {
  it("selects the tool call, not the loop, at column 1 of the call's line", async () => {
    const graph = await analyze(SOURCE);
    const node = nodeAtOffset(graph, startOfLine(SOURCE, 7));
    expect(node?.source.semanticPath).toBe("flow/for[0]/try[0]/call:slack.send[0]");
  });

  it("selects the same node the caret on the first token would", async () => {
    const graph = await analyze(SOURCE);
    for (const line of [4, 5, 6, 7, 8, 9, 12]) {
      expect(
        nodeAtOffset(graph, startOfLine(SOURCE, line))?.source.semanticPath,
        `line ${String(line)}`,
      ).toBe(nodeAtOffset(graph, firstTokenOfLine(SOURCE, line))?.source.semanticPath);
    }
  });

  it("selects a top-level statement instead of nothing at column 1", async () => {
    const graph = await analyze(SOURCE);
    // The old answer here was `null`: column 1 of an unindented-by-two line is
    // outside the statement, and there is no container to fall back to.
    expect(nodeAtOffset(graph, startOfLine(SOURCE, 4))?.source.semanticPath).toBe(
      "flow/call:github.getNewPRs[0]",
    );
    expect(nodeAtOffset(graph, startOfLine(SOURCE, 12))?.source.semanticPath).toBe("flow/return[0]");
  });

  it("selects the container when the container is what is on the line", async () => {
    const graph = await analyze(SOURCE);
    expect(nodeAtOffset(graph, startOfLine(SOURCE, 5))?.source.semanticPath).toBe("flow/for[0]");
    expect(nodeAtOffset(graph, startOfLine(SOURCE, 6))?.source.semanticPath).toBe("flow/for[0]/try[0]");
  });

  it("works the same on a tab-indented file", async () => {
    const graph = await analyze(TABBED);
    expect(nodeAtOffset(graph, startOfLine(TABBED, 5))?.source.semanticPath).toBe(
      "flow/for[0]/call:slack.send[0]",
    );
  });

  it("still answers the innermost node for a caret in the middle of a statement", async () => {
    const graph = await analyze(SOURCE);
    const inside = SOURCE.indexOf('"#security"') + 3;
    expect(nodeAtOffset(graph, inside)?.source.semanticPath).toBe("flow/for[0]/try[0]/call:slack.send[0]");
  });

  it("never widens the answer: a caret already inside a node keeps that node", async () => {
    const graph = await analyze(SOURCE);
    // Every offset in the file: snapping may only ever return a node whose
    // range is no larger than the literal answer's.
    for (let offset = 0; offset <= SOURCE.length; offset++) {
      const snapped = nodeAtOffset(graph, offset);
      const literal = graph.nodes
        .filter(
          (node) => offset >= node.source.start.offset && offset <= node.source.end.offset,
        )
        .sort(
          (a, b) =>
            a.source.end.offset - a.source.start.offset - (b.source.end.offset - b.source.start.offset),
        )[0];
      if (literal === undefined) continue;
      expect(snapped, `offset ${String(offset)}`).not.toBeNull();
      const snappedWidth = snapped!.source.end.offset - snapped!.source.start.offset;
      const literalWidth = literal.source.end.offset - literal.source.start.offset;
      expect(snappedWidth, `offset ${String(offset)}`).toBeLessThanOrEqual(literalWidth);
    }
  });

  it("returns null on a blank line between statements", async () => {
    const spaced = SOURCE.replace("  return prs;", "\n  return prs;");
    const graph = await analyze(spaced);
    const blank = startOfLine(spaced, 12);
    expect(spaced.split("\n")[11]).toBe("");
    // Nothing is on this line, so nothing is selected — snapping stops at the
    // line terminator rather than reaching into the next line.
    expect(nodeAtOffset(graph, blank)).toBeNull();
  });

  it("handles an empty graph and an out-of-range offset without throwing", async () => {
    const graph = await analyze(SOURCE);
    expect(nodeAtOffset(null, 0)).toBeNull();
    expect(nodeAtOffset(undefined, 0)).toBeNull();
    expect(nodeAtOffset(graph, SOURCE.length + 1000)).toBeNull();
    expect(nodeAtOffset(graph, -5)).toBeNull();
  });

  it("resolves inside a CRLF file, where the line start is after the \\r", async () => {
    const crlf = SOURCE.replace(/\n/g, "\r\n");
    const graph = await analyze(crlf);
    expect(nodeAtOffset(graph, startOfLine(crlf, 7))?.source.semanticPath).toBe(
      "flow/for[0]/try[0]/call:slack.send[0]",
    );
  });
});
