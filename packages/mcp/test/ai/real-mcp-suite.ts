/**
 * AI conformance eval against a registry of **real** MCP tools — 11 §3.6, 10 §5.
 *
 * The eval in `@codeflow-team/core` uses a hand-authored github/slack/jira registry:
 * short names, TS type refs, one obvious tool per job. This one hands the model
 * `generated/tools.d.ts` built from the schemas that
 * `@modelcontextprotocol/server-filesystem`, `-memory` and
 * `-sequential-thinking` actually publish — nested object arrays, optional
 * fields with defaults, near-synonym tools (`read_file` vs `read_text_file` vs
 * `read_multiple_files`), and descriptions long enough to crowd the context.
 *
 * What it measures is the same conformance ladder (10 §5). What it adds is
 * whether the ladder still holds when the API the model reads was written by
 * someone else.
 *
 * The model call is kept here rather than imported from core's suite: crossing
 * package boundaries in test sources would put core's `test/` inside this
 * package's compilation, and the adapter's whole point is that it depends on
 * core one way only (02 §2).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ConformanceLevel,
  Diagnostic,
  Registry,
  createCodeFlow,
  createRegistry,
  renderDiagnosticsFeedback,
  renderSystemPrompt,
} from "@codeflow-team/core";

import type { mcpToolsToDefinitions } from "../../src/adapter.js";
import type { McpTool } from "../../src/types.js";

/**
 * The slice of the adapter the suite needs. Injected rather than imported, for
 * the same reason `CodeFlowModule` is: Vitest runs this against `src`, the
 * runner script against `dist`, and neither should have to know about the other.
 */
export interface McpAdapterModule {
  mcpToolsToDefinitions: typeof mcpToolsToDefinitions;
}

/** The slice of `@codeflow-team/core` the suite needs, from `src` or from `dist`. */
export interface CodeFlowModule {
  createRegistry: typeof createRegistry;
  createCodeFlow: typeof createCodeFlow;
  renderSystemPrompt: typeof renderSystemPrompt;
  renderDiagnosticsFeedback: typeof renderDiagnosticsFeedback;
}

// `types: []` in this package, so the two host APIs used here are declared
// locally rather than pulled in globally.
declare function fetch(url: string, init: RequestInit): Promise<FetchResponse>;
declare function setTimeout(handler: () => void, timeout: number): unknown;
interface RequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
}
interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "real-schemas");

/**
 * Bump when the captured servers or the intents below change — conformance
 * rates are only comparable within one version.
 */
export const REAL_MCP_EVAL_VERSION = 1;

/** The servers the eval mounts. Kept small so the context stays readable. */
export const EVAL_SERVERS = ["filesystem", "memory", "sequential-thinking"] as const;

export function createRealMcpRegistry(cf: CodeFlowModule, adapter: McpAdapterModule): Registry {
  const registry = cf.createRegistry();
  for (const server of EVAL_SERVERS) {
    const capture = JSON.parse(
      readFileSync(join(SCHEMA_DIR, `${server}.json`), "utf8"),
    ) as { tools: McpTool[] };
    for (const definition of adapter.mcpToolsToDefinitions(capture.tools, {
      namespace: server.replace(/-/g, "_"),
      server,
    })) {
      registry.registerTool(definition);
    }
  }
  return registry;
}

export interface EvalIntent {
  id: string;
  prompt: string;
  /** What this intent is meant to exercise. */
  covers: string[];
}

/**
 * Four intents that can only be satisfied with the real tools. Each one forces a
 * choice the hand-written registry never does — which `read_*` variant, how to
 * shape `entities[]`, what to do with a tool that returns nothing useful.
 */
export const REAL_MCP_INTENTS: EvalIntent[] = [
  {
    id: "index-directory-into-memory",
    covers: ["for...of", "tool call", "nested object argument", "two namespaces"],
    prompt:
      "List the files in the directory given in the input. For each file, read its text contents " +
      "and record it in the knowledge graph as an entity of type \"file\", using the file path as " +
      "the entity name and the contents as its single observation.",
  },
  {
    id: "search-and-report",
    covers: ["tool call", "if", "template literal", "early return"],
    prompt:
      "Search the directory in the input for files matching the pattern in the input. If nothing " +
      "matches, write a file called \"report.txt\" saying no matches were found and stop. Otherwise " +
      "write \"report.txt\" containing the list of matches.",
  },
  {
    id: "resilient-edit",
    covers: ["try/catch", "tool call with array-of-object argument", "error path"],
    prompt:
      "Replace the text \"TODO\" with \"DONE\" in the file given in the input. If the edit fails, " +
      "append a line describing the failure to \"errors.log\" instead. Return whether the edit " +
      "succeeded.",
  },
  {
    id: "think-then-act",
    covers: ["sequential tool calls", "boolean/number arguments", "output reuse"],
    prompt:
      "Use sequential thinking to plan, in three thoughts, how to summarise a repository. Then read " +
      "the README file at the path given in the input and store the summary of what you planned as " +
      "an observation on an entity named after the repository.",
  },
];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelConfig {
  apiKey: string;
  model: string;
  /**
   * `stealth/ox-alpha` is a reasoning model with a 131k context: it spends the
   * budget on thinking before it writes anything, and a low cap returns
   * `content: null` with `finish_reason: "length"`. 32k leaves room for both.
   */
  maxTokens?: number;
  attempts?: number;
  endpoint?: string;
  log?: (message: string) => void;
}

