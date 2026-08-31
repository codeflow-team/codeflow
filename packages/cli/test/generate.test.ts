/**
 * `codeflow generate` end-to-end on a scratch workspace — 10-ai-codegen.md §2,
 * 05-registry.md §2.
 *
 * The property that matters: `generated/*.d.ts` are derived artifacts of the
 * registry, they say which registry they came from, and drift is detectable.
 */

import { afterEach, describe, expect, it } from "vitest";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createRegistry, isGeneratedArtifactStale, readGeneratedRegistryHash } from "@codeflow-team/core";
import { generate } from "../src/commands/generate.js";
import { init } from "../src/commands/init.js";
import { loadConfigFile } from "../src/config.js";
import { FileFunctionLibraryStore } from "../src/library/file-store.js";
import { cleanup, tempDir, write } from "./helpers.js";

afterEach(cleanup);

const read = (root: string, relative: string): Promise<string> =>
  readFile(path.join(root, relative), "utf8");

async function scaffolded(): Promise<string> {
  const root = await tempDir();
  await init({ cwd: root });
  return root;
}

describe("init → generate", () => {
  it("produces the standard workspace layout", async () => {
    const root = await scaffolded();
    const result = await generate({ cwd: root });

    expect(result.files.map((file) => file.relativePath).sort()).toEqual([
      "generated/lib.d.ts",
      "generated/tools.d.ts",
      "lib/index.ts",
      "prompts/flow-style.md",
    ]);
    expect(result.toolCount).toBe(3);
    expect(result.libraryFunctions).toEqual(["isAuthChange"]);
  });

  it("writes a tools interface the flow contract can consume", async () => {
    const root = await scaffolded();
    await generate({ cwd: root });
    const tools = await read(root, "generated/tools.d.ts");

    expect(tools).toContain("export interface Tools {");
    expect(tools).toContain("github: {");
    expect(tools).toContain("getNewPRs(input: { repo: string }): Promise<");
    expect(tools).toContain("getFiles(input: { pr: {");
    expect(tools).toContain("slack: {");
    expect(tools).toContain("send(input: { channel: string; message: string }): Promise<unknown>;");
    // JSDoc from the tool description — this is what the AI reads.
    expect(tools).toContain("/** Get new pull requests for a repository */");
    expect(tools).toContain("DO NOT EDIT");
  });

  it("declares the library module from the functions in lib/", async () => {
    const root = await scaffolded();
    await generate({ cwd: root });
    const lib = await read(root, "generated/lib.d.ts");

    expect(lib).toContain('declare module "@flows/lib" {');
    expect(lib).toContain(
      "export function isAuthChange(file: { path: string }): boolean;",
    );
    expect(lib).toContain("/** True when a changed file touches authentication code */");
  });

  it("stamps both artifacts with the registry hash of the registry they came from", async () => {
    const root = await scaffolded();
    const result = await generate({ cwd: root });

    const tools = await read(root, "generated/tools.d.ts");
    const lib = await read(root, "generated/lib.d.ts");
    expect(readGeneratedRegistryHash(tools)).toBe(result.registryHash);
    expect(readGeneratedRegistryHash(lib)).toBe(result.registryHash);

    // Recompute the hash independently: config tools + lib/ functions, straight
    // through core. Same registry content must give the same fingerprint.
    const config = await loadConfigFile(path.join(root, "codeflow.config.ts"));
    const store = new FileFunctionLibraryStore({ dir: path.join(root, "lib") });
    const registry = createRegistry({
      tools: config.tools ?? [],
      functions: await store.list(),
    });
    expect(registry.registryHash()).toBe(result.registryHash);
    expect(isGeneratedArtifactStale(tools, registry.registryHash())).toBe(false);
  });

  it("detects a stale artifact once the library changes", async () => {
    const root = await scaffolded();
    const first = await generate({ cwd: root });
    const before = await read(root, "generated/tools.d.ts");

    const store = new FileFunctionLibraryStore({ dir: path.join(root, "lib") });
    await store.save({
      name: "isDocsChange",
      label: "Is Docs Change",
      inputSchema: { files: "{ path: string }[]" },
      outputSchema: "boolean",
      code: "export function isDocsChange(files: { path: string }[]): boolean {\n  return files.every((f) => f.path.endsWith(\".md\"));\n}\n",
      modulePath: "@flows/lib",
    });

    const second = await generate({ cwd: root });
    expect(second.registryHash).not.toBe(first.registryHash);
    expect(isGeneratedArtifactStale(before, second.registryHash)).toBe(true);
    expect(await read(root, "generated/lib.d.ts")).toContain("export function isDocsChange(");
    expect(await read(root, "lib/index.ts")).toContain('export * from "./is-docs-change.js";');
  });

  it("is idempotent — a second run rewrites nothing", async () => {
    const root = await scaffolded();
    await generate({ cwd: root });
    const second = await generate({ cwd: root });

    expect(second.files.filter((file) => file.changed)).toEqual([]);
  });

  it("seeds prompts/flow-style.md once and never overwrites a customised copy", async () => {
    const root = await scaffolded();
    await generate({ cwd: root });
    const style = await read(root, "prompts/flow-style.md");
    expect(style).toContain("# Flow style guide");
    expect(style).toContain("export default async function flow(");
    expect(style).toContain("Never hide a call inside an expression");

    await write(root, "prompts/flow-style.md", "# House rules\n");
    const again = await generate({ cwd: root });
    expect(await read(root, "prompts/flow-style.md")).toBe("# House rules\n");
    expect(again.files.map((file) => file.relativePath)).not.toContain("prompts/flow-style.md");
  });

  it("finds the config from a nested directory", async () => {
    const root = await scaffolded();
    const result = await generate({ cwd: path.join(root, "flows") });
    expect(result.workspace.root).toBe(path.resolve(root));
  });
});

