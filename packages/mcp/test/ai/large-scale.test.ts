/**
 * The large-scale eval harness — 10-ai-codegen.md §5, 11-testing.md §3.6.
 *
 * Layer 6 is never a CI gate, so this file is split the same way
 * `real-mcp.test.ts` is: everything that can be asserted without a token is
 * asserted always, and one live generation runs only when a key is present.
 *
 * The offline half is worth more here than it was for the small eval, because
 * this suite reports *numbers* — lines, nodes, code-node ratio, which constructs
 * reached the graph. Those measurements are code, and code that measures a model
 * can be wrong in a way that quietly flatters or maligns it. So they are tested
 * against a hand-written flow whose shape is known.
 */

import { describe, expect, it } from "vitest";
import * as cf from "@codeflow/core";
import * as adapter from "../../src/adapter.js";

import {
  ALL_SERVERS,
  LARGE_INTENTS,
  conformanceRates,
  constructCoverage,
  coveredConstructs,
  createScopedRegistry,
  diagnosticHistogram,
  extractFlowSource,
  firstRoundRates,
  graphShape,
  runLargeIntent,
} from "./large-scale-suite.js";

declare const process: { env: Record<string, string | undefined> };

const apiKey = process.env["OPENROUTER_API_KEY"];
const model = process.env["OPENROUTER_MODEL"] ?? "stealth/ox-alpha";

/**
 * Every construct 01 §2 supports that a brief in this suite asks for, in one
 * file: nested `for...of`, a bounded `while`, a narrow `try`/`catch`, a
 * `Promise.all` over an array literal, a `continue`, and an early `return`.
 */
const SHAPED_FLOW = `import type { Tools } from "../generated/tools";

export default async function flow(
  input: { root: string; patterns: string[] },
  tools: Tools
) {
  const allowed = await tools.filesystem.listAllowedDirectories({});

  if (allowed === undefined) {
    return { refused: true };
  }

  let attempt = 0;

  while (attempt < 3) {
    attempt += 1;
    try {
      const listing = await tools.filesystem.listDirectory({ path: input.root });
      await tools.memory.createEntities({
        entities: [{ name: input.root, entityType: "dir", observations: [String(listing)] }]
      });
    } catch (error) {
      await tools.filesystem.writeFile({ path: "errors.log", content: String(error) });
    }
  }

  for (const pattern of input.patterns) {
    const matches = await tools.filesystem.searchFiles({ path: input.root, pattern });

    for (const match of matches) {
      if (match === "") {
        continue;
      }

      const [text, info] = await Promise.all([
        tools.filesystem.readTextFile({ path: match }),
        tools.filesystem.getFileInfo({ path: match })
      ]);

      await tools.memory.addObservations({
        observations: [{ entityName: match, contents: [String(text), String(info)] }]
      });
    }
  }

  return { refused: false };
}
`;

