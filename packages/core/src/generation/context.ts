/**
 * `buildGenerationContext` — 10-ai-codegen.md §1, §3, §4.
 *
 * CodeFlow prepares the context; the host owns the LLM call (model independence,
 * 10 preamble). What is prepared here is exactly the bundle of §1: the generated
 * `.d.ts` artifacts (never a hand-written copy — a second description of the API
 * would drift from the one the analyzer resolves against, 10 §1), plus the
 * static prompt sections.
 *
 * `renderSystemPrompt` implements delivery mode 1 (direct prompt assembly,
 * 10 §3): sections joined, files attached as fenced code blocks. Mode 2
 * (workspace files) is the CLI's job, mode 3 (MCP) is post-MVP (10 §8).
 */

import { generateLibDts } from "../codegen/lib-dts.js";
import { generateToolsDts } from "../codegen/tools-dts.js";
import type {
  BuildGenerationContextOptions,
  GeneratedFile,
  GenerationContext,
  PromptSection,
} from "../model/generation.js";
import type { RegistryLookup } from "../registry/lookup.js";
import {
  CANONICAL_EXAMPLE,
  FLOW_CONTRACT_PROMPT,
  FLOW_STYLE_PROMPT,
  OUTPUT_FORMAT_PROMPT,
  RESILIENCE_EXAMPLE,
} from "./prompts.js";

/** Workspace paths of the generated artifacts — the layout of 10 §2. */
export const TOOLS_DTS_PATH = "generated/tools.d.ts";
export const LIB_DTS_PATH = "generated/lib.d.ts";

/**
 * Rough token estimate — ~4 characters per token. Deliberately crude: it exists
 * so a host can tell "fits comfortably" from "needs scoping" (10 §4), not to
 * bill anyone. Tokenizers are model-specific and core stays model-independent.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function buildGenerationContext(
  registry: RegistryLookup,
  options: BuildGenerationContextOptions = {},
): GenerationContext {
  const files: GeneratedFile[] = [
    {
      path: TOOLS_DTS_PATH,
      content: generateToolsDts(registry, {
        ...(options.namespaces === undefined ? {} : { namespaces: options.namespaces }),
        ...(options.parameterDocs === undefined ? {} : { parameterDocs: options.parameterDocs }),
      }),
    },
  ];

  // `lib.d.ts` only exists when the library does. An empty module declaration
  // would spend tokens telling the AI about nothing (10 §1).
  if (registry.listFunctions().length > 0) {
    files.push({ path: LIB_DTS_PATH, content: generateLibDts(registry) });
  }

  const promptSections: PromptSection[] = [
    { id: "flow-contract", title: "Flow contract", content: FLOW_CONTRACT_PROMPT },
    { id: "style-guide", title: "Style guide", content: FLOW_STYLE_PROMPT },
  ];

  if (options.includeExamples === true) {
    promptSections.push({
      id: "examples",
      title: "Examples",
      content: [
        "A flow that reads well as a graph:",
        "",
        CANONICAL_EXAMPLE,
        "",
        "A flow using retry, error handling, parallel calls and an early `continue`:",
        "",
        RESILIENCE_EXAMPLE,
      ].join("\n"),
    });
  }

  if (options.existingSource !== undefined) {
    promptSections.push({
      id: "existing-source",
      title: "Existing flow",
      content: [
        "You are editing an existing flow. Keep everything the user did not ask you to",
        "change exactly as it is, including formatting and comments, and answer with the",
        "complete file.",
        "",
        "```ts",
        options.existingSource.replace(/\n$/, ""),
        "```",
      ].join("\n"),
    });
  }

  promptSections.push({
    id: "output-format",
    title: "Output format",
    content: OUTPUT_FORMAT_PROMPT,
  });

  const estimatedTokens =
    files.reduce((total, file) => total + estimateTokens(file.path) + estimateTokens(file.content), 0) +
    promptSections.reduce(
      (total, section) => total + estimateTokens(section.title) + estimateTokens(section.content),
      0,
    );

  return { files, promptSections, estimatedTokens };
}

export interface RenderSystemPromptOptions {
  /** Heading of the assembled prompt. */
  title?: string;
}

/**
 * Assemble one system prompt out of a context — delivery mode 1 of 10 §3.
 *
 * Files come after the prose: the contract and the style guide explain how to
 * read them, and a model that truncates its attention should keep the API
 * surface closest to the answer it is about to write.
 */
export function renderSystemPrompt(
  context: GenerationContext,
  options: RenderSystemPromptOptions = {},
): string {
  const title = options.title ?? "CodeFlow — flow generation";
  const blocks: string[] = [
    `# ${title}`,
    "",
    "You write **flow files** for CodeFlow: TypeScript that is also read as a workflow",
    "graph by people who do not read code. Follow the contract exactly and the style",
    "guide as closely as the task allows.",
  ];

  for (const section of context.promptSections) {
    blocks.push("", `## ${section.title}`, "", section.content);
  }

  if (context.files.length > 0) {
    blocks.push("", "## Available API", "");
    blocks.push(
      "These files are generated from the registry. They are the only source of truth for",
      "what you may call — nothing outside them exists.",
    );
    for (const file of context.files) {
      blocks.push("", `### ${file.path}`, "", "```ts", file.content.replace(/\n$/, ""), "```");
    }
  }

  return `${blocks.join("\n")}\n`;
}
