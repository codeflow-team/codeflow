/** InMemoryFunctionLibraryStore — 03-data-model.md §11, 05-registry.md §4. */

import { describe, expect, it } from "vitest";

import { CodeFlowError } from "../src/errors.js";
import { InMemoryFunctionLibraryStore } from "../src/library/in-memory-store.js";
import type { FunctionDefinition } from "../src/registry/definitions.js";

function def(overrides: Partial<FunctionDefinition> = {}): FunctionDefinition {
  return {
    name: "isAuthChange",
    label: "Is Auth Change",
    inputSchema: { files: "File[]" },
    outputSchema: "boolean",
    code: "export function isAuthChange(files: File[]) { return true; }",
    modulePath: "@flows/lib",
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CodeFlowError) return error.code;
    throw error;
  }
  throw new Error("expected the call to reject");
}

describe("save", () => {
  it("stores and reads back a definition", async () => {
    const store = new InMemoryFunctionLibraryStore();
    await store.save(def());
    expect(await store.get("isAuthChange")).toMatchObject({ label: "Is Auth Change" });
    expect(await store.list()).toHaveLength(1);
  });

  it("returns null for an unknown name", async () => {
    expect(await new InMemoryFunctionLibraryStore().get("nope")).toBeNull();
  });

  it("rejects a name that already exists unless overwrite is set", async () => {
    const store = new InMemoryFunctionLibraryStore();
    await store.save(def());
    expect(await codeOf(store.save(def({ label: "Other" })))).toBe("duplicate-function");
    expect((await store.get("isAuthChange"))?.label).toBe("Is Auth Change");

    await store.save(def({ label: "Other" }), { overwrite: true });
    expect((await store.get("isAuthChange"))?.label).toBe("Other");
    expect(await store.list()).toHaveLength(1);
  });

  it("applies the same name/schema validation as the registry", async () => {
    const store = new InMemoryFunctionLibraryStore();
    expect(await codeOf(store.save(def({ name: "github.getFiles" })))).toBe("invalid-function-name");
    expect(await codeOf(store.save(def({ inputSchema: "File[]" })))).toBe("invalid-schema");
  });

  it("stores a copy — later mutation of the caller's object does not leak in", async () => {
    const store = new InMemoryFunctionLibraryStore();
    const original = def();
    await store.save(original);
    original.label = "Mutated";
    expect((await store.get("isAuthChange"))?.label).toBe("Is Auth Change");
  });

  it("accepts an initial set and lists it sorted by name", async () => {
    const store = new InMemoryFunctionLibraryStore({
      initial: [def({ name: "normalize" }), def()],
    });
    expect((await store.list()).map((f) => f.name)).toEqual(["isAuthChange", "normalize"]);
  });
});

describe("remove — usage-check guard (03 §11)", () => {
  it("removes an unused function", async () => {
    const store = new InMemoryFunctionLibraryStore();
    await store.save(def());
    await store.remove("isAuthChange");
    expect(await store.get("isAuthChange")).toBeNull();
  });

  it("rejects removing a name that is not there", async () => {
    const store = new InMemoryFunctionLibraryStore();
    expect(await codeOf(store.remove("isAuthChange"))).toBe("function-not-found");
  });

  it("refuses to remove a function still in use", async () => {
    const store = new InMemoryFunctionLibraryStore({ isInUse: (name) => name === "isAuthChange" });
    await store.save(def());
    expect(await codeOf(store.remove("isAuthChange"))).toBe("function-in-use");
    expect(await store.get("isAuthChange")).not.toBeNull();
  });

  it("removes an in-use function only with force (after the user confirmed)", async () => {
    const store = new InMemoryFunctionLibraryStore({ isInUse: () => true });
    await store.save(def());
    await store.remove("isAuthChange", { force: true });
    expect(await store.get("isAuthChange")).toBeNull();
  });
});

describe("rename", () => {
  it("moves the entry and updates its name", async () => {
    const store = new InMemoryFunctionLibraryStore();
    await store.save(def());
    await store.rename("isAuthChange", "isSecurityChange");
    expect(await store.get("isAuthChange")).toBeNull();
    expect((await store.get("isSecurityChange"))?.name).toBe("isSecurityChange");
  });

  it("does not rewrite importing flows — that is a patch per flow", async () => {
    const store = new InMemoryFunctionLibraryStore();
    await store.save(def());
    await store.rename("isAuthChange", "isSecurityChange");
    // The stored source still declares the old identifier: rewriting source is
    // the patch engine's job, not the store's.
    expect((await store.get("isSecurityChange"))?.code).toContain("function isAuthChange");
  });

  it("rejects renaming a missing function", async () => {
    const store = new InMemoryFunctionLibraryStore();
    expect(await codeOf(store.rename("nope", "other"))).toBe("function-not-found");
  });

  it("rejects renaming onto an existing name", async () => {
    const store = new InMemoryFunctionLibraryStore();
    await store.save(def());
    await store.save(def({ name: "normalize" }));
    expect(await codeOf(store.rename("isAuthChange", "normalize"))).toBe("duplicate-function");
    expect(await store.list()).toHaveLength(2);
  });

  it("rejects an invalid new name", async () => {
    const store = new InMemoryFunctionLibraryStore();
    await store.save(def());
    expect(await codeOf(store.rename("isAuthChange", "github.getFiles"))).toBe(
      "invalid-function-name",
    );
  });

  it("is a no-op when the name does not change", async () => {
    const store = new InMemoryFunctionLibraryStore();
    await store.save(def());
    await store.rename("isAuthChange", "isAuthChange");
    expect(await store.list()).toHaveLength(1);
  });
});
