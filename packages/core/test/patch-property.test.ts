/**
 * Property-style tests for the patch engine — 11-testing.md §3.3.
 *
 * The generator is deliberately small and dependency-free: it produces
 * **formatting variants** of existing fixtures (different indentation, extra
 * comments, extra blank lines) and replays the fixture's own edits on them.
 *
 * The property under test is I3 stated independently of line numbers: whatever
 * the formatting, an edit changes the same *lines of content* and nothing else.
 * Hand-written fixtures cannot cover the combinations this catches — a patch
 * that quietly depends on two-space indentation, on a statement being the first
 * on its line, or on there being no comment in the way, fails here.
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow } from "../src/session.js";
import { unifiedDiff } from "./harness/diff.js";
import { listEdits, type EditCase } from "./harness/edits.js";
import { loadFixture, type Fixture } from "./harness/fixture.js";

/* -------------------------------------------------------------------------- */
/* variant generators                                                          */
/* -------------------------------------------------------------------------- */

type Variant = { name: string; apply: (source: string) => string };

function mapLines(source: string, fn: (line: string) => string): string {
  return source.split("\n").map(fn).join("\n");
}

const VARIANTS: Variant[] = [
  {
    name: "four-space indentation",
    apply: (source) =>
      mapLines(source, (line) => {
        const match = /^( +)(.*)$/.exec(line);
        if (match === null) return line;
        return " ".repeat(match[1].length * 2) + match[2];
      }),
  },
  {
    name: "tab indentation",
    apply: (source) =>
      mapLines(source, (line) => {
        const match = /^( +)(.*)$/.exec(line);
        if (match === null) return line;
        return "\t".repeat(Math.ceil(match[1].length / 2)) + match[2];
      }),
  },
  {
    name: "space indentation",
    apply: (source) =>
      mapLines(source, (line) => {
        const match = /^(\t+)(.*)$/.exec(line);
        if (match === null) return line;
        return "  ".repeat(match[1].length) + match[2];
      }),
  },
  {
    name: "a comment above every call",
    apply: (source) =>
      source
        .split("\n")
        .flatMap((line) => {
          const match = /^([ \t]*)(await |const )/.exec(line);
          if (match === null) return [line];
          return [`${match[1]}// note: unrelated comment`, line];
        })
        .join("\n"),
  },
  {
    name: "extra blank lines",
    apply: (source) =>
      source
        .split("\n")
        .flatMap((line) => (line.trim().length === 0 ? [line, line] : [line]))
        .join("\n"),
  },
];

/* -------------------------------------------------------------------------- */
/* the property                                                                */
/* -------------------------------------------------------------------------- */

/** The `-`/`+` lines of a unified diff, trimmed of indentation. */
function changedLines(diff: string): string[] {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("-") || line.startsWith("+"))
    .map((line) => `${line[0]}${line.slice(1).trim()}`);
}

/** Leading whitespace of the first line a diff adds, if it adds one. */
function insertedIndent(diff: string): string | null {
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+")) continue;
    const match = /^\+([ \t]*)\S/.exec(line);
    if (match !== null) return match[1];
  }
  return null;
}

async function patch(fixture: Fixture, source: string, edit: EditCase) {
  const session = createCodeFlow({ registry: fixture.registry });
  const graph = await session.analyze(source, fixture.options);
  const node = graph.nodes.find((candidate) => candidate.source.semanticPath === edit.node);
  expect(node, `no node at ${edit.node} in the variant`).toBeDefined();
  return session.patchNode(node!.id, edit.changes);
}

const CASES = ["01-canonical", "34-trailing-comma-comments", "35-single-quotes-tabs"];

describe("formatting variants — the same edit hits the same lines (I3)", () => {
  for (const name of CASES) {
    const fixture = loadFixture(name);
    const edits = listEdits(fixture.dir, fixture.name).filter((edit) => edit.error === undefined);

    describe(name, () => {
      for (const variant of VARIANTS) {
        const source = variant.apply(fixture.source);
        if (source === fixture.source) continue;

        describe(variant.name, () => {
          it("still analyzes to the same nodes", async () => {
            const session = createCodeFlow({ registry: fixture.registry });
            const original = await createCodeFlow({ registry: fixture.registry }).analyze(
              fixture.source,
              fixture.options,
            );
            const varied = await session.analyze(source, fixture.options);
            expect(varied.nodes.map((node) => node.source.semanticPath)).toEqual(
              original.nodes.map((node) => node.source.semanticPath),
            );
          });

          for (const edit of edits) {
            it(`${edit.name} changes the same lines and nothing else`, async () => {
              const result = await patch(fixture, source, edit);
              const diff = unifiedDiff(source, result.source);

              expect(changedLines(diff)).toEqual(changedLines(edit.expectedDiff ?? ""));

              // Everything outside the patched ranges is untouched, byte for byte.
              let rebuilt = "";
              let cursor = 0;
              for (const p of result.patches) {
                rebuilt += source.slice(cursor, p.range.start.offset);
                expect(source.slice(p.range.start.offset, p.range.end.offset)).toBe(p.oldText);
                rebuilt += p.newText;
                cursor = p.range.end.offset;
              }
              expect(rebuilt + source.slice(cursor)).toBe(result.source);
            });
          }
        });
      }

      it("inserted code follows the variant's own indentation", async () => {
        const insertEdit = listEdits(fixture.dir, fixture.name).find(
          (edit) => edit.error === undefined && "$insert" in edit.changes,
        );
        if (insertEdit === undefined) return;

        for (const variant of VARIANTS) {
          const source = variant.apply(fixture.source);
          if (source === fixture.source) continue;
          const result = await patch(fixture, source, insertEdit);
          const indent = insertedIndent(unifiedDiff(source, result.source));
          expect(indent, `${variant.name}: nothing was inserted`).not.toBeNull();
          // The anchor's own line decides the indentation — not a default.
          const callee = /call:([^[]+)/.exec(insertEdit.node)?.[1];
          expect(callee, "this property needs an edit anchored on a call").toBeDefined();
          const anchorLine = source.split("\n").find((line) => line.includes(`${callee!}(`));
          expect(anchorLine).toBeDefined();
          expect(indent).toBe(/^[ \t]*/.exec(anchorLine!)![0]);
        }
      });
    });
  }
});
