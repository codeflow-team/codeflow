/**
 * Embed `flows/*.flow.ts` into `src/generated/sources.ts` as string constants.
 *
 * The flows are authored as real `.ts` files — that is the only way to edit a
 * 400-line flow with a working editor, and the only way the type-check in
 * `packages/core/test/stress/type-check.test.ts` is checking the same bytes a
 * reader sees. The package still has to *ship* them as strings, because the
 * analyzer takes source text, so this step copies them across verbatim.
 *
 * Verbatim is the whole contract: a flow that is full of template literals and
 * `${}` interpolations must survive the round trip byte for byte, so the
 * escaping is done with `JSON.stringify` per line rather than by hand-rolling a
 * template literal. `examples-package.test.ts` re-runs this and fails if the
 * committed file has drifted.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FLOW_DIR = join(HERE, "..", "flows");
const OUT_FILE = join(HERE, "..", "src", "generated", "sources.ts");

/** `repo-triage-bot.flow.ts` → `repo-triage-bot`. */
export function flowIdOf(fileName) {
  return fileName.replace(/\.flow\.ts$/, "");
}

export function flowFiles() {
  return readdirSync(FLOW_DIR)
    .filter((file) => file.endsWith(".flow.ts"))
    .sort();
}

/**
 * A string literal per source line, joined with `\n`. Long single-line strings
 * are unreadable in a diff; one line per line makes a change to a flow show up
 * as a change to that line.
 */
function renderSource(text) {
  const lines = text.split("\n");
  return lines.map((line) => `    ${JSON.stringify(line)}`).join(",\n");
}

export function generatedSource() {
  const blocks = flowFiles().map((file) => {
    const text = readFileSync(join(FLOW_DIR, file), "utf8");
    return `  ${JSON.stringify(flowIdOf(file))}: [\n${renderSource(text)},\n  ].join("\\n"),`;
  });

  return `/**
 * Flow sources — GENERATED from \`flows/*.flow.ts\`. Do not edit by hand.
 *
 * Regenerate with \`pnpm --filter @codeflow-team/examples embed\`.
 */

export const SOURCES: Record<string, string> = {
${blocks.join("\n")}
};
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const source = generatedSource();
  writeFileSync(OUT_FILE, source);
  console.log(`${String(flowFiles().length)} flows embedded into src/generated/sources.ts`);
}
