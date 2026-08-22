/** Diagnostics — 03-data-model.md §7. Written to be readable *and fixable* by AI. */

import type { SourceMapping } from "./source.js";

export type DiagnosticSeverity = "info" | "warning" | "error";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  /** e.g. "unsupported-construct", "unresolved-tool", "stale-generated-artifacts" */
  code: string;
  message: string;
  source?: SourceMapping;
}
