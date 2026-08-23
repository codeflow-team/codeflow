/**
 * The one generation pipeline — 10 §5.
 *
 * Both places that ask a model for a flow file go through this function: the
 * chat panel (`ChatPanel.tsx`) and the create dialog (`NewFlowDialog.tsx`). It
 * was lifted out of the panel the moment there were two callers, because two
 * copies of a retry loop is exactly the "two sources of truth" this project
 * exists to argue against — the second copy would drift, and the thing that
 * would drift first is the part that makes the demo worth watching.
 *
 * What it does, in order, once per round:
 *
 *  1. `session.buildGenerationContext()` → `renderSystemPrompt()` — the flow
 *     contract, the style guide and the generated `tools.d.ts` / `lib.d.ts` of
 *     *this* registry (10 §1, §3). The model can only call tools that exist.
 *  2. one streamed completion (`ai.ts`), reported through `onDelta` /
 *     `onThinking` so a four-minute wait looks like progress and not a hang.
 *  3. `validateFlowSource` scores the answer on the conformance ladder, and
 *     `argument-types.ts` adds the one type check a browser can honestly make.
 *  4. below the target level, `renderDiagnosticsFeedback` goes back to the model
 *     as the next user turn — at most `MAX_ROUNDS` attempts in total.
 *
 * Every round is handed to `onRound` rather than swallowed: the caller shows the
 * level, the diagnostics and the time, because that visible loop *is* the
 * demonstration.
 */

import {
  renderDiagnosticsFeedback,
  renderSystemPrompt,
  validateFlowSource,
  type CodeFlowSession,
  type ConformanceLevel,
  type Diagnostic,
  type RegistryLookup,
  type WorkflowGraph,
} from "@codeflow/core";
import { callModel, splitAnswer, type AiMode, type ChatMessage } from "./ai.js";
import { argumentTypeProblems } from "./argument-types.js";

/** The level the retry loop is trying to reach. L2 is measured, not demanded. */
export const TARGET: "L1" = "L1";

/** Attempts in total, not retries after the first — 10 §5 defaults to 1 + 2. */
export const MAX_ROUNDS = 3;

/**
 * Asked for in front of the file, and shown above the diff.
 *
 * 10 §4's own output rule is "no explanation before or after" — right for an
 * eval harness reading the answer with a script, wrong for a person who is being
 * asked to accept a three-hundred-line rewrite. `splitAnswer` handles both
 * shapes, so relaxing it here costs nothing if the model ignores it.
 */
export const SAY_WHAT_YOU_DID =
  'First write ONE short sentence in plain English: what this flow does, and anything you could not do — a step with no matching tool, an assumption you had to make. Then the complete file inside one ```ts fence.';

export interface GenerationRound {
  round: number;
  level: ConformanceLevel;
  diagnostics: Diagnostic[];
  /** Milliseconds the completion took. */
  ms: number;
}

export interface GenerationResult {
  source: string;
  level: ConformanceLevel;
  /** How many attempts it took — 1 when the first answer was good enough. */
  rounds: number;
  /** The model's own sentence about what it built, when it wrote one. */
  prose: string | null;
  graph: WorkflowGraph | null;
  diagnostics: Diagnostic[];
  /** True when the loop ran out of rounds while still below `TARGET`. */
  gaveUp: boolean;
}

export interface GenerateFlowOptions {
  session: CodeFlowSession;
  /** The registry the answer is validated against — the live one, not a copy. */
  registryLookup: RegistryLookup;
  /** What the user asked for, in their own words. */
  intent: string;
  /** The file being changed, or `null` for a flow that does not exist yet. */
  existing: string | null;
  signal: AbortSignal;
  aiMode: AiMode;
  model: string;
  /** What the panel is doing right now, in one short sentence. */
  onStage: (label: string) => void;
  /** One completed validation round — level, diagnostics, time. */
  onRound: (round: GenerationRound) => void;
  onDelta?: (delta: string, whole: string) => void;
  onThinking?: (characters: number) => void;
}