describe("the generated artifacts are usable", () => {
  it("type-checks the canonical flow of the specs in the scaffolded workspace", async () => {
    const root = await scaffolded();
    await generate({ cwd: root });

    // 01-flow-contract.md §1 / 07-ui.md §6, the running example of the specs.
    await write(
      root,
      "flows/security-alert.flow.ts",
      `import type { Tools } from "../generated/tools";
import { isAuthChange } from "@flows/lib";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });

  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr });

    if (files.some(isAuthChange)) {
      await tools.slack.send({
        channel: "#security",
        message: \`Security PR: \${pr.title}\`,
      });
    }
  }
}
`,
    );

    const { createRequire } = await import("node:module");
    const { execFile } = await import("node:child_process");
    const tsc = createRequire(import.meta.url).resolve("typescript/bin/tsc");

    const result = await new Promise<{ code: number; output: string }>((resolve) => {
      execFile(process.execPath, [tsc, "--noEmit", "-p", root], (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : 1, output: `${stdout}${stderr}` });
      });
    });

    // Proves three things at once: the tools interface resolves from
    // ../generated/tools, @flows/lib maps to the real source in lib/, and the
    // schemas the registry declared became types a flow can actually satisfy.
    expect(result.output).toBe("");
    expect(result.code).toBe(0);
  }, 30_000);
});

describe("config shapes", () => {
  it("accepts a default-exported config object", async () => {
    const root = await tempDir();
    await write(
      root,
      "codeflow.config.ts",
      `export default {
  tools: [
    { name: "http.get", label: "HTTP GET", inputSchema: { url: "string" }, outputSchema: "string" },
  ],
};
`,
    );
    const result = await generate({ cwd: root });
    expect(result.toolCount).toBe(1);
    expect(await read(root, "generated/tools.d.ts")).toContain(
      "get(input: { url: string }): Promise<string>;",
    );
  });

  it("accepts a factory function, sync or async", async () => {
    const root = await tempDir();
    await write(
      root,
      "codeflow.config.ts",
      `export default async function config() {
  return {
    tools: [{ name: "http.get", label: "HTTP GET", inputSchema: { url: "string" } }],
  };
}
`,
    );
    expect((await generate({ cwd: root })).toolCount).toBe(1);
  });

  it("accepts a registry instance as the default export", async () => {
    const root = await tempDir();
    await write(
      root,
      "codeflow.config.ts",
      `import { createRegistry } from ${JSON.stringify(coreEntry())};

export default createRegistry({
  tools: [{ name: "http.get", label: "HTTP GET", inputSchema: { url: "string" } }],
});
`,
    );
    const result = await generate({ cwd: root });
    expect(result.toolCount).toBe(1);
    expect(await read(root, "generated/tools.d.ts")).toContain("http: {");
  });

  it("honours layout overrides and a scoped namespace list", async () => {
    const root = await tempDir();
    await write(
      root,
      "codeflow.config.ts",
      `export default {
  generatedDir: "types",
  libDir: "functions",
  namespaces: ["slack"],
  tools: [
    { name: "http.get", label: "HTTP GET", inputSchema: { url: "string" } },
    { name: "slack.send", label: "Send", inputSchema: { channel: "string" } },
  ],
};
`,
    );
    await generate({ cwd: root });
    const tools = await read(root, "types/tools.d.ts");
    expect(tools).toContain("slack: {");
    expect(tools).not.toContain("http: {");
    // No library directory, no library: generate does not invent one.
    await expect(read(root, "functions/index.ts")).rejects.toThrow();
    expect(await read(root, "types/lib.d.ts")).toContain("No library functions are registered.");
  });

  it("reports a missing config instead of guessing", async () => {
    const root = await tempDir();
    await rm(path.join(root, "codeflow.config.ts"), { force: true });
    await expect(generate({ cwd: root })).rejects.toMatchObject({ code: "config-not-found" });
  });

  it("reports a config whose default export is not usable", async () => {
    const root = await tempDir();
    await write(root, "codeflow.config.ts", "export default 42;\n");
    await expect(generate({ cwd: root })).rejects.toMatchObject({ code: "invalid-config" });
  });
});

/** Absolute specifier for `@codeflow-team/core`, so a temp workspace outside the repo can import it. */
function coreEntry(): string {
  return new URL("../../core/dist/index.js", import.meta.url).href;
}
