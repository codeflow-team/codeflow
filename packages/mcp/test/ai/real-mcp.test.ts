/**
 * One live intent against a registry of real MCP tools (10 §5, 11 §3.6).
 *
 * Layer 6 of the pyramid is not a CI gate: the live block skips unless
 * `OPENROUTER_API_KEY` is set, so a normal `vitest run` needs no network and no
 * key. The offline block above it always runs — it is what keeps the real-MCP
 * eval *harness* honest (the registry builds, the context is the right size, the
 * intents are well-formed) without spending a token.
 *
 * The conformance *rate* over all four intents is measured by
 * `scripts/real-mcp-eval.mjs`, whose output is committed under
 * `packages/core/test/ai/results/`.
 */

import { describe, expect, it } from "vitest";
import * as cf from "@codeflow/core";
import * as adapter from "../../src/adapter.js";

import {
  EVAL_SERVERS,
  REAL_MCP_INTENTS,
  conformanceRates,
  createRealMcpRegistry,
  extractFlowSource,
  runIntent,
} from "./real-mcp-suite.js";

declare const process: { env: Record<string, string | undefined> };

const apiKey = process.env["OPENROUTER_API_KEY"];
const model = process.env["OPENROUTER_MODEL"] ?? "stealth/ox-alpha";

describe("real-MCP eval harness (offline)", () => {
  it("builds a registry of real MCP tools from the committed captures", () => {
    const registry = createRealMcpRegistry(cf, adapter);
    const names = registry.listTools().map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(20);
    expect(names).toContain("filesystem.readTextFile");
    expect(names).toContain("memory.createEntities");
    expect(names).toContain("sequentialThinking.sequentialthinking");
    // Near-synonyms are all present — the choice is the point.
    expect(names).toContain("filesystem.readFile");
    expect(names).toContain("filesystem.readMultipleFiles");
  });

  it("produces a system prompt that fits the model's context", () => {
    const registry = createRealMcpRegistry(cf, adapter);
    const session = cf.createCodeFlow({ registry });
    return session.buildGenerationContext({ includeExamples: true }).then((context) => {
      const prompt = cf.renderSystemPrompt(context);
      const tokens = Math.ceil(prompt.length / 4);
      // Real descriptions are long; the whole thing must still be far under the
      // 131k window, or scoping (10 §4) would be mandatory rather than optional.
      expect(tokens).toBeGreaterThan(1_000);
      expect(tokens).toBeLessThan(30_000);
      // The tools the intents need are actually described in it.
      expect(prompt).toContain("readTextFile(input:");
      expect(prompt).toContain("createEntities(input:");
    });
  });

  it("declares four intents, each covering something distinct", () => {
    expect(REAL_MCP_INTENTS).toHaveLength(4);
    expect(new Set(REAL_MCP_INTENTS.map((i) => i.id)).size).toBe(4);
    for (const intent of REAL_MCP_INTENTS) {
      expect(intent.prompt.length).toBeGreaterThan(80);
      expect(intent.covers.length).toBeGreaterThan(0);
    }
    expect(EVAL_SERVERS.length).toBeGreaterThanOrEqual(3);
  });

  it("strips the markdown fences a model wraps its answer in", () => {
    expect(extractFlowSource("```ts\nconst a = 1;\n```")).toBe("const a = 1;\n");
    expect(extractFlowSource("const a = 1;")).toBe("const a = 1;\n");
  });

  it("counts a level as reaching every level below it", () => {
    expect(
      conformanceRates([
        { intent: "a", covers: [], firstLevel: "L0", finalLevel: "L2", retries: 0, rounds: [], toolsUsed: [] },
        { intent: "b", covers: [], firstLevel: "L0", finalLevel: "L1", retries: 1, rounds: [], toolsUsed: [] },
        { intent: "c", covers: [], firstLevel: "invalid", finalLevel: "invalid", retries: 2, rounds: [], toolsUsed: [] },
      ]),
    ).toEqual({ total: 3, l0: 2, l1: 2, l2: 1 });
  });
});

/**
 * Layer 6 is never a CI gate (11 §4), so this asserts the **harness**, not the
 * model's luck: that the 10 §5 loop runs end to end against a real-MCP registry
 * and that whatever comes back is scored on the ladder. Asserting a level here
 * would make the suite flake on model non-determinism — observed directly: the
 * same intent scored L2, L1 and `invalid` on consecutive runs, the `invalid`
 * ones because the model emitted a raw newline inside `"\n"`. That is a model
 * artefact; CodeFlow caught it correctly as a parse error, which is the
 * behaviour under test.
 *
 * The conformance *rate* is what `scripts/real-mcp-eval.mjs` measures, and its
 * output is committed under `packages/core/test/ai/results/`.
 */
describe.skipIf(apiKey === undefined || apiKey.length === 0)("live model on real MCP tools", () => {
  it(
    "runs the generate → validate → retry loop against real MCP schemas",
    async () => {
      const intent = REAL_MCP_INTENTS[2]!; // resilient-edit — nested array-of-object argument
      const result = await runIntent({
        cf,
        adapter,
        intent,
        // 32000, not 8000: this is a reasoning model with a 131k window, and a
        // low cap returns an empty answer with finish_reason "length".
        config: { apiKey: apiKey!, model, maxTokens: 32000 },
        maxRetries: 1,
      });

      expect(result.rounds.length).toBeGreaterThan(0);
      expect(result.rounds[0]!.source).toContain("export default async function flow");
      // Every round is scored, and every score is on the ladder.
      for (const round of result.rounds) {
        expect(["invalid", "L0", "L1", "L2"]).toContain(round.level);
        // Below the target the loop must have something to say; at or above it,
        // nothing. That coupling is the loop's contract (10 §5).
        if (round.level === "invalid" || round.level === "L0") {
          expect(round.feedback, "a failing round must produce feedback").toBeTruthy();
        }
      }
      // The invariant that actually depends on this package: when the flow does
      // analyze, the calls it made resolve to real MCP tools rather than to
      // names the model invented.
      if (result.finalLevel === "L1" || result.finalLevel === "L2") {
        expect(result.toolsUsed.length).toBeGreaterThan(0);
        for (const name of result.toolsUsed) {
          expect(name).toMatch(/^(filesystem|memory|sequentialThinking)\./);
        }
      }
    },
    { timeout: 600_000 },
  );
});
