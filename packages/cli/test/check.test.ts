/**
 * `codeflow check` on scratch workspaces — 02-architecture.md §2, 10 §8.
 *
 * The three things the command exists to catch, each with its own workspace:
 * a clean flow must be silent, an invented tool must fail the workspace, and a
 * registry that moved without a re-generate must be reported instead of
 * silently producing a graph against the wrong contract (05 §2).
 */

import { afterEach, describe, expect, it } from "vitest";
import { cp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { check, checkToJson, formatCheck } from "../src/commands/check.js";
import { generate } from "../src/commands/generate.js";
import { init } from "../src/commands/init.js";
import { loadWorkspace } from "../src/config.js";
import { createLibraryStore } from "../src/library/store.js";
import { buildUsageIndex } from "../src/usage.js";
import { run } from "../src/run.js";
import { captureIo, cleanup, tempDir, write } from "./helpers.js";

afterEach(cleanup);

/** The canonical flow of the specs — 01 §1 / 07 §6. */
const CANONICAL_FLOW = `import type { Tools } from "../generated/tools";
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
`;

/** An init'd + generated workspace, optionally with flows written into it. */
async function workspace(flows: Record<string, string> = {}): Promise<string> {
  const root = await tempDir();
  await init({ cwd: root });
  for (const [name, source] of Object.entries(flows)) {
    await write(root, path.join("flows", name), source);
  }
  await generate({ cwd: root });
  return root;
}

describe("a clean workspace", () => {
  it("passes with no diagnostics and exits 0", async () => {
    const root = await workspace({ "security-alert.flow.ts": CANONICAL_FLOW });
    const result = await check({ cwd: root });

    expect(result.ok).toBe(true);
    expect(result.stale).toEqual([]);
    expect(result.flows).toHaveLength(1);

    const [flow] = result.flows;
    expect(flow?.relativePath).toBe("flows/security-alert.flow.ts");
    expect(flow?.diagnostics).toEqual([]);
    // Resolves everything and hides no call: the top of the ladder (10 §5).
    expect(flow?.level).toBe("L2");
    expect(flow?.nodeCount).toBeGreaterThan(0);

    const { out, io } = captureIo();
    expect(await run(["check", "--cwd", root], io)).toBe(0);
    const printed = out.join("\n");
    expect(printed).toContain("flows/security-alert.flow.ts — L2");
    expect(printed).toContain("no diagnostics");
    expect(printed).toContain("registryHash");
  });

  it("reports an empty workspace as clean rather than as an error", async () => {
    const root = await workspace();
    const result = await check({ cwd: root });

    expect(result.ok).toBe(true);
    expect(result.flows).toEqual([]);
    expect(formatCheck(result).join("\n")).toContain("No flows found in flows/");
  });
});

describe("a flow calling a tool that does not exist", () => {
  it("reports unresolved-tool and exits 1", async () => {
    const root = await workspace({
      "invented.flow.ts": `import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  const summary = await tools.github.summarizeEverything({ repo: input.repository });
  return summary;
}
`,
    });

    const result = await check({ cwd: root });
    expect(result.ok).toBe(false);
    expect(result.counts.error).toBe(1);

    const [flow] = result.flows;
    const errors = flow?.diagnostics.filter((diagnostic) => diagnostic.severity === "error") ?? [];
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe("unresolved-tool");
    expect(errors[0]?.message).toContain("github.summarizeEverything");
    // The call is still on the graph — as an unknown node, never swallowed (I6).
    expect(errors[0]?.source?.start.line).toBe(4);
    // Nothing invented means nothing above L0 (10 §5).
    expect(flow?.level).toBe("L0");

    const { out, io } = captureIo();
    expect(await run(["check", "--cwd", root], io)).toBe(1);
    const printed = out.join("\n");
    expect(printed).toContain("unresolved-tool");
    expect(printed).toContain("4:");
    expect(printed).toContain("failed — 1 error");
  });

  it("reports a flow importing a library function that is gone", async () => {
    const root = await workspace({
      "ghost.flow.ts": `import type { Tools } from "../generated/tools";
import { isDocsChange } from "@flows/lib";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const docs = isDocsChange(prs);
  return docs;
}
`,
    });

    const result = await check({ cwd: root });
    expect(result.ok).toBe(false);
    expect(
      result.flows[0]?.diagnostics.some(
        (diagnostic) =>
          diagnostic.severity === "error" && diagnostic.code === "unresolved-library-function",
      ),
    ).toBe(true);
    // Still counted as a usage — that is precisely why the rename broke it.
    expect(result.usage.byFunction.get("isDocsChange")).toEqual(["flows/ghost.flow.ts"]);
  });

  it("groups diagnostics by file and keeps clean flows clean", async () => {
    const root = await workspace({
      "good.flow.ts": CANONICAL_FLOW,
      "bad.flow.ts": `import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  await tools.github.nope({ repo: input.repository });
}
`,
    });

    const result = await check({ cwd: root });
    expect(result.flows.map((flow) => flow.relativePath)).toEqual([
      "flows/bad.flow.ts",
      "flows/good.flow.ts",
    ]);
    expect(result.flows[0]?.counts.error).toBe(1);
    expect(result.flows[1]?.counts.error).toBe(0);
  });
});

describe("generated artifacts that no longer match the registry", () => {
  it("detects a config change that was never re-generated", async () => {
    const root = await workspace({ "security-alert.flow.ts": CANONICAL_FLOW });
    expect((await check({ cwd: root })).stale).toEqual([]);

    // A config file is imported once per process (config.ts documents that), so
    // the honest way to observe "the config gained a tool and nobody
    // re-generated" is a copy of the workspace carrying the new config next to
    // the artifacts built from the old registry (05 §2).
    const moved = await tempDir();
    await cp(root, moved, { recursive: true });
    const config = await readFile(path.join(moved, "codeflow.config.ts"), "utf8");
    await write(
      moved,
      "codeflow.config.ts",
      config.replace(
        "  tools: [",
        `  tools: [
    {
      name: "slack.react",
      label: "React To Message",
      inputSchema: { channel: "string", emoji: "string" },
    },`,
      ),
    );

    const result = await check({ cwd: moved });
    expect(result.ok).toBe(false);
    expect(result.stale.map((artifact) => artifact.relativePath).sort()).toEqual([
      "generated/lib.d.ts",
      "generated/tools.d.ts",
    ]);
    expect(result.stale[0]?.found).not.toBe(result.registryHash);
    expect(result.stale[0]?.missing).toBe(false);
    // The flow itself is still fine — staleness is a workspace-level failure.
    expect(result.flows[0]?.counts.error).toBe(0);
    expect(result.counts.error).toBe(2);

    const { out, io } = captureIo();
    expect(await run(["check", "--cwd", moved], io)).toBe(1);
    expect(out.join("\n")).toContain("stale-generated-artifacts");
    expect(out.join("\n")).toContain("codeflow generate");

    // …and re-generating clears it.
    await generate({ cwd: moved });
    expect((await check({ cwd: moved })).ok).toBe(true);
  });

  it("detects a library function added after the last generate", async () => {
    const root = await workspace({ "security-alert.flow.ts": CANONICAL_FLOW });
    const store = createLibraryStore(await loadWorkspace({ cwd: root }));

    await store.save({
      name: "isDocsChange",
      label: "Is Docs Change",
      inputSchema: { file: "{ path: string }" },
      outputSchema: "boolean",
      code: 'export function isDocsChange(file: { path: string }): boolean {\n  return file.path.endsWith(".md");\n}\n',
      modulePath: "@flows/lib",
    });

    // The library is part of the registry (05 §4), so the artifacts are stale
    // even though no config changed.
    const result = await check({ cwd: root });
    expect(result.ok).toBe(false);
    expect(result.stale).toHaveLength(2);
    expect(result.libraryFunctionNames).toEqual(["isAuthChange", "isDocsChange"]);
  });

  it("treats a missing artifact as stale", async () => {
    const root = await workspace();
    await rm(path.join(root, "generated", "tools.d.ts"));

    const result = await check({ cwd: root });
    expect(result.ok).toBe(false);
    expect(result.stale).toEqual([
      {
        relativePath: "generated/tools.d.ts",
        found: null,
        expected: result.registryHash,
        missing: true,
      },
    ]);
    expect(formatCheck(result).join("\n")).toContain("missing");
  });
});

describe("the usage index", () => {
  it("says which flow uses which library function", async () => {
    const root = await workspace({
      "security-alert.flow.ts": CANONICAL_FLOW,
      "audit.flow.ts": `import type { Tools } from "../generated/tools";
import { isAuthChange as touchesAuth } from "@flows/lib";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });
  const files = await tools.github.getFiles({ pr: prs[0] });
  const flagged = files.filter(touchesAuth);
  return flagged;
}
`,
      "unrelated.flow.ts": `import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  return await tools.github.getNewPRs({ repo: input.repository });
}
`,
    });

    const result = await check({ cwd: root });
    // The alias imports `isAuthChange`, so that is the name the library owns.
    expect(result.usage.byFunction.get("isAuthChange")).toEqual([
      "flows/audit.flow.ts",
      "flows/security-alert.flow.ts",
    ]);
    expect(result.usage.byFlow.get("flows/unrelated.flow.ts")).toEqual([]);
    expect(result.usage.isInUse("isAuthChange")).toBe(true);
    expect(result.usage.isInUse("isDocsChange")).toBe(false);
    expect(formatCheck(result).join("\n")).toContain(
      "isAuthChange  ← flows/audit.flow.ts, flows/security-alert.flow.ts",
    );
  });

  it("ignores type-only imports and imports from elsewhere", async () => {
    const root = await workspace({
      "types-only.flow.ts": `import type { Tools } from "../generated/tools";
import type { isAuthChange } from "@flows/lib";

export default async function flow(input: { repository: string }, tools: Tools) {
  return await tools.github.getNewPRs({ repo: input.repository });
}
`,
    });

    const index = await buildUsageIndex(await loadWorkspace({ cwd: root }));
    expect(index.isInUse("isAuthChange")).toBe(false);
    expect(index.list()).toEqual([]);
  });

  it("counts a relative import that lands in lib/ as a usage", async () => {
    const root = await workspace({
      "relative.flow.ts": `import type { Tools } from "../generated/tools";
import { isAuthChange } from "../lib/index.js";

export default async function flow(input: { repository: string }, tools: Tools) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });
  return prs.filter(() => isAuthChange({ path: "x" }));
}
`,
    });

    const index = await buildUsageIndex(await loadWorkspace({ cwd: root }));
    expect(index.byFunction.get("isAuthChange")).toEqual(["flows/relative.flow.ts"]);
  });

  it("is the isInUse guard of the library store (03 §11)", async () => {
    const root = await workspace({ "security-alert.flow.ts": CANONICAL_FLOW });
    const ws = await loadWorkspace({ cwd: root });
    const store = createLibraryStore(ws);

    await expect(store.remove("isAuthChange")).rejects.toMatchObject({ code: "function-in-use" });
    // The guard is a warning gate, not a wall — the user can still confirm.
    await expect(store.remove("isAuthChange", { force: true })).resolves.toBeUndefined();
    expect(await store.get("isAuthChange")).toBeNull();
  });

  it("lets an unused function be removed without a confirmation", async () => {
    const root = await workspace();
    const store = createLibraryStore(await loadWorkspace({ cwd: root }));

    await expect(store.remove("isAuthChange")).resolves.toBeUndefined();
  });
});

describe("--json", () => {
  it("prints a machine-readable report", async () => {
    const root = await workspace({
      "security-alert.flow.ts": CANONICAL_FLOW,
      "bad.flow.ts": `import type { Tools } from "../generated/tools";

export default async function flow(input: { repository: string }, tools: Tools) {
  await tools.github.nope({});
}
`,
    });

    const { out, io } = captureIo();
    expect(await run(["check", "--cwd", root, "--json"], io)).toBe(1);

    const report = JSON.parse(out.join("\n")) as ReturnType<typeof checkToJson>;
    expect(report["ok"]).toBe(false);
    expect(report["counts"]).toEqual({ error: 1, warning: 0, info: 0 });
    expect(report["usage"]).toEqual({ isAuthChange: ["flows/security-alert.flow.ts"] });
    expect(report["unusedLibraryFunctions"]).toEqual([]);

    const flows = report["flows"] as Array<Record<string, unknown>>;
    expect(flows.map((flow) => flow["file"])).toEqual([
      "flows/bad.flow.ts",
      "flows/security-alert.flow.ts",
    ]);
    const diagnostics = flows[0]?.["diagnostics"] as Array<Record<string, unknown>>;
    expect(diagnostics[0]).toMatchObject({
      severity: "error",
      code: "unresolved-tool",
      line: 4,
    });
  });
});

describe("failure modes", () => {
  it("reports a missing workspace instead of guessing", async () => {
    const root = await tempDir();
    const { err, io } = captureIo();

    expect(await run(["check", "-C", path.join(root, "nowhere")], io)).toBe(1);
    expect(err.join("\n")).toContain("codeflow init");
  });

  it("reports a flow that does not parse without crashing the run", async () => {
    const root = await workspace({
      "broken.flow.ts": "export default async function flow(input, tools) { const x = ;\n",
    });

    const result = await check({ cwd: root });
    expect(result.ok).toBe(false);
    expect(result.flows[0]?.level).toBe("invalid");
    expect(result.flows[0]?.nodeCount).toBeNull();
    expect(result.flows[0]?.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "parse-error",
    );
    expect(formatCheck(result).join("\n")).toContain("does not parse");
  });
});
