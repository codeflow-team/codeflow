/**
 * The package's own guard rails.
 *
 * Two committed artifacts are generated from something else: `src/tools/*.ts`
 * from the captured MCP payloads in `packages/mcp/test/real-schemas`, and
 * `src/generated/sources.ts` from `flows/*.flow.ts`. They are committed because
 * a generated file that nobody can read in a diff is a file nobody reviews —
 * and that only stays true if drift is impossible.
 *
 * Everything else here checks the two claims the package makes about itself:
 * the tool definitions really are the servers' own schemas (not something
 * hand-typed that resembles them), and each example's `source` really is the
 * flow file of the same name.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { EXAMPLES, REGISTRIES } from "../src/index.js";
import { FILESYSTEM_TOOLS } from "../src/tools/filesystem.js";
import { MEMORY_TOOLS } from "../src/tools/memory.js";
import { PLAYWRIGHT_TOOLS } from "../src/tools/playwright.js";
import { EVERYTHING_TOOLS } from "../src/tools/everything.js";
import { CONTEXT7_TOOLS } from "../src/tools/context7.js";
import { DEEPWIKI_TOOLS } from "../src/tools/deepwiki.js";
import { DUCKDUCKGO_TOOLS } from "../src/tools/duckduckgo.js";
import { SEQUENTIAL_THINKING_TOOLS } from "../src/tools/sequential-thinking.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(ROOT, "..", "mcp", "test", "real-schemas");

describe("generated files", () => {
  it("are exactly what the generators produce today", () => {
    // Re-runs both generators in memory and diffs against the checkout.
    const output = execFileSync("node", [join(ROOT, "scripts", "check-generated.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(output).toContain("up to date");
  });
});

describe("the tool definitions are the servers' own schemas", () => {
  const CAPTURED: [string, string, unknown[]][] = [
    ["filesystem", "filesystem.json", FILESYSTEM_TOOLS],
    ["memory", "memory.json", MEMORY_TOOLS],
    ["playwright", "playwright.json", PLAYWRIGHT_TOOLS],
    ["everything", "everything.json", EVERYTHING_TOOLS],
    ["context7", "context7.json", CONTEXT7_TOOLS],
    ["deepwiki", "deepwiki.json", DEEPWIKI_TOOLS],
    ["duckduckgo", "duckduckgo.json", DUCKDUCKGO_TOOLS],
    ["sequential-thinking", "sequential-thinking.json", SEQUENTIAL_THINKING_TOOLS],
  ];

  it.each(CAPTURED)("%s has one definition per captured tool", (_server, file, definitions) => {
    const capture = JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as {
      toolCount: number;
      tools: { name: string; inputSchema?: unknown }[];
    };
    expect(definitions).toHaveLength(capture.toolCount);
  });

  it("carries all 65 real tools across eight servers", () => {
    const total =
      FILESYSTEM_TOOLS.length +
      MEMORY_TOOLS.length +
      PLAYWRIGHT_TOOLS.length +
      EVERYTHING_TOOLS.length +
      CONTEXT7_TOOLS.length +
      DEEPWIKI_TOOLS.length +
      DUCKDUCKGO_TOOLS.length +
      SEQUENTIAL_THINKING_TOOLS.length;
    expect(total).toBe(65);
  });

  it("passes each server's input schema through untouched", () => {
    // The adapter copies `inputSchema` verbatim (05 §3). If that ever stopped
    // being true, the examples would be type-checking against a schema this
    // package invented rather than one a server published.
    const capture = JSON.parse(readFileSync(join(SCHEMA_DIR, "filesystem.json"), "utf8")) as {
      tools: { name: string; inputSchema: unknown }[];
    };
    const editFile = capture.tools.find((tool) => tool.name === "edit_file")!;
    const definition = FILESYSTEM_TOOLS.find((tool) => tool.name === "fs.editFile")!;
    expect(definition.inputSchema).toEqual(editFile.inputSchema);
  });

  it("strips the prefix playwright repeats on every tool", () => {
    // `browser_click` → `tools.browser.click`, not `tools.browser.browserClick`.
    expect(PLAYWRIGHT_TOOLS.map((tool) => tool.name)).toContain("browser.click");
    expect(PLAYWRIGHT_TOOLS.every((tool) => !tool.name.startsWith("browser.browser"))).toBe(true);
  });
});

describe("every example's source is the flow file of the same name", () => {
  const flowFiles = readdirSync(join(ROOT, "flows")).filter((file) => file.endsWith(".flow.ts"));

  it("has one flow file per example and no orphans", () => {
    expect(flowFiles.map((file) => file.replace(".flow.ts", "")).sort()).toEqual(
      EXAMPLES.map((example) => example.id).sort(),
    );
  });

  it.each(EXAMPLES.map((example) => [example.id, example] as const))(
    "%s matches flows/%s.flow.ts byte for byte",
    (id, example) => {
      const onDisk = readFileSync(join(ROOT, "flows", `${id}.flow.ts`), "utf8");
      expect(example.source).toBe(onDisk);
      expect(example.lines).toBe(onDisk.replace(/\n$/, "").split("\n").length);
    },
  );
});

describe("every registry is well formed", () => {
  it.each(Object.keys(REGISTRIES))("%s has unique, namespaced tool names", (id) => {
    const registry = REGISTRIES[id];
    const names = registry.tools.map((tool) => tool.name);
    expect(new Set(names).size, `duplicate tool in ${id}`).toBe(names.length);
    for (const name of names) expect(name, id).toMatch(/^[A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*$/);

    const functions = registry.functions.map((fn) => fn.name);
    expect(new Set(functions).size, `duplicate function in ${id}`).toBe(functions.length);
    for (const fn of registry.functions) {
      expect(fn.modulePath, id).toBe("@flows/lib");
      // The named-fields schema is the bridge to positional arguments (05 §4):
      // every key has to appear as a parameter in the function's own code.
      for (const key of Object.keys(fn.inputSchema as Record<string, unknown>)) {
        expect(fn.code, `${fn.name}(${key})`).toContain(key);
      }
    }
  });

  it("is referenced by at least one example", () => {
    const used = new Set(EXAMPLES.map((example) => example.registryId));
    expect([...used].sort()).toEqual(Object.keys(REGISTRIES).sort());
  });
});
