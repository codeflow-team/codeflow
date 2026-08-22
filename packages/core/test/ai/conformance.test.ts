/**
 * One live intent through the generate → validate → retry loop (10 §5).
 *
 * Layer 6 of 11 §3 is not a CI gate: this whole file skips unless
 * `OPENROUTER_API_KEY` is set, so a normal `vitest run` needs no network. It is
 * a smoke test of the *harness* — that context, prompt, model call, validation
 * and feedback still fit together — while the conformance *rate* is measured by
 * `scripts/ai-eval.mjs` over all six intents.
 */

import { describe, expect, it } from "vitest";

import * as cf from "../../src/index.js";
import { EVAL_INTENTS, conformanceRates, extractFlowSource, runIntent } from "./suite.js";

declare const process: { env: Record<string, string | undefined> };

const apiKey = process.env["OPENROUTER_API_KEY"];
const model = process.env["OPENROUTER_MODEL"] ?? "stealth/ox-alpha";

describe("eval harness (offline parts)", () => {
  it("strips the markdown fences a model wraps its answer in", () => {
    expect(extractFlowSource("```ts\nconst a = 1;\n```")).toBe("const a = 1;\n");
    expect(extractFlowSource("here you go:\n```typescript\nconst a = 1;\n```\n")).toBe(
      "const a = 1;\n",
    );
    expect(extractFlowSource("const a = 1;")).toBe("const a = 1;\n");
  });

  it("counts a level as reaching every level below it", () => {
    const rates = conformanceRates([
      { intent: "a", covers: [], firstLevel: "L0", finalLevel: "L2", retries: 0, rounds: [] },
      { intent: "b", covers: [], firstLevel: "L0", finalLevel: "L1", retries: 1, rounds: [] },
      { intent: "c", covers: [], firstLevel: "invalid", finalLevel: "invalid", retries: 2, rounds: [] },
    ]);
    expect(rates).toEqual({ total: 3, l0: 2, l1: 2, l2: 1 });
  });
});

describe.skipIf(apiKey === undefined || apiKey.length === 0)("live model conformance", () => {
  it(
    "generates the canonical-shaped intent and reaches at least L1",
    async () => {
      const intent = EVAL_INTENTS[0]!;
      const result = await runIntent({
        cf,
        intent,
        config: { apiKey: apiKey!, model, maxTokens: 8000 },
        maxRetries: 1,
      });
      expect(result.rounds.length).toBeGreaterThan(0);
      expect(result.rounds[0]!.source).toContain("export default async function flow");
      expect(["L1", "L2"]).toContain(result.finalLevel);
    },
    { timeout: 300_000 },
  );
});
