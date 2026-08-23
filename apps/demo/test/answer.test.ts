/**
 * Splitting a model answer into the file and the sentence about it.
 *
 * The file half must never lose a line — a rewrite is applied verbatim — and the
 * prose half is what closes QA BUG-13 ("whole-flow mode says nothing at all").
 */

import { describe, expect, it } from "vitest";
import { splitAnswer } from "../src/ai.js";

describe("splitAnswer", () => {
  it("takes the fenced file and keeps the sentence in front of it", () => {
    const answer = [
      "Reads every CSV and totals them by region; there is no email tool here, so the summary is written to a file.",
      "```ts",
      'import type { Tools } from "./generated/tools";',
      "export default async function flow() {}",
      "```",
    ].join("\n");

    const { source, prose } = splitAnswer(answer);
    expect(source).toBe('import type { Tools } from "./generated/tools";\nexport default async function flow() {}\n');
    expect(prose).toContain("no email tool here");
  });

  it("splits an unfenced answer at the first line that can begin a file", () => {
    const answer = [
      "I could not find a Jira tool in this registry, so that step is left as a TODO.",
      "",
      'import type { Tools } from "./generated/tools";',
      "export default async function flow() {}",
    ].join("\n");

    const { source, prose } = splitAnswer(answer);
    expect(source.startsWith("import type")).toBe(true);
    expect(source).toContain("export default async function flow");
    expect(prose).toContain("Jira");
  });

  it("keeps a bare file whole and reports no prose", () => {
    const answer = 'import type { Tools } from "./generated/tools";\nexport default async function flow() {}';

    const { source, prose } = splitAnswer(answer);
    expect(source).toBe(`${answer}\n`);
    expect(prose).toBeNull();
  });

  it("drops a bare lead-in rather than showing it as an explanation", () => {
    const { prose } = splitAnswer("Here is the complete file:\n```ts\nconst a = 1;\n```");
    expect(prose).toBeNull();
  });

  it("never leaves a leading comment behind in the prose", () => {
    const answer = "/** Daily digest. */\nexport default async function flow() {}";
    expect(splitAnswer(answer).source).toBe(`${answer}\n`);
  });
});