/**
 * Ask, check, feed back, ask again — and hand over the best answer.
 *
 * Returns `null` only when the loop produced nothing at all, which in practice
 * means the request was aborted before the first answer landed. Everything else
 * — including an answer that never reached the target — comes back with its
 * level and its diagnostics attached, because a flow that is not finished still
 * has to be *shown*, honestly, rather than thrown away (07 §5).
 */
export async function generateFlowSource(
  options: GenerateFlowOptions,
): Promise<GenerationResult | null> {
  const { session, registryLookup, intent, existing, signal } = options;

  const context = await session.buildGenerationContext({
    includeExamples: true,
    ...(existing === null ? {} : { existingSource: existing }),
  });
  const system = renderSystemPrompt(context);

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        existing === null
          ? `${intent}\n\n${SAY_WHAT_YOU_DID}`
          : `Here is the flow file as it stands:\n\n\`\`\`ts\n${existing}\`\`\`\n\nChange it so that: ${intent}\n\n${SAY_WHAT_YOU_DID} It must be the complete updated file, not a fragment.`,
    },
  ];

  let accepted: GenerationResult | null = null;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    options.onStage(
      round === 1
        ? existing === null
          ? "Writing the flow…"
          : "Rewriting the file…"
        : `Fixing what validation found (round ${String(round)})…`,
    );
    const answer = await callModel(messages, {
      signal,
      ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
      ...(options.onThinking === undefined ? {} : { onThinking: options.onThinking }),
      mode: options.aiMode,
      model: options.model,
    });
    options.onStage("Checking it against the flow contract…");
    const { source: candidate, prose } = splitAnswer(answer.content);
    const result = validateFlowSource(candidate, registryLookup);

    const typed = result.graph === null ? [] : argumentTypeProblems(result.graph, registryLookup);
    const diagnostics: Diagnostic[] = [
      ...result.diagnostics,
      ...typed.map((problem) => ({
        severity: "error" as const,
        code: "argument-type-mismatch",
        message: problem.message,
      })),
    ];

    options.onRound({ round, level: result.level, diagnostics, ms: answer.ms });

    accepted = {
      source: candidate,
      level: result.level,
      rounds: round,
      prose,
      graph: result.graph,
      diagnostics,
      gaveUp: false,
    };
    if (result.level === "L1" || result.level === "L2") break;

    const feedback = renderDiagnosticsFeedback(result, { target: TARGET });
    if (feedback === null) break;
    if (round === MAX_ROUNDS) {
      accepted.gaveUp = true;
      break;
    }
    messages.push({ role: "assistant", content: answer.content }, { role: "user", content: feedback });
  }

  return accepted;
}

/**
 * What is still unresolved in a generated flow, in words a newcomer can act on.
 *
 * A flow that only reached L0 or L1 still opens — refusing to show it would hide
 * the most instructive thing this demo does — but the panel that opens it has to
 * say what is not finished and why (07 §5). This is that sentence, built from
 * the diagnostics the loop already collected, never from a guess.
 */
export function unresolvedSummary(result: {
  level: ConformanceLevel;
  diagnostics: readonly Diagnostic[];
  gaveUp: boolean;
}): string | null {
  if (result.level === "L2") return null;
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = result.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  if (result.level === "L1" && errors.length === 0 && warnings.length === 0) return null;

  const codes = [...new Set([...errors, ...warnings].map((diagnostic) => diagnostic.code))].slice(0, 4);
  const counted: string[] = [];
  if (errors.length > 0) counted.push(`${String(errors.length)} error${errors.length === 1 ? "" : "s"}`);
  if (warnings.length > 0) counted.push(`${String(warnings.length)} warning${warnings.length === 1 ? "" : "s"}`);

  const head =
    result.level === "L0"
      ? "Reached L0: it parses and follows the flow contract, but something in it does not resolve"
      : result.level === "invalid"
        ? "Did not reach L0: this does not parse, or does not follow the flow contract"
        : "Reached L1: every call resolves, but the mapping is not clean";
  const tail = result.gaveUp
    ? ` The loop used all ${String(MAX_ROUNDS)} rounds and stopped there.`
    : "";
  return `${head}${counted.length === 0 ? "" : ` — ${counted.join(" and ")} (${codes.join(", ")})`}.${tail}`;
}
