/**
 * The map from captured MCP server → CodeFlow namespace.
 *
 * Kept apart from `generate-tools.mjs` so a test can re-run the conversion
 * (and compare it against the committed `src/tools/*.ts`) without the import
 * rewriting the files as a side effect.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mcpToolsToDefinitions } from "@codeflow-team/mcp";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_DIR = join(HERE, "..", "..", "mcp", "test", "real-schemas");

/**
 * `namespace` is what the flow author types (`tools.fs.readTextFile`); `strip`
 * removes a prefix every tool of the server repeats, so playwright reads as
 * `tools.browser.click` rather than `tools.browser.browserClick`. The MCP name
 * survives in `mcp.toolName` either way, so nothing becomes unroutable.
 */
export const SERVERS = [
  { file: "filesystem.json", constant: "FILESYSTEM_TOOLS", namespace: "fs", strip: null },
  { file: "memory.json", constant: "MEMORY_TOOLS", namespace: "memory", strip: null },
  { file: "playwright.json", constant: "PLAYWRIGHT_TOOLS", namespace: "browser", strip: "browser_" },
  { file: "everything.json", constant: "EVERYTHING_TOOLS", namespace: "everything", strip: null },
  { file: "duckduckgo.json", constant: "DUCKDUCKGO_TOOLS", namespace: "search", strip: "duckduckgo_" },
  { file: "deepwiki.json", constant: "DEEPWIKI_TOOLS", namespace: "deepwiki", strip: "deepwiki_" },
  { file: "context7.json", constant: "CONTEXT7_TOOLS", namespace: "context7", strip: null },
  {
    file: "sequential-thinking.json",
    constant: "SEQUENTIAL_THINKING_TOOLS",
    namespace: "reasoning",
    // `sequentialthinking` is one word to the server; `sequentialThinking` is
    // the same word a human can read on a node label.
    rename: { sequentialthinking: "sequentialThinking" },
    strip: null,
  },
];

/** Run the real adapter over a captured payload. */
export function definitionsFor(server) {
  const capture = JSON.parse(readFileSync(join(SCHEMA_DIR, server.file), "utf8"));
  return mcpToolsToDefinitions(capture.tools, {
    namespace: server.namespace,
    server: capture.server,
    methodName: (tool) => {
      const renamed = server.rename?.[tool.name];
      if (renamed !== undefined) return renamed;
      if (server.strip !== null && tool.name.startsWith(server.strip)) {
        const rest = tool.name.slice(server.strip.length);
        if (rest.length > 0) return rest;
      }
      return tool.name;
    },
  });
}

/** `ToolDefinition` fields only — `mcp` origin is adapter bookkeeping. */
export function toToolDefinition(definition) {
  const { mcp: _mcp, ...rest } = definition;
  return rest;
}
