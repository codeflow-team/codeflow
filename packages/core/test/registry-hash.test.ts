/** registryHash — 05-registry.md §2. Deterministic fingerprint of registry content. */

import { describe, expect, it } from "vitest";

import { createRegistry } from "../src/registry/index.js";
import type { FunctionDefinition, ToolDefinition } from "../src/registry/definitions.js";
import { createSampleRegistry } from "./fixtures.js";

const getFiles: ToolDefinition = {
  name: "github.getFiles",
  label: "Get PR Files",
  description: "Get files changed in a PR",
  inputSchema: { pr: "PullRequest" },
  outputSchema: "File[]",
  editableFields: ["pr"],
};

const send: ToolDefinition = {
  name: "slack.send",
  label: "Slack Send",
  inputSchema: { channel: "string", message: "string" },
  editableFields: ["channel", "message"],
};

const isAuthChange: FunctionDefinition = {
  name: "isAuthChange",
  label: "Is Auth Change",
  inputSchema: { files: "File[]" },
  outputSchema: "boolean",
  code: "export function isAuthChange(files: File[]) { return true; }",
  modulePath: "@flows/lib",
};

describe("determinism", () => {
  it("is a 64-char lowercase hex digest", () => {
    expect(createSampleRegistry().registryHash()).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls and across identical registries", () => {
    const a = createSampleRegistry();
    const b = createSampleRegistry();
    expect(a.registryHash()).toBe(a.registryHash());
    expect(a.registryHash()).toBe(b.registryHash());
  });

  it("does not depend on registration order", () => {
    const a = createRegistry();
    a.registerTool(getFiles);
    a.registerTool(send);
    a.registerFunction(isAuthChange);

    const b = createRegistry();
    b.registerFunction(isAuthChange);
    b.registerTool(send);
    b.registerTool(getFiles);

    expect(a.registryHash()).toBe(b.registryHash());
  });

  it("does not depend on key order inside a schema", () => {
    const a = createRegistry();
    a.registerTool({ ...send, inputSchema: { channel: "string", message: "string" } });
    const b = createRegistry();
    b.registerTool({ ...send, inputSchema: { message: "string", channel: "string" } });
    expect(a.registryHash()).toBe(b.registryHash());
  });

  it("treats the editable-field shorthand as identical to its normalized form", () => {
    const a = createRegistry();
    a.registerTool({ ...send, editableFields: ["channel", "message"] });
    const b = createRegistry();
    b.registerTool({ ...send, editableFields: [{ name: "channel" }, { name: "message" }] });
    expect(a.registryHash()).toBe(b.registryHash());
  });

  it("an empty registry has a stable hash", () => {
    expect(createRegistry().registryHash()).toBe(createRegistry().registryHash());
    expect(createRegistry().registryHash()).not.toBe(createSampleRegistry().registryHash());
  });
});

describe("sensitivity — a changed field changes the hash", () => {
  function hashWith(mutate: (registry: ReturnType<typeof createRegistry>) => void): string {
    const registry = createRegistry();
    registry.registerTool(getFiles);
    registry.registerTool(send);
    registry.registerFunction(isAuthChange);
    mutate(registry);
    return registry.registryHash();
  }

  const baseline = hashWith(() => {});

  it("changes when a tool label changes", () => {
    expect(hashWith((r) => r.registerTool({ ...send, label: "Post" }, { overwrite: true }))).not.toBe(
      baseline,
    );
  });

  it("changes when a tool input schema changes", () => {
    expect(
      hashWith((r) =>
        r.registerTool({ ...send, inputSchema: { channel: "string" } }, { overwrite: true }),
      ),
    ).not.toBe(baseline);
  });

  it("changes when an output schema is added", () => {
    expect(
      hashWith((r) => r.registerTool({ ...send, outputSchema: "void" }, { overwrite: true })),
    ).not.toBe(baseline);
  });

  it("changes when editable fields change", () => {
    expect(
      hashWith((r) => r.registerTool({ ...send, editableFields: ["channel"] }, { overwrite: true })),
    ).not.toBe(baseline);
  });

  it("changes when a tool is removed (05 §2 — tool removed while a flow uses it)", () => {
    expect(hashWith((r) => r.unregisterTool("slack.send"))).not.toBe(baseline);
  });

  it("changes when a library function body changes", () => {
    expect(
      hashWith((r) =>
        r.registerFunction({ ...isAuthChange, code: "export function isAuthChange() {}" }, {
          overwrite: true,
        }),
      ),
    ).not.toBe(baseline);
  });

  it("changes when a plugin node type is registered", () => {
    expect(hashWith((r) => r.registerNode({ type: "approval", label: "Approval" }))).not.toBe(
      baseline,
    );
  });
});

describe("exclusions", () => {
  it("ignores function references — analyzer/patcher hooks are behaviour, not identity", () => {
    const plain = createRegistry();
    plain.registerTool(getFiles);

    const hooked = createRegistry();
    hooked.registerTool({ ...getFiles, analyzer: () => null, patcher: () => [] });
    hooked.registerAnalyzer(() => null);

    expect(hooked.registryHash()).toBe(plain.registryHash());
  });

  it("ignores a plugin node renderer reference", () => {
    const plain = createRegistry();
    plain.registerNode({ type: "approval", label: "Approval" });

    const withRenderer = createRegistry();
    withRenderer.registerNode({ type: "approval", label: "Approval", renderer: { fake: true } });

    expect(withRenderer.registryHash()).toBe(plain.registryHash());
  });
});
