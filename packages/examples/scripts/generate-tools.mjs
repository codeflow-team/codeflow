/**
 * Freeze the real MCP schemas into static `ToolDefinition[]` modules.
 *
 * `packages/mcp/test/real-schemas/*.json` are verbatim `tools/list` payloads
 * captured from eight real MCP servers. `@codeflow-team/mcp` knows how to turn one
 * into a `ToolDefinition`; running that conversion here — at authoring time,
 * once — rather than at import time means:
 *
 *   - `@codeflow-team/examples` ships with `@codeflow-team/core` as its only runtime
 *     dependency (a UI gallery does not want an MCP adapter in its bundle);
 *   - the definitions are reviewable in a diff instead of computed behind a
 *     function call, so a change in the adapter shows up as a change in this
 *     package rather than as a silent shift in what the examples type-check
 *     against.
 *
 * Regenerate with `pnpm --filter @codeflow-team/examples embed`. The output is
 * committed; `packages/core/test/stress/examples-package.test.ts` re-runs the
 * conversion and fails if the committed files have drifted.
 */

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SERVERS, definitionsFor, toToolDefinition } from "./servers.mjs";

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "tools");

export function moduleSourceFor(server) {
  const definitions = definitionsFor(server).map(toToolDefinition);
  const body = JSON.stringify(definitions, null, 2)
    .split("\n")
    .map((line) => (line.length === 0 ? line : `  ${line}`))
    .join("\n")
    .trim();
  const name = server.file.replace(".json", "");
  return {
    definitions,
    fileName: `${name}.ts`,
    source: `/**
 * ${name} — ${String(definitions.length)} tools, GENERATED. Do not edit by hand.
 *
 * Source: \`packages/mcp/test/real-schemas/${server.file}\` (a verbatim
 * \`tools/list\` payload from the real server), run through
 * \`mcpToolsToDefinitions\` with namespace \`"${server.namespace}"\`.
 * Regenerate with \`pnpm --filter @codeflow-team/examples embed\`.
 */

import type { ToolDefinition } from "@codeflow-team/core";

export const ${server.constant}: ToolDefinition[] = ${body};
`,
  };
}

// Importable without side effects: `check-generated.mjs` reuses
// `moduleSourceFor` to compare against the checkout instead of rewriting it.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let total = 0;
  for (const server of SERVERS) {
    const { definitions, fileName, source } = moduleSourceFor(server);
    total += definitions.length;
    writeFileSync(join(OUT_DIR, fileName), source);
    console.log(`${server.file} → ${String(definitions.length)} tools in namespace "${server.namespace}"`);
  }
  console.log(`${String(total)} tool definitions written to src/tools/`);
}
