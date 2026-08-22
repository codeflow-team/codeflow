/**
 * Turning a `ValidationResult` back into a prompt — the feedback half of the
 * loop in 10-ai-codegen.md §5.
 *
 * "Vòng retry dùng chính `Diagnostic[]` của analyzer làm feedback — không có hệ
 * thống lỗi riêng cho AI." So this is formatting only: no new taxonomy, no
 * rewritten messages. Each line carries the position (the model needs to find
 * the statement), the code (stable, so the same class of mistake reads the same
 * every round) and the message, which already ends in a concrete suggestion.
 */

import type { Diagnostic, ValidationResult } from "../model/index.js";

export interface RenderDiagnosticsFeedbackOptions {
  /** Include `info` diagnostics. Off by default — they are the graph's colour commentary. */
  includeInfo?: boolean;
  /** Conformance level the retry is aiming at. Defaults to `L1` (10 §8: MVP validates L0/L1). */
  target?: "L0" | "L1" | "L2";
}

function line(diagnostic: Diagnostic): string {
  const at =
    diagnostic.source === undefined
      ? ""
      : ` (line ${String(diagnostic.source.start.line)}, column ${String(diagnostic.source.start.column)})`;
  return `- [${diagnostic.severity}] ${diagnostic.code}${at}: ${diagnostic.message}`;
}

/**
 * A user-turn message asking the model to fix what validation found. Returns
 * `null` when there is nothing to say — the caller should stop retrying.
 */
export function renderDiagnosticsFeedback(
  result: ValidationResult,
  options: RenderDiagnosticsFeedbackOptions = {},
): string | null {
  const target = options.target ?? "L1";
  const relevant = result.diagnostics.filter((diagnostic) => {
    if (diagnostic.severity === "info") return options.includeInfo === true;
    if (diagnostic.severity === "warning" && target !== "L2") {
      // Below L2, warnings describe degradation the flow survives; asking the
      // model to chase them costs a round-trip and often rewrites working code.
      return diagnostic.code === "foreign-value-import";
    }
    return true;
  });

  if (relevant.length === 0) return null;

  const reached = result.level === "invalid" ? "did not reach L0" : `reached ${result.level}`;
  return [
    `The flow you wrote ${reached} (target: ${target}). CodeFlow reported:`,
    "",
    ...relevant.map(line),
    "",
    "Fix every point above and answer with the complete corrected flow file — the whole",
    "file, no fences, no commentary. Do not change anything the diagnostics did not ask",
    "you to change.",
  ].join("\n");
}
