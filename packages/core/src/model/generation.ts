/** AI generation context — 10-ai-codegen.md §1, §5, §7. */

import type { Diagnostic } from "./diagnostic.js";

export interface GeneratedFile {
  /** Workspace-relative path, e.g. "generated/tools.d.ts". */
  path: string;
  content: string;
}

export interface PromptSection {
  /** e.g. "flow-contract", "style-guide", "examples". */
  id: string;
  title: string;
  content: string;
}

export interface GenerationContext {
  files: GeneratedFile[];
  promptSections: PromptSection[];
  estimatedTokens: number;
}

export interface BuildGenerationContextOptions {
  /** Scope the tools put in context — 10 §4. */
  namespaces?: string[];
  includeExamples?: boolean;
  /** Set when the AI is editing an existing flow rather than creating one. */
  existingSource?: string;
}

/** Conformance level of AI output — 10 §5. */
export type ConformanceLevel = "invalid" | "L0" | "L1" | "L2";

export interface ValidationResult {
  level: ConformanceLevel;
  diagnostics: Diagnostic[];
}
