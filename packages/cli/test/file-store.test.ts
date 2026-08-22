/**
 * `FileFunctionLibraryStore` — 03-data-model.md §11, 05-registry.md §4.
 *
 * The contract under test: the file in `lib/` is the only storage, save has a
 * name-conflict check, remove has a usage guard, and rename touches the function's
 * own file but never the flows importing it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CodeFlowError, type FunctionDefinition } from "@codeflow/core";
import { FileFunctionLibraryStore } from "../src/library/file-store.js";
import { CliError } from "../src/errors.js";
import { cleanup, tempDir, write } from "./helpers.js";

afterEach(cleanup);

const isAuthChange: FunctionDefinition = {
  name: "isAuthChange",
  label: "Is Auth Change",
  description: "True when a changed file touches authentication code",
  inputSchema: { file: "{ path: string }" },
  outputSchema: "boolean",
  code: `export function isAuthChange(file: { path: string }): boolean {
  return /auth|login/i.test(file.path);
}
`,
  modulePath: "@flows/lib",
};

async function storeIn(): Promise<{ root: string; store: FileFunctionLibraryStore }> {
  const root = await tempDir();
  return { root, store: new FileFunctionLibraryStore({ dir: path.join(root, "lib") }) };
}

async function codeError(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(Error);
    return (error as CodeFlowError | CliError).code;
  }
  throw new Error("expected the call to reject");
}

describe("save", () => {
  it("writes one kebab-cased file per function and re-exports it from index.ts", async () => {
    const { root, store } = await storeIn();
    await store.save(isAuthChange);

    const files = (await readdir(path.join(root, "lib"))).sort();
    expect(files).toEqual(["index.ts", "is-auth-change.ts"]);

    const index = await readFile(path.join(root, "lib", "index.ts"), "utf8");
    expect(index).toContain('export * from "./is-auth-change.js";');
  });

  it("stores `code` as the file content itself — no second copy", async () => {
    const { root, store } = await storeIn();
    await store.save(isAuthChange);

    const onDisk = await readFile(path.join(root, "lib", "is-auth-change.ts"), "utf8");
    const loaded = await store.get("isAuthChange");
    expect(loaded?.code).toBe(onDisk);
    expect(loaded?.code).toContain("export function isAuthChange");
  });

  it("round-trips: saving what get() returned leaves the file byte-for-byte identical", async () => {
    const { root, store } = await storeIn();
    await store.save(isAuthChange);
    const first = await readFile(path.join(root, "lib", "is-auth-change.ts"), "utf8");

    const loaded = await store.get("isAuthChange");
    await store.save(loaded!, { overwrite: true });
    expect(await readFile(path.join(root, "lib", "is-auth-change.ts"), "utf8")).toBe(first);
  });

  it("keeps every declared field through a save/load cycle", async () => {
    const { store } = await storeIn();
    await store.save({ ...isAuthChange, icon: "🔐", editableFields: ["file"] });

    const loaded = await store.get("isAuthChange");
    expect(loaded).toMatchObject({
      name: "isAuthChange",
      label: "Is Auth Change",
      description: "True when a changed file touches authentication code",
      icon: "🔐",
      inputSchema: { file: "{ path: string }" },
      outputSchema: "boolean",
      modulePath: "@flows/lib",
      editableFields: ["file"],
    });
  });

  it("rejects a name conflict unless overwrite is set", async () => {
    const { store } = await storeIn();
    await store.save(isAuthChange);

    expect(await codeError(() => store.save({ ...isAuthChange, label: "Other" }))).toBe(
      "duplicate-function",
    );

    await store.save({ ...isAuthChange, label: "Other" }, { overwrite: true });
    expect((await store.get("isAuthChange"))?.label).toBe("Other");
  });

  it("rejects an invalid function name", async () => {
    const { store } = await storeIn();
    expect(await codeError(() => store.save({ ...isAuthChange, name: "github.getFiles" }))).toBe(
      "invalid-function-name",
    );
  });

  it("rejects an input schema that names no parameters", async () => {
    const { store } = await storeIn();
    expect(await codeError(() => store.save({ ...isAuthChange, inputSchema: "File[]" }))).toBe(
      "invalid-schema",
    );
  });
});

describe("list", () => {
  it("ignores plain helper modules that carry no marker", async () => {
    const { root, store } = await storeIn();
    await store.save(isAuthChange);
    await write(root, "lib/helpers.ts", "export const noop = () => undefined;\n");

    expect((await store.list()).map((fn) => fn.name)).toEqual(["isAuthChange"]);
  });

  it("fails loudly on a file that claims to be a function but has broken metadata", async () => {
    const { root, store } = await storeIn();
    await write(root, "lib/broken.ts", "/* @codeflow-function\n{ not json }\n*/\nexport const x = 1;\n");

    expect(await codeError(() => store.list())).toBe("invalid-library-file");
  });

  it("returns an empty library when lib/ does not exist yet", async () => {
    const { store } = await storeIn();
    expect(await store.list()).toEqual([]);
    expect(await store.get("isAuthChange")).toBeNull();
  });
});