export interface ModelCall {
  content: string;
  finishReason: string | null;
  usage: unknown;
  ms: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

export async function callModel(messages: ChatMessage[], config: ModelConfig): Promise<ModelCall> {
  const endpoint = config.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
  const attempts = config.attempts ?? 4;
  const log = config.log ?? ((): void => undefined);
  let lastError = "";

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://github.com/codeflow/codeflow",
          "X-Title": "CodeFlow real-MCP conformance eval",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens ?? 32000,
          messages,
        }),
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${String(response.status)}: ${text.slice(0, 300)}`;
        if (response.status === 429 || response.status >= 500) {
          log(`  retrying after ${lastError}`);
          await sleep(2000 * attempt * attempt);
          continue;
        }
        throw new Error(lastError);
      }
      const payload = JSON.parse(text) as {
        choices?: { message?: { content?: string | null }; finish_reason?: string }[];
        usage?: unknown;
        error?: { message?: string };
      };
      if (payload.error !== undefined) {
        lastError = `API error: ${payload.error.message ?? "unknown"}`;
        log(`  retrying after ${lastError}`);
        await sleep(2000 * attempt);
        continue;
      }
      const choice = payload.choices?.[0];
      const content = choice?.message?.content ?? "";
      if (content.trim().length === 0) {
        lastError = `empty content (finish_reason=${choice?.finish_reason ?? "?"})`;
        log(`  retrying after ${lastError}`);
        await sleep(1000 * attempt);
        continue;
      }
      return {
        content,
        finishReason: choice?.finish_reason ?? null,
        usage: payload.usage ?? null,
        ms: Date.now() - startedAt,
      };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log(`  transport error: ${lastError}`);
      await sleep(2000 * attempt);
    }
  }

  throw new Error(`model call failed after ${String(attempts)} attempts — ${lastError}`);
}

/** Models fence their code however they were asked not to; that is not a defect. */
export function extractFlowSource(content: string): string {
  const fenced = /```(?:ts|typescript|javascript|js)?\s*\n([\s\S]*?)```/.exec(content);
  const source = fenced === null ? content : fenced[1]!;
  return `${source.trim()}\n`;
}

export interface EvalRound {
  round: number;
  source: string;
  level: ConformanceLevel;
  diagnostics: Diagnostic[];
  feedback: string | null;
  finishReason: string | null;
  ms: number;
}

export interface EvalResult {
  intent: string;
  covers: string[];
  firstLevel: ConformanceLevel;
  finalLevel: ConformanceLevel;
  retries: number;
  rounds: EvalRound[];
  /** Tool names the final source calls, resolved against the registry. */
  toolsUsed: string[];
  error?: string;
}

export interface RunIntentOptions {
  cf: CodeFlowModule;
  adapter: McpAdapterModule;
  intent: EvalIntent;
  config: ModelConfig;
  maxRetries?: number;
  target?: "L0" | "L1" | "L2";
  includeExamples?: boolean;
  log?: (message: string) => void;
}

const LEVEL_ORDER: Record<ConformanceLevel, number> = { invalid: 0, L0: 1, L1: 2, L2: 3 };

export async function runIntent(options: RunIntentOptions): Promise<EvalResult> {
  const { cf, intent, config } = options;
  const maxRetries = options.maxRetries ?? 2;
  const target = options.target ?? "L1";
  const log = options.log ?? ((): void => undefined);

  const registry = createRealMcpRegistry(cf, options.adapter);
  const session = cf.createCodeFlow({ registry });
  const context = await session.buildGenerationContext({
    includeExamples: options.includeExamples ?? true,
  });
  const system = cf.renderSystemPrompt(context);

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: intent.prompt },
  ];

  const rounds: EvalRound[] = [];
  let retries = 0;

  for (let round = 0; round <= maxRetries; round += 1) {
    log(`  [${intent.id}] round ${String(round)} …`);
    const call = await callModel(messages, config);
    const source = extractFlowSource(call.content);
    const result = await session.validate(source);
    const feedback = cf.renderDiagnosticsFeedback(result, { target });
    rounds.push({
      round,
      source,
      level: result.level,
      diagnostics: result.diagnostics,
      feedback,
      finishReason: call.finishReason,
      ms: call.ms,
    });
    log(`  [${intent.id}] round ${String(round)} → ${result.level} (${String(call.ms)}ms)`);

    if (LEVEL_ORDER[result.level] >= LEVEL_ORDER[target] || feedback === null) break;
    if (round === maxRetries) break;

    retries += 1;
    messages.push({ role: "assistant", content: source });
    messages.push({ role: "user", content: feedback });
  }

  // Which real tools the model actually reached for — the interesting signal
  // when the registry has near-synonyms (`readFile` vs `readTextFile`).
  const final = rounds[rounds.length - 1]!.source;
  const toolsUsed = registry
    .listTools()
    .map((tool) => tool.name)
    .filter((name) => final.includes(`tools.${name}(`))
    .sort();

  return {
    intent: intent.id,
    covers: intent.covers,
    firstLevel: rounds[0]!.level,
    finalLevel: rounds[rounds.length - 1]!.level,
    retries,
    rounds,
    toolsUsed,
  };
}

export function conformanceRates(results: EvalResult[]): {
  total: number;
  l0: number;
  l1: number;
  l2: number;
} {
  const at = (level: ConformanceLevel): number =>
    results.filter((result) => LEVEL_ORDER[result.finalLevel] >= LEVEL_ORDER[level]).length;
  return { total: results.length, l0: at("L0"), l1: at("L1"), l2: at("L2") };
}
