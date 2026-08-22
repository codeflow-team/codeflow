/** createCodeFlow / CodeFlowSession — 02-architecture.md §4. */

import { describe, expect, it } from "vitest";

import { createCodeFlow } from "../src/session.js";
import { generateLibDts } from "../src/codegen/lib-dts.js";
import { generateToolsDts } from "../src/codegen/tools-dts.js";
import { InMemoryFunctionLibraryStore } from "../src/library/in-memory-store.js";
import { createSampleRegistry } from "./fixtures.js";

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

describe("later phases are stubs, not lies", () => {
  const session = createCodeFlow({ registry: createSampleRegistry() });

  it("validate throws until the analyzer lands (phase 2)", async () => {
    await expect(session.validate("")).rejects.toThrow("not implemented (phase 2)");
  });

  it("patchNode throws until the patch engine lands (phase 4)", async () => {
    await expect(session.patchNode("node_1", { channel: "#eng" })).rejects.toThrow(
      "not implemented (phase 4)",
    );
  });

  it("buildGenerationContext throws until the context builder lands (phase 5)", async () => {
    await expect(session.buildGenerationContext()).rejects.toThrow("not implemented (phase 5)");
  });
});
