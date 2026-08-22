/**
 * Command dispatch, the `--agent-md` section (10-ai-codegen.md §3), and the
 * `check` stub.
 */

import { afterEach, describe, expect, it } from "vitest";
import path from "node:path";
import { AGENT_MD_BEGIN, AGENT_MD_END, agentMarkdown } from "../src/agent-md.js";
import { loadWorkspace } from "../src/config.js";
import { generate } from "../src/commands/generate.js";
import { init } from "../src/commands/init.js";
import { run } from "../src/run.js";
import { captureIo, cleanup, tempDir } from "./helpers.js";

afterEach(cleanup);

describe("codeflow init", () => {
  it("scaffolds the standard layout of 10 §2", async () => {
    const root = await tempDir();
    const { out, io } = captureIo();

    expect(await run(["init", root], io)).toBe(0);

    const printed = out.join("\n");
    for (const file of [
      "codeflow.config.ts",
      "tsconfig.json",
      "flows/README.md",
      "lib/is-auth-change.ts",
      "lib/index.ts",
    ]) {
      expect(printed).toContain(file);
    }

    const workspace = await loadWorkspace({ cwd: root });
    expect(workspace.config.tools?.map((tool) => tool.name)).toEqual([
      "github.getNewPRs",
      "github.getFiles",
      "slack.send",
    ]);
  });

  it("maps @flows/lib to lib/ in the scaffolded tsconfig", async () => {
    const root = await tempDir();
    await init({ cwd: root });
    const { io } = captureIo();
    expect(await run(["generate", "--cwd", root], io)).toBe(0);

    const { readFile } = await import("node:fs/promises");
    const tsconfig = JSON.parse(await readFile(path.join(root, "tsconfig.json"), "utf8")) as {
      compilerOptions: { paths: Record<string, string[]> };
    };
    expect(tsconfig.compilerOptions.paths["@flows/lib"]).toEqual(["./lib/index.ts"]);
  });

  it("refuses to overwrite an existing workspace without --force", async () => {
    const root = await tempDir();
    await init({ cwd: root });
    const { err, io } = captureIo();

    expect(await run(["init", root], io)).toBe(1);
    expect(err.join("\n")).toContain("--force");
  });
});

describe("codeflow generate", () => {
  it("reports what it wrote", async () => {
    const root = await tempDir();
    await init({ cwd: root });
    const { out, io } = captureIo();

    expect(await run(["generate", "--cwd", root], io)).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("generated/tools.d.ts");
    expect(printed).toContain("generated/lib.d.ts");
    expect(printed).toContain("3 tool(s), 1 library function(s)");
    expect(printed).toContain("registryHash");
  });

  it("exits non-zero with a readable message when there is no workspace", async () => {
    const root = await tempDir();
    const { err, io } = captureIo();

    expect(await run(["generate", "-C", path.join(root, "nowhere")], io)).toBe(1);
    expect(err.join("\n")).toContain("codeflow init");
  });
});

describe("--agent-md", () => {
  it("emits a delimited section pointing at generated/ and prompts/", async () => {
    const root = await tempDir();
    await init({ cwd: root });
    const { out, io } = captureIo();

    expect(await run(["generate", "--cwd", root, "--agent-md"], io)).toBe(0);
    const printed = out.join("\n");

    expect(printed).toContain(AGENT_MD_BEGIN);
    expect(printed).toContain(AGENT_MD_END);
    expect(printed).toContain("generated/tools.d.ts");
    expect(printed).toContain("generated/lib.d.ts");
    expect(printed).toContain("prompts/flow-style.md");
    expect(printed).toContain("@flows/lib");
    expect(printed).toContain("flows/");
    expect(printed).toContain("codeflow generate");
    expect(printed).toContain("codeflow check");
  });

  it("uses the workspace's own directory names", async () => {
    const root = await tempDir();
    const { write } = await import("./helpers.js");
    await write(
      root,
      "codeflow.config.ts",
      `export default {
  generatedDir: "types",
  promptsDir: "ai",
  flowsDir: "workflows",
  libModulePath: "@acme/lib",
  tools: [],
};
`,
    );
    const workspace = await loadWorkspace({ cwd: root });
    const markdown = agentMarkdown(workspace);

    expect(markdown).toContain("types/tools.d.ts");
    expect(markdown).toContain("ai/flow-style.md");
    expect(markdown).toContain("workflows/");
    expect(markdown).toContain("@acme/lib");
  });

  it("is also returned from the programmatic API", async () => {
    const root = await tempDir();
    await init({ cwd: root });
    const result = await generate({ cwd: root, agentMd: true });

    expect(result.agentMd).toContain(AGENT_MD_BEGIN);
    expect((await generate({ cwd: root })).agentMd).toBeUndefined();
  });
});

describe("codeflow check", () => {
  it("fails a workspace whose generated artifacts were never produced", async () => {
    const root = await tempDir();
    await init({ cwd: root });
    const { out, io } = captureIo();

    // `init` scaffolds but never writes generated/ — that is `generate`'s job, so
    // a workspace checked before generating is stale, not silently fine.
    expect(await run(["check", "--cwd", root], io)).toBe(1);
    expect(out.join("\n")).toContain("stale-generated-artifacts");
  });

  it("passes once the workspace has been generated", async () => {
    const root = await tempDir();
    await init({ cwd: root });
    await generate({ cwd: root });
    const { out, io } = captureIo();

    expect(await run(["check", "--cwd", root], io)).toBe(0);
    expect(out.join("\n")).toContain("ok — 0 flows checked");
  });
});

describe("usage", () => {
  it("prints help and exits 2 with no command", async () => {
    const { out, io } = captureIo();
    expect(await run([], io)).toBe(2);
    expect(out.join("\n")).toContain("codeflow generate");
  });

  it("prints help and exits 0 for --help", async () => {
    const { out, io } = captureIo();
    expect(await run(["--help"], io)).toBe(0);
    expect(out.join("\n")).toContain("Usage");
  });

  it("rejects an unknown command", async () => {
    const { err, io } = captureIo();
    expect(await run(["frobnicate"], io)).toBe(2);
    expect(err.join("\n")).toContain('unknown command "frobnicate"');
  });

  it("prints the version", async () => {
    const { out, io } = captureIo();
    expect(await run(["--version"], io)).toBe(0);
    expect(out.join("\n")).toMatch(/^\d+\.\d+\.\d+/);
  });
});