describe("large-scale eval harness (offline)", () => {
  it("scopes each intent's registry to the servers its brief names", () => {
    for (const intent of LARGE_INTENTS) {
      const registry = createScopedRegistry(cf, adapter, intent.servers);
      const namespaces = new Set(registry.listTools().map((tool) => tool.name.split(".")[0]));
      // Scoping is what keeps L1 honest: a tool from a server the brief never
      // mounted must fail to resolve rather than pass by accident (10 §4).
      expect(namespaces.size).toBe(intent.servers.length);
      expect(registry.listTools().length).toBeGreaterThanOrEqual(18);
      expect(registry.listTools().length).toBeLessThanOrEqual(40);
    }
  });

  it("keeps every intent's context inside the model's window", async () => {
    for (const intent of LARGE_INTENTS) {
      const registry = createScopedRegistry(cf, adapter, intent.servers);
      const session = cf.createCodeFlow({ registry });
      const context = await session.buildGenerationContext({ includeExamples: true });
      const tokens = Math.ceil(cf.renderSystemPrompt(context).length / 4);
      expect(tokens).toBeGreaterThan(2_000);
      expect(tokens).toBeLessThan(20_000);
    }
  });

  it("declares briefs that are actually large, and all distinct", () => {
    expect(LARGE_INTENTS.length).toBeGreaterThanOrEqual(6);
    expect(new Set(LARGE_INTENTS.map((intent) => intent.id)).size).toBe(LARGE_INTENTS.length);
    for (const intent of LARGE_INTENTS) {
      // A brief, not a sentence — this is the whole difference from `real-mcp-suite`.
      expect(intent.prompt.length).toBeGreaterThan(900);
      expect(intent.targetLines).toBeGreaterThanOrEqual(150);
      expect(intent.covers.length).toBeGreaterThanOrEqual(5);
      for (const server of intent.servers) {
        expect(ALL_SERVERS).toContain(server);
      }
    }
  });

  it("reads size, nesting and code-node ratio off a graph", async () => {
    const registry = createScopedRegistry(cf, adapter, ["filesystem", "memory"]);
    const session = cf.createCodeFlow({ registry });
    const graph = await session.analyze(SHAPED_FLOW);
    const shape = graphShape(graph);

    expect(shape.nodes).toBeGreaterThan(10);
    expect(shape.edges).toBeGreaterThan(10);
    // Eight `tools.*` calls, including the two inside the `Promise.all` array
    // literal — the parallel branch is two tool nodes, not one opaque step.
    expect(shape.toolCalls).toBe(8);
    expect(shape.unknownNodes).toBe(0);
    // `let attempt = 0` and `attempt += 1` are the plumbing 10 §5 tolerates; the
    // ratio must still be dominated by nodes a non-developer can read.
    expect(shape.meaningfulRatio).toBeGreaterThan(0.7);
    // for → for → if is three containers deep.
    expect(shape.maxNesting).toBeGreaterThanOrEqual(3);
  });

  it("detects the constructs a graph really contains, not the words in the source", async () => {
    const registry = createScopedRegistry(cf, adapter, ["filesystem", "memory"]);
    const session = cf.createCodeFlow({ registry });
    const graph = await session.analyze(SHAPED_FLOW);
    const covered = coveredConstructs(graph);

    for (const construct of [
      "loop",
      "nested-loop",
      "while-loop",
      "condition",
      "try",
      "parallel",
      "jump",
      "early-return",
    ] as const) {
      expect([...covered], `expected ${construct}`).toContain(construct);
    }
    // Nothing in the fixture calls a named function, so the detector must not
    // claim one — a coverage number that only ever goes up measures nothing.
    expect([...covered]).not.toContain("function");
  });

  it("aggregates rates, diagnostics and coverage across results", () => {
    const results = [
      {
        intent: "a",
        servers: ["memory"] as const,
        toolCount: 9,
        systemPromptTokens: 3000,
        covers: ["loop", "try"] as const,
        targetLines: 150,
        includeExamples: true,
        firstLevel: "L1" as const,
        finalLevel: "L2" as const,
        retries: 1,
        rounds: [
          {
            round: 0,
            source: "",
            lines: 10,
            level: "L1" as const,
            diagnostics: [],
            diagnosticCodes: { "warning/inline-logic-in-code-node": 2 },
            shape: null,
            covered: ["loop"] as const,
            missing: ["try"] as const,
            feedback: null,
            finishReason: "stop",
            usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
            ms: 1,
          },
          {
            round: 1,
            source: "",
            lines: 20,
            level: "L2" as const,
            diagnostics: [],
            diagnosticCodes: { "warning/inline-logic-in-code-node": 1 },
            shape: null,
            covered: ["loop", "try"] as const,
            missing: [] as const,
            feedback: null,
            finishReason: "stop",
            usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
            ms: 1,
          },
        ],
        toolsUsed: [],
        totalMs: 2,
      },
    ];
    // The cast keeps the fixture readable; the shapes above are the real ones.
    const typed = results as unknown as Parameters<typeof conformanceRates>[0];

    expect(conformanceRates(typed)).toEqual({ total: 1, l0: 1, l1: 1, l2: 1 });
    // The number that matters to a host generating once: this flow only reached
    // L2 because the retry loop ran, and the final rate hides that entirely.
    expect(firstRoundRates(typed)).toEqual({ total: 1, l0: 1, l1: 1, l2: 0 });
    expect(diagnosticHistogram(typed)).toEqual({ "warning/inline-logic-in-code-node": 3 });
    // Coverage is read off the *last* round — the flow the host would keep.
    expect(constructCoverage(typed)).toEqual({
      asked: 2,
      covered: 2,
      missingByConstruct: {},
    });
  });

  /**
   * The accumulator rule of 01 §3 (style rule 10), which the large-scale eval
   * added after measuring it: 34 of the 61 L2 blockers in the baseline run were
   * `xs.push(…)` in a code node. `recordFailure(…)` is the same step written so
   * the reader sees it — and the difference is worth a test, because the rule is
   * only worth telling a model if it actually moves the level.
   */
  it("scores an accumulator written as a named function above a bare push", async () => {
    const registry = createScopedRegistry(cf, adapter, ["filesystem"]);
    const session = cf.createCodeFlow({ registry });
    const flow = (record: string): string => `import type { Tools } from "../generated/tools";

function recordFailure(failures: string[], path: string, reason: string): void {
  failures.push(path + reason);
}

export default async function flow(input: { paths: string[] }, tools: Tools) {
  const failures: string[] = [];

  for (const path of input.paths) {
    try {
      await tools.filesystem.readTextFile({ path });
    } catch (error) {
      ${record}
    }
  }

  return { failures };
}
`;

    const bare = await session.validate(flow("failures.push(path + String(error));"));
    expect(bare.level).toBe("L1");
    expect(bare.diagnostics.map((d) => d.code)).toContain("inline-logic-in-code-node");

    const named = await session.validate(flow("recordFailure(failures, path, String(error));"));
    expect(named.level).toBe("L2");
    // And the step is now on the graph rather than hidden in a code node.
    const graph = await session.analyze(flow("recordFailure(failures, path, String(error));"));
    expect(graph.nodes.some((node) => node.type === "function")).toBe(true);
  });

  it("ships examples that would themselves pass the ladder they teach", async () => {
    // A few-shot example the model is told to imitate must score what it asks
    // for, or the context contradicts itself. The tools are illustrative, so the
    // registry here is built to match them.
    const registry = cf.createRegistry();
    for (const [name, fields] of [
      ["github.getNewPRs", ["repo"]],
      ["github.getFiles", ["pr"]],
      ["slack.send", ["channel", "message"]],
      ["jira.getIssue", ["key"]],
      ["jira.summarize", ["issue"]],
      ["jira.getComments", ["issue"]],
      ["email.send", ["to", "subject", "body"]],
    ] as const) {
      registry.registerTool({
        name,
        label: name,
        inputSchema: {
          type: "object",
          properties: Object.fromEntries(fields.map((field) => [field, { type: "string" }])),
        },
      });
    }
    registry.registerFunction({
      name: "isAuthChange",
      label: "Is auth change",
      modulePath: "@flows/lib",
      inputSchema: { type: "object", properties: { files: { type: "array" } } },
      outputSchema: { type: "boolean" },
      code: "export function isAuthChange(file: string) { return file.includes('auth'); }",
    });

    const session = cf.createCodeFlow({ registry });
    const unfence = (block: string): string =>
      block.replace(/^```ts\n/, "").replace(/```$/, "");

    for (const [name, block] of [
      ["canonical", cf.CANONICAL_EXAMPLE],
      ["resilience", cf.RESILIENCE_EXAMPLE],
    ] as const) {
      const result = await session.validate(unfence(block));
      expect(result.level, `${name} example`).toBe("L2");
    }
  });

  it("strips the markdown fences a model wraps its answer in", () => {
    expect(extractFlowSource("```ts\nconst a = 1;\n```")).toBe("const a = 1;\n");
    expect(extractFlowSource("const a = 1;")).toBe("const a = 1;\n");
  });
});

