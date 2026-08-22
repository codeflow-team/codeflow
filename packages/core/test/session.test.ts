/** createCodeFlow / CodeFlowSession — 02-architecture.md §4. */

import { describe, expect, it } from "vitest";

import { createCodeFlow } from "../src/session.js";
import { generateLibDts } from "../src/codegen/lib-dts.js";
import { generateToolsDts } from "../src/codegen/tools-dts.js";
import { InMemoryFunctionLibraryStore } from "../src/library/in-memory-store.js";
import { createSampleRegistry } from "./fixtures.js";

/** The canonical flow of 01 §1 — the one the whole spec set is written around. */
const CANONICAL_FLOW = `import type { Tools } from "../generated/tools";
import { isAuthChange } from "@flows/lib";

export default async function flow(
  input: { repository: string },
  tools: Tools
) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });

  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr });

    if (files.some(isAuthChange)) {
      await tools.slack.send({
        channel: "#security",
        message: \`Security PR: \${pr.title}\`
      });
    }
  }
}
`;

describe("session state", () => {
  it("keeps the registry and exposes its hash", () => {
    const registry = createSampleRegistry();
    const session = createCodeFlow({ registry });
    expect(session.registry).toBe(registry);
    expect(session.registryHash()).toBe(registry.registryHash());
  });

  it("tracks a registry change (graph staleness is judged on source AND registry)", () => {
    const registry = createSampleRegistry();
    const session = createCodeFlow({ registry });
    const before = session.registryHash();
    registry.unregisterTool("slack.send");
    expect(session.registryHash()).not.toBe(before);
  });

  it("holds the optional library store", () => {
    const libraryStore = new InMemoryFunctionLibraryStore();
    const session = createCodeFlow({ registry: createSampleRegistry(), libraryStore });
    expect(session.libraryStore).toBe(libraryStore);
    expect(createCodeFlow({ registry: createSampleRegistry() }).libraryStore).toBeUndefined();
  });

  it("has no graph before the first analyze", () => {
    expect(createCodeFlow({ registry: createSampleRegistry() }).getGraph()).toBeNull();
  });
});

describe("codegen is available in phase 1", () => {
  it("delegates to the standalone generators", () => {
    const registry = createSampleRegistry();
    const session = createCodeFlow({ registry });
    expect(session.generateToolsDts()).toBe(generateToolsDts(registry));
    expect(session.generateLibDts()).toBe(generateLibDts(registry));
  });
});

describe("generation surface (phase 5)", () => {
  const session = createCodeFlow({ registry: createSampleRegistry() });

  it("validate scores a source without touching the session", async () => {
    const result = await session.validate(CANONICAL_FLOW);
    expect(result.level).toBe("L2");
    expect(session.getGraph()).toBeNull();
    expect(session.lastChanges()).toEqual([]);
  });

  it("buildGenerationContext ships the generated artifacts", async () => {
    const context = await session.buildGenerationContext();
    expect(context.files.map((file) => file.path)).toEqual([
      "generated/tools.d.ts",
      "generated/lib.d.ts",
    ]);
    expect(context.estimatedTokens).toBeGreaterThan(0);
  });
});

describe("later phases are stubs, not lies", () => {
  const session = createCodeFlow({ registry: createSampleRegistry() });

  it("patchNode refuses before anything has been analyzed", async () => {
    // The patch engine landed in phase 4; without a graph there is no node to
    // resolve, and the session says so instead of inventing one.
    await expect(session.patchNode("node_1", { channel: "#eng" })).rejects.toThrow(
      "Nothing has been analyzed in this session yet",
    );
  });

});
