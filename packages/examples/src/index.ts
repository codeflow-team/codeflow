/**
 * `@codeflow-team/examples` — the flows CodeFlow is demonstrated and stress-tested
 * with, plus the registries they are written against.
 *
 * Two exports carry everything: `EXAMPLES` is the gallery (metadata + source),
 * `REGISTRIES` is what each one needs to be analyzed. `registryFor` joins them
 * so a caller never has to know the key.
 *
 * ```ts
 * import { EXAMPLES, registryFor } from "@codeflow-team/examples";
 * import { createCodeFlow, createRegistry } from "@codeflow-team/core";
 *
 * const example = EXAMPLES.find((e) => e.id === "repo-triage-bot")!;
 * const { tools, functions } = registryFor(example);
 * const session = createCodeFlow({ registry: createRegistry({ tools, functions }) });
 * const graph = await session.analyze(example.source, { file: `${example.id}.flow.ts` });
 * ```
 *
 * The only runtime dependency is `@codeflow-team/core`. The MCP schemas the
 * registries are built from were converted once, at authoring time, by
 * `scripts/generate-tools.mjs` — see `src/tools/`.
 */

export type { ExampleCategory, ExampleRegistry, FlowExample } from "./types.js";
export { EXAMPLES } from "./examples.js";
export { REGISTRIES } from "./registries.js";

export { FILESYSTEM_TOOLS } from "./tools/filesystem.js";
export { MEMORY_TOOLS } from "./tools/memory.js";
export { PLAYWRIGHT_TOOLS } from "./tools/playwright.js";
export { EVERYTHING_TOOLS } from "./tools/everything.js";
export { DUCKDUCKGO_TOOLS } from "./tools/duckduckgo.js";
export { DEEPWIKI_TOOLS } from "./tools/deepwiki.js";
export { CONTEXT7_TOOLS } from "./tools/context7.js";
export { SEQUENTIAL_THINKING_TOOLS } from "./tools/sequential-thinking.js";

import type { ExampleRegistry, FlowExample } from "./types.js";
import { REGISTRIES } from "./registries.js";

/**
 * The registry an example was written against.
 *
 * Throws rather than falling back to an empty registry: analyzing a flow
 * against the wrong registry produces a graph full of `unknown` nodes that
 * looks like a bug in the flow, which is the worst possible way to fail.
 */
export function registryFor(example: FlowExample): ExampleRegistry {
  const registry = REGISTRIES[example.registryId];
  if (registry === undefined) {
    throw new Error(
      `Example "${example.id}" names registry "${example.registryId}", which is not in REGISTRIES (have: ${Object.keys(REGISTRIES).join(", ")}).`,
    );
  }
  return registry;
}
