/**
 * Fail if a committed generated file no longer matches its source.
 *
 * `src/tools/*.ts` is derived from the captured MCP payloads and
 * `src/generated/sources.ts` from `flows/*.flow.ts`. Both are committed so they
 * can be reviewed in a diff — which only works if they cannot drift. Run by
 * `test/generated.test.ts`; run it yourself with
 * `node scripts/check-generated.mjs`.
 *
 * Exit code 0 means the checkout is consistent; 1 names every stale file and
 * the command that regenerates it.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SERVERS } from "./servers.mjs";
import { moduleSourceFor } from "./generate-tools.mjs";
import { generatedSource } from "./embed-flows.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relative) {
  try {
    return readFileSync(join(ROOT, relative), "utf8");
  } catch {
    return null;
  }
}

const stale = [];

for (const server of SERVERS) {
  const { fileName, source } = moduleSourceFor(server);
  const relative = `src/tools/${fileName}`;
  if (read(relative) !== source) stale.push(relative);
}

if (read("src/generated/sources.ts") !== generatedSource()) {
  stale.push("src/generated/sources.ts");
}

if (stale.length > 0) {
  console.error(
    [
      "Generated files are stale:",
      ...stale.map((file) => `  ${file}`),
      "",
      "Regenerate with: pnpm --filter @codeflow-team/examples embed",
    ].join("\n"),
  );
  process.exit(1);
}

console.log("generated files are up to date");