describe("remove", () => {
  it("refuses to remove a function still in use, and obeys force", async () => {
    const root = await tempDir();
    const inUse = new Set(["isAuthChange"]);
    const store = new FileFunctionLibraryStore({
      dir: path.join(root, "lib"),
      isInUse: (name) => inUse.has(name),
    });
    await store.save(isAuthChange);

    expect(await codeError(() => store.remove("isAuthChange"))).toBe("function-in-use");
    expect(await store.get("isAuthChange")).not.toBeNull();

    await store.remove("isAuthChange", { force: true });
    expect(await store.get("isAuthChange")).toBeNull();
    expect(await readFile(path.join(root, "lib", "index.ts"), "utf8")).not.toContain(
      "is-auth-change",
    );
  });

  it("removes freely once the usage check says the function is unused", async () => {
    const root = await tempDir();
    const store = new FileFunctionLibraryStore({
      dir: path.join(root, "lib"),
      isInUse: () => false,
    });
    await store.save(isAuthChange);
    await store.remove("isAuthChange");

    expect(await readdir(path.join(root, "lib"))).toEqual(["index.ts"]);
  });

  it("reports an unknown function", async () => {
    const { store } = await storeIn();
    expect(await codeError(() => store.remove("nope"))).toBe("function-not-found");
  });
});

describe("rename", () => {
  it("renames the file, the metadata and the binding in its own source", async () => {
    const { root, store } = await storeIn();
    await store.save(isAuthChange);
    await store.rename("isAuthChange", "touchesAuth");

    expect((await readdir(path.join(root, "lib"))).sort()).toEqual(["index.ts", "touches-auth.ts"]);
    const content = await readFile(path.join(root, "lib", "touches-auth.ts"), "utf8");
    expect(content).toContain('"name": "touchesAuth"');
    expect(content).toContain("export function touchesAuth");
    expect(content).not.toContain("isAuthChange");

    const renamed = await store.get("touchesAuth");
    expect(renamed?.label).toBe("Is Auth Change");
    expect(await store.get("isAuthChange")).toBeNull();
    expect(await readFile(path.join(root, "lib", "index.ts"), "utf8")).toContain(
      './touches-auth.js"',
    );
  });

  it("does NOT rewrite flows importing the old name (03 §11)", async () => {
    const { root, store } = await storeIn();
    await store.save(isAuthChange);
    const flow = `import { isAuthChange } from "@flows/lib";\nexport default async function flow() { return isAuthChange([]); }\n`;
    const flowPath = await write(root, "flows/audit.flow.ts", flow);

    await store.rename("isAuthChange", "touchesAuth");

    expect(await readFile(flowPath, "utf8")).toBe(flow);
  });

  it("rejects renaming onto an existing name, and reports an unknown source", async () => {
    const { store } = await storeIn();
    await store.save(isAuthChange);
    await store.save({ ...isAuthChange, name: "isDocsChange", label: "Is Docs Change" });

    expect(await codeError(() => store.rename("isAuthChange", "isDocsChange"))).toBe(
      "duplicate-function",
    );
    expect(await codeError(() => store.rename("missing", "other"))).toBe("function-not-found");
    expect(await codeError(() => store.rename("isAuthChange", "not an identifier"))).toBe(
      "invalid-function-name",
    );
  });

  it("is a no-op when the name does not change", async () => {
    const { root, store } = await storeIn();
    await store.save(isAuthChange);
    const before = await readFile(path.join(root, "lib", "is-auth-change.ts"), "utf8");

    await store.rename("isAuthChange", "isAuthChange");
    expect(await readFile(path.join(root, "lib", "is-auth-change.ts"), "utf8")).toBe(before);
  });
});

describe("index.ts", () => {
  it("is rebuilt from the files on disk, dropping stale exports", async () => {
    const { root, store } = await storeIn();
    await store.save(isAuthChange);
    await writeFile(
      path.join(root, "lib", "index.ts"),
      'export * from "./deleted-long-ago.js";\n',
      "utf8",
    );

    await store.writeIndex();
    const index = await readFile(path.join(root, "lib", "index.ts"), "utf8");
    expect(index).toContain('export * from "./is-auth-change.js";');
    expect(index).not.toContain("deleted-long-ago");
  });
});
