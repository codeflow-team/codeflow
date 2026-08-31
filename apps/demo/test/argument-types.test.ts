/**
 * The check QA BUG-3 asked for, and the silence it promises everywhere else.
 *
 * Two halves matter equally: a literal that contradicts its schema must be
 * reported, and anything the browser cannot know for certain must produce
 * nothing at all. A check that guesses would be a second way of lying.
 */

import { describe, expect, it } from "vitest";
import { createCodeFlow, createRegistry, type WorkflowGraph } from "@codeflow-team/core";
import { argumentTypeProblems, withArgumentTypes } from "../src/argument-types.js";

const registry = createRegistry({
  tools: [
    {
      name: "browser.resize",
      label: "Resize browser window",
      inputSchema: {
        type: "object",
        properties: {
          width: { type: "number" },
          height: { type: "number" },
          label: { type: "string" },
          headless: { type: "boolean" },
          tags: { type: "array" },
          retries: { type: ["number", "null"] },
        },
        required: ["width", "height"],
      },
      editableFields: ["width", "height", "label", "headless", "tags", "retries"],
    },
  ],
});

const session = createCodeFlow({ registry });

async function analyze(body: string): Promise<WorkflowGraph> {
  return await session.analyze(
    `import type { Tools } from "./generated/tools";\n\nexport default async function flow(input: { n: number }, tools: Tools) {\n${body}\n}\n`,
    { trigger: { kind: "webhook", label: "Trigger" } },
  );
}

describe("argument type problems", () => {
  it("reports text written where the schema wants a number", async () => {
    const graph = await analyze(`  await tools.browser.resize({ width: "extra-wide", height: 720 });`);
    const problems = argumentTypeProblems(graph, registry);

    expect(problems).toHaveLength(1);
    expect(problems[0]?.field).toBe("width");
    expect(problems[0]?.found).toBe("string");
    expect(problems[0]?.message).toContain("wants a number");
  });

  it("reports a number written where the schema wants text, and true/false the same way", async () => {
    const graph = await analyze(
      `  await tools.browser.resize({ width: 1, height: 2, label: 12, headless: "yes" });`,
    );
    const problems = argumentTypeProblems(graph, registry).map((problem) => problem.field).sort();

    expect(problems).toEqual(["headless", "label"]);
  });

  it("says nothing about a value it cannot know — an expression, a call, a variable", async () => {
    const graph = await analyze(
      `  const w = input.n;\n  await tools.browser.resize({ width: w, height: Math.max(1, input.n), label: \`w-\${w}\` });`,
    );

    // `label` is a template literal: still a string, still fine. `width` and
    // `height` are expressions — no checker here, so no claim either way.
    expect(argumentTypeProblems(graph, registry)).toEqual([]);
  });

  it("says nothing about a deliberate cast, which is code and not a literal", async () => {
    const graph = await analyze(
      `  await tools.browser.resize({ width: "extra-wide" as unknown as number, height: 720 });`,
    );

    expect(argumentTypeProblems(graph, registry)).toEqual([]);
  });

  it("accepts null where the schema allows it", async () => {
    const graph = await analyze(`  await tools.browser.resize({ width: 1, height: 2, retries: null });`);

    expect(argumentTypeProblems(graph, registry)).toEqual([]);
  });

  it("accepts a list where the schema wants one, and rejects one where it does not", async () => {
    const good = await analyze(`  await tools.browser.resize({ width: 1, height: 2, tags: ["a"] });`);
    expect(argumentTypeProblems(good, registry)).toEqual([]);

    const bad = await analyze(`  await tools.browser.resize({ width: 1, height: 2, label: ["a"] });`);
    expect(argumentTypeProblems(bad, registry)[0]?.found).toBe("array");
  });

  it("folds its findings into the graph the panel reads", async () => {
    const graph = await analyze(`  await tools.browser.resize({ width: "extra-wide", height: 720 });`);
    const before = graph.diagnostics.filter((d) => d.severity === "error").length;
    const decorated = withArgumentTypes(graph, registry);

    expect(before).toBe(0);
    expect(decorated.diagnostics.filter((d) => d.code === "argument-type-mismatch")).toHaveLength(1);
    // The original graph is left alone — the host decorates a copy.
    expect(graph.diagnostics.some((d) => d.code === "argument-type-mismatch")).toBe(false);
  });

  it("returns the graph unchanged when there is nothing to say", async () => {
    const graph = await analyze(`  await tools.browser.resize({ width: 1280, height: 720 });`);

    expect(withArgumentTypes(graph, registry)).toBe(graph);
  });
});
