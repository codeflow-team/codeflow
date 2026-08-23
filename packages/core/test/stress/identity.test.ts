/**
 * I5 at scale — identity survives edits that change nothing the graph is about.
 *
 * The identity tests in `test/identity.test.ts` prove the algorithm on small,
 * hand-made revisions. This suite asks the harder question: does it hold when
 * there are ninety nodes, eleven of them merges, five of them jumps, and
 * eighteen calls of the same handful of tools? That is where an order-sensitive
 * matcher or a fingerprint that accidentally includes trivia falls over, and it
 * is exactly the file a user has open when a mis-bind would cost them work.
 *
 * "Changes nothing the graph is about" means: comments, blank lines, trailing
 * whitespace, and reformatting an argument object across more lines. None of
 * them changes a single step, so not one id may move.
 */

import { describe, expect, it } from "vitest";

import { LONG_EXAMPLES, exampleById, fileOf, registryOf } from "./helpers.js";
import { createCodeFlow } from "../../src/session.js";
import { assertBijective, assertIntegrity } from "../harness/reanalyze.js";
import type { WorkflowGraph } from "../../src/model/index.js";

async function revise(exampleId: string, edit: (source: string) => string) {
  const example = exampleById(exampleId);
  const session = createCodeFlow({ registry: registryOf(example) });
  const file = fileOf(example);
  const before = await session.analyze(example.source, { file });
  const after = await session.analyze(edit(example.source), { file });
  assertIntegrity(before);
  assertIntegrity(after);
  const resolution = session.lastResolution();
  expect(resolution).not.toBeNull();
  assertBijective(resolution!);
  return { example, session, before, after, changes: session.lastChanges() };
}

/** Node ids keyed by semantic path — the pairing a mis-bind would break. */
function idsByPath(graph: WorkflowGraph): Record<string, string> {
  const map: Record<string, string> = {};
  for (const node of graph.nodes) map[node.source.semanticPath] = node.id;
  return map;
}

describe.each(LONG_EXAMPLES.map((example) => [example.id] as const))("%s", (id) => {
  it("keeps every id when comments are added throughout", async () => {
    const { before, after, changes } = await revise(id, (source) =>
      source
        .split("\n")
        .map((line, index) =>
          index > 0 && index % 7 === 0 && line.trim().length > 0 && !line.trim().startsWith("*")
            ? `${line}  // note ${String(index)}`
            : line,
        )
        .join("\n"),
    );

    expect(after.nodes).toHaveLength(before.nodes.length);
    expect(idsByPath(after)).toEqual(idsByPath(before));
    expect(changes.filter((change) => change.type === "node.added")).toEqual([]);
    expect(changes.filter((change) => change.type === "node.removed")).toEqual([]);
  });

  it("keeps every id when blank lines and trailing whitespace move", async () => {
    const { before, after } = await revise(id, (source) =>
      source
        .split("\n")
        .map((line) => (line.trim().length === 0 ? "   " : `${line} `))
        .join("\n\n"),
    );

    expect(after.nodes).toHaveLength(before.nodes.length);
    expect(idsByPath(after)).toEqual(idsByPath(before));
  });

  it("keeps every id when a leading block comment is prepended", async () => {
    // Every offset in the file moves. Identity must not be positional.
    const { before, after } = await revise(
      id,
      (source) => `/* generated ${new Date(0).toISOString()} */\n\n${source}`,
    );

    expect(idsByPath(after)).toEqual(idsByPath(before));
  });
});

describe("repo-triage-bot, edited the way a person edits", () => {
  it("keeps every other id when one deeply nested field changes", async () => {
    const { before, after, changes } = await revise("repo-triage-bot", (source) =>
      source.replace('relationType: "has-high-risk-file"', 'relationType: "flagged-file"'),
    );

    expect(after.nodes).toHaveLength(before.nodes.length);
    expect(idsByPath(after)).toEqual(idsByPath(before));
    // The edited node is `updated`; nothing is added or removed.
    expect(changes.filter((change) => change.type === "node.added")).toEqual([]);
    expect(changes.filter((change) => change.type === "node.removed")).toEqual([]);
    expect(changes.filter((change) => change.type === "node.updated").length).toBeGreaterThan(0);
  });

  it("keeps every id when an argument object is reformatted over more lines", async () => {
    const { before, after } = await revise("repo-triage-bot", (source) =>
      source.replace(
        "const stat = await tools.fs.getFileInfo({ path: candidate });",
        [
          "const stat = await tools.fs.getFileInfo({",
          "              path: candidate",
          "            });",
        ].join("\n"),
      ),
    );

    expect(idsByPath(after)).toEqual(idsByPath(before));
  });

  it("does not mis-bind when a byte-identical tool call is inserted before an existing one", async () => {
    // The classic identity trap (03 §5.2): two calls that fingerprint alike,
    // one inserted *before* the other. The original must keep its id.
    const example = exampleById("repo-triage-bot");
    const anchor = 'relationType: "has-high-risk-file"';
    const at = example.source.indexOf(anchor);
    expect(at).toBeGreaterThan(0);
    const from = example.source.lastIndexOf("await tools.memory.createRelations({", at);
    const to = example.source.indexOf("});", at) + 3;
    const marker = example.source.slice(from, to);
    const indent = " ".repeat(
      from - example.source.lastIndexOf("\n", from) - 1,
    );

    const { before, after, changes } = await revise("repo-triage-bot", (source) =>
      source.replace(marker, `${marker}\n\n${indent}${marker}`),
    );

    expect(after.nodes).toHaveLength(before.nodes.length + 1);

    const added = changes.filter((change) => change.type === "node.added");
    expect(added).toHaveLength(1);

    // Every id the previous graph had is still in the new graph, and the tool
    // node that was there keeps the *same* id rather than handing it to the
    // copy that now sits above it.
    const beforeIds = new Set(before.nodes.map((node) => node.id));
    const survivors = after.nodes.filter((node) => beforeIds.has(node.id));
    expect(survivors).toHaveLength(before.nodes.length);
  });

  it("survives ten unrelated edits in one session without losing an id", async () => {
    const example = exampleById("repo-triage-bot");
    const session = createCodeFlow({ registry: registryOf(example) });
    const file = fileOf(example);

    const first = await session.analyze(example.source, { file });
    const originalIds = idsByPath(first);

    let source = example.source;
    for (let round = 0; round < 10; round++) {
      source = `${source}\n// round ${String(round)}\n`;
      const graph = await session.analyze(source, { file });
      assertIntegrity(graph);
      expect(idsByPath(graph), `round ${String(round)}`).toEqual(originalIds);
    }
  });
});

describe("browser-qa-runner, where the same tool is called many times", () => {
  it("gives each of the repeated fs.writeFile calls its own stable id", async () => {
    const example = exampleById("browser-qa-runner");
    const session = createCodeFlow({ registry: registryOf(example) });
    const file = fileOf(example);

    const before = await session.analyze(example.source, { file });
    const writes = before.nodes.filter((node) => node.data["toolName"] === "fs.writeFile");
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(new Set(writes.map((node) => node.id)).size).toBe(writes.length);

    // Reformat the file wholesale; the writes must keep their individual ids.
    const after = await session.analyze(
      example.source.split("\n").map((line) => `${line}`).join("\r\n"),
      { file },
    );
    assertIntegrity(after);

    const afterWrites = after.nodes.filter((node) => node.data["toolName"] === "fs.writeFile");
    expect(afterWrites.map((node) => node.id)).toEqual(writes.map((node) => node.id));
  });
});