/**
 * One feature-sized generation end to end. Like the small eval's live block this
 * asserts the harness rather than the model's luck (11 §4) — but at this scale
 * one thing *is* assertable about the output: a brief with eight numbered
 * requirements cannot be satisfied by a toy flow, so a run that parses at all
 * must have produced something substantially bigger than the 20–40 line flows
 * `real-mcp-suite` asks for.
 */
describe.skipIf(apiKey === undefined || apiKey.length === 0)("live model on a feature-sized brief", () => {
  it(
    "generates, scores and measures a large flow",
    async () => {
      const intent = LARGE_INTENTS[0]!; // repo-triage-bot
      const result = await runLargeIntent({
        cf,
        adapter,
        intent,
        config: { apiKey: apiKey!, model, maxTokens: 48000 },
        maxRetries: 1,
      });

      expect(result.rounds.length).toBeGreaterThan(0);
      expect(result.rounds[0]!.source).toContain("export default async function flow");

      for (const round of result.rounds) {
        expect(["invalid", "L0", "L1", "L2"]).toContain(round.level);
        if (round.level === "invalid" || round.level === "L0") {
          expect(round.feedback, "a failing round must produce feedback").toBeTruthy();
        }
        if (round.level !== "invalid") {
          // Every scored round carries a measurable graph, or the numbers in the
          // report came from nowhere.
          expect(round.shape).not.toBeNull();
          expect(round.shape!.nodes).toBeGreaterThan(0);
        }
      }

      const last = result.rounds[result.rounds.length - 1]!;
      if (last.level !== "invalid") {
        expect(last.lines).toBeGreaterThan(60);
        expect(last.shape!.toolCalls).toBeGreaterThan(3);
      }
      if (result.finalLevel === "L1" || result.finalLevel === "L2") {
        expect(result.toolsUsed.length).toBeGreaterThan(0);
        for (const name of result.toolsUsed) {
          expect(name).toMatch(/^(filesystem|memory)\./);
        }
      }
    },
    { timeout: 900_000 },
  );
});
