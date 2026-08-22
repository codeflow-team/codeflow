/** buildGenerationContext / renderSystemPrompt — 10-ai-codegen.md §1, §3, §4. */

import { describe, expect, it } from "vitest";

import {
  buildGenerationContext,
  estimateTokens,
  renderSystemPrompt,
} from "../src/generation/context.js";
import { generateToolsDts } from "../src/codegen/tools-dts.js";
import { createRegistry } from "../src/registry/index.js";
import { createSampleRegistry } from "./fixtures.js";

const registry = createSampleRegistry();

describe("files — the AI sees the generated artifacts, never a hand-written copy", () => {
  it("ships tools.d.ts and lib.d.ts at their workspace paths (10 §2)", () => {
    const context = buildGenerationContext(registry);
    expect(context.files.map((file) => file.path)).toEqual([
      "generated/tools.d.ts",
      "generated/lib.d.ts",
    ]);
  });

  it("uses the same codegen the analyzer resolves against — byte for byte (10 §1)", () => {
    const context = buildGenerationContext(registry);
    expect(context.files[0]?.content).toBe(generateToolsDts(registry));
    expect(context.files[0]?.content).toContain("registryHash:");
  });

  it("omits lib.d.ts when the library is empty rather than spending tokens on nothing", () => {
    const empty = createRegistry();
    empty.registerTool({ name: "slack.send", label: "Send", inputSchema: { channel: "string" } });
    const context = buildGenerationContext(empty);
    expect(context.files.map((file) => file.path)).toEqual(["generated/tools.d.ts"]);
  });
});

describe("scoping — keep the context small so the AI stays accurate (10 §4)", () => {
  it("emits only the requested namespaces", () => {
    const context = buildGenerationContext(registry, { namespaces: ["slack"] });
    const tools = context.files[0]!.content;
    expect(tools).toContain("slack: {");
    expect(tools).not.toContain("github: {");
    expect(tools).toContain("send(input:");
  });

  it("scoping shrinks the estimate", () => {
    const all = buildGenerationContext(registry);
    const scoped = buildGenerationContext(registry, { namespaces: ["slack"] });
    expect(scoped.estimatedTokens).toBeLessThan(all.estimatedTokens);
  });

  it("keeps a small registry's bundle well under the ~2k token target", () => {
    expect(buildGenerationContext(registry, { includeExamples: true }).estimatedTokens).toBeLessThan(
      2000,
    );
  });

  it("estimates ~4 characters per token", () => {
    expect(estimateTokens("12345678")).toBe(2);
    expect(estimateTokens("")).toBe(0);
  });
});

describe("prompt sections", () => {
  it("always carries the contract, the style guide and the output format", () => {
    const context = buildGenerationContext(registry);
    expect(context.promptSections.map((section) => section.id)).toEqual([
      "flow-contract",
      "style-guide",
      "output-format",
    ]);
  });

  it("states the style rules the analyzer actually enforces (01 §3)", () => {
    const style = buildGenerationContext(registry).promptSections.find(
      (section) => section.id === "style-guide",
    )!.content;
    expect(style).toContain("hoist");
    expect(style).toContain("Promise.all(prs.map(...))");
    expect(style).toContain("array literal");
    expect(style).toContain("never the whole flow body");
    expect(style).toContain("stopping condition visible in the code");
  });

  it("adds few-shot examples only when asked", () => {
    expect(
      buildGenerationContext(registry).promptSections.some((section) => section.id === "examples"),
    ).toBe(false);
    const withExamples = buildGenerationContext(registry, { includeExamples: true });
    const examples = withExamples.promptSections.find((section) => section.id === "examples")!;
    expect(examples.content).toContain("export default async function flow");
    expect(examples.content).toContain("isAuthChange");
    expect(withExamples.estimatedTokens).toBeGreaterThan(
      buildGenerationContext(registry).estimatedTokens,
    );
  });

  it("embeds the existing source when the AI is editing rather than creating", () => {
    const existingSource = "export default async function flow(input, tools) {}\n";
    const context = buildGenerationContext(registry, { existingSource });
    const section = context.promptSections.find((s) => s.id === "existing-source")!;
    expect(section.content).toContain(existingSource.trim());
    expect(section.content).toContain("complete file");
    // Order matters: the existing flow comes after the rules it must respect.
    expect(context.promptSections.map((s) => s.id)).toEqual([
      "flow-contract",
      "style-guide",
      "existing-source",
      "output-format",
    ]);
  });
});

describe("renderSystemPrompt — delivery mode 1 (10 §3)", () => {
  const prompt = renderSystemPrompt(buildGenerationContext(registry, { includeExamples: true }));

  it("joins every section under its title", () => {
    expect(prompt).toContain("## Flow contract");
    expect(prompt).toContain("## Style guide");
    expect(prompt).toContain("## Examples");
    expect(prompt).toContain("## Output format");
  });

  it("attaches each file as a fenced block under its path", () => {
    expect(prompt).toContain("### generated/tools.d.ts");
    expect(prompt).toContain("### generated/lib.d.ts");
    expect(prompt).toContain("export interface Tools {");
    expect(prompt).toContain('declare module "@flows/lib" {');
    // Fences must balance, or the model reads the prompt as one code block.
    expect((prompt.match(/```/g) ?? []).length % 2).toBe(0);
  });

  it("takes a custom title", () => {
    expect(renderSystemPrompt(buildGenerationContext(registry), { title: "Acme flows" })).toContain(
      "# Acme flows",
    );
  });
});
