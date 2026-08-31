/**
 * What a whole-file rewrite costs, counted in steps.
 *
 * QA BUG-5: a rewrite that was asked to delete one step deleted two, and the
 * only evidence was 340 lines of diff. These tests pin the two claims the panel
 * makes above the Apply button — the counts, and how loudly a removal is said.
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow, createRegistry, type WorkflowGraph } from "@codeflow-team/core";
import { removalTone, rewriteScope } from "../src/rewrite-scope.js";

const registry = createRegistry({
  tools: [
    { name: "fs.read", label: "Read Text File", inputSchema: { type: "object", properties: { path: { type: "string" } } }, editableFields: ["path"] },
    { name: "fs.write", label: "Write Text File", inputSchema: { type: "object", properties: { path: { type: "string" } } }, editableFields: ["path"] },
    { name: "browser.snapshot", label: "Take Snapshot", inputSchema: { type: "object", properties: {} } },
  ],
});

async function analyze(body: string): Promise<WorkflowGraph> {
  // A cold session per file: two independently analyzed graphs is exactly the
  // situation `rewriteScope` exists for.
  return await createCodeFlow({ registry }).analyze(
    `import type { Tools } from "./generated/tools";\n\nexport default async function flow(input: { path: string }, tools: Tools) {\n${body}\n}\n`,
    { trigger: { kind: "webhook", label: "Trigger" } },
  );
}

const THREE = `  const a = await tools.fs.read({ path: input.path });
  await tools.browser.snapshot({});
  await tools.fs.write({ path: "out.txt" });`;

describe("rewrite scope", () => {
  it("counts a step that disappears", async () => {
    const before = await analyze(THREE);
    const after = await analyze(`  const a = await tools.fs.read({ path: input.path });
  await tools.fs.write({ path: "out.txt" });`);

    const scope = rewriteScope(before, after);
    expect(scope.removed).toEqual(["Take Snapshot"]);
    expect(scope.added).toEqual([]);
    expect(scope.before - scope.after).toBe(1);
  });

  it("counts a step that appears", async () => {
    const before = await analyze(THREE);
    const after = await analyze(`${THREE}\n  await tools.browser.snapshot({});`);

    const scope = rewriteScope(before, after);
    expect(scope.added).toEqual(["Take Snapshot"]);
    expect(scope.removed).toEqual([]);
  });

  it("counts a step that stays but changes", async () => {
    const before = await analyze(THREE);
    const after = await analyze(`  const a = await tools.fs.read({ path: input.path });
  await tools.browser.snapshot({});
  await tools.fs.write({ path: "somewhere-else.txt" });`);

    const scope = rewriteScope(before, after);
    expect(scope.added).toEqual([]);
    expect(scope.removed).toEqual([]);
    expect(scope.changed).toBe(1);
  });

  it("sees nothing when only the formatting moved", async () => {
    const before = await analyze(THREE);
    const after = await analyze(THREE.replace(/\n/g, "\n\n"));

    const scope = rewriteScope(before, after);
    expect([scope.added.length, scope.removed.length, scope.changed]).toEqual([0, 0, 0]);
  });
});

describe("how loudly a removal is said", () => {
  const scope = (removed: string[]) => ({ before: 3, after: 3 - removed.length, added: [], removed, changed: 0 });

  it("stays quiet when nothing was removed", () => {
    expect(removalTone(scope([]), "add a retry")).toBe("none");
  });

  it("is expected when one step was asked for and one step went", () => {
    expect(removalTone(scope(["Read Text File"]), "delete this step")).toBe("expected");
  });

  it("warns when a step goes that the request never mentioned", () => {
    expect(removalTone(scope(["Take Snapshot"]), "make the screenshot full page")).toBe("unrequested");
  });

  it("warns when more went than was asked for — the BUG-5 shape", () => {
    expect(removalTone(scope(["Read Text File", "Take Snapshot"]), "delete this step")).toBe("unrequested");
  });
});
