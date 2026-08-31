/**
 * Large-scale AI conformance eval — 10-ai-codegen.md §5, 11-testing.md §3.6.
 *
 * `real-mcp-suite.ts` asks for small flows (20–40 lines, one or two constructs)
 * against 24 real MCP tools and reports a conformance rate. That answers "does
 * the ladder survive a real API". It does not answer the question a host
 * actually has: **does it survive a real feature request** — a product-shaped
 * brief that needs 150–400 lines, nested loops, a bounded `while`, parallel
 * fan-out, narrow `try`/`catch`, `break`/`continue`, and 20–38 tools to pick
 * from.
 *
 * So this suite keeps the same ladder and changes three things:
 *
 *  - **Intents are briefs, not sentences.** Each one is written the way a PM
 *    writes a ticket: numbered requirements, edge cases, an explicit result.
 *  - **The registry is scoped per intent** (10 §4). Every intent mounts only the
 *    servers its brief needs, so a tool the model invents still fails L1 instead
 *    of accidentally resolving against a server the brief never mentioned.
 *  - **Scoring goes past pass/fail.** Every round records the size actually
 *    reached (lines, nodes, edges), which constructs the graph contains, how much
 *    of the flow fell into `code` nodes, the diagnostic codes seen, and the
 *    wall-clock and token cost. A run that reaches L2 by writing 40 lines for a
 *    300-line brief is a failure this suite can see and a rate cannot.
 *
 * Never a CI gate: network + a non-deterministic model (11 §4).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  ConformanceLevel,
  Diagnostic,
  Registry,
  WorkflowGraph,
  createCodeFlow,
  createRegistry,
  renderDiagnosticsFeedback,
  renderSystemPrompt,
} from "@codeflow-team/core";

import type { mcpToolsToDefinitions } from "../../src/adapter.js";
import type { McpTool } from "../../src/types.js";

/** The slice of the adapter the suite needs — injected, like in `real-mcp-suite`. */
export interface McpAdapterModule {
  mcpToolsToDefinitions: typeof mcpToolsToDefinitions;
}

/** The slice of `@codeflow-team/core` the suite needs, from `src` (vitest) or `dist` (runner). */
export interface CodeFlowModule {
  createRegistry: typeof createRegistry;
  createCodeFlow: typeof createCodeFlow;
  renderSystemPrompt: typeof renderSystemPrompt;
  renderDiagnosticsFeedback: typeof renderDiagnosticsFeedback;
}

// `types: []` in this package; the two host APIs used here are declared locally.
declare function fetch(url: string, init: RequestInit): Promise<FetchResponse>;
declare function setTimeout(handler: () => void, timeout: number): unknown;
declare const AbortSignal: { timeout(ms: number): unknown };
interface RequestInit {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: unknown;
}
interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "real-schemas");

/** Bump when the captured servers or the briefs below change — rates only compare within a version. */
export const LARGE_SCALE_EVAL_VERSION = 1;

/** Every captured server. An intent mounts a subset (10 §4). */
export const ALL_SERVERS = [
  "filesystem",
  "memory",
  "sequential-thinking",
  "everything",
  "context7",
  "deepwiki",
  "playwright",
  "duckduckgo",
] as const;

export type ServerName = (typeof ALL_SERVERS)[number];

export function createScopedRegistry(
  cf: CodeFlowModule,
  adapter: McpAdapterModule,
  servers: readonly ServerName[],
): Registry {
  const registry = cf.createRegistry();
  for (const server of servers) {
    const capture = JSON.parse(readFileSync(join(SCHEMA_DIR, `${server}.json`), "utf8")) as {
      tools: McpTool[];
    };
    for (const definition of adapter.mcpToolsToDefinitions(capture.tools, {
      namespace: server.replace(/-/g, "_"),
      server,
    })) {
      registry.registerTool(definition);
    }
  }
  return registry;
}

/**
 * A construct the brief is *designed* to require. Measured on the graph, not on
 * the text: "the model wrote the word `try`" is not the same claim as "the
 * projection contains a try node".
 */
export type ExpectedConstruct =
  | "loop"
  | "nested-loop"
  | "while-loop"
  | "condition"
  | "else-if-chain"
  | "try"
  | "parallel"
  | "jump"
  | "early-return"
  | "function";

export interface LargeIntent {
  id: string;
  /** Servers mounted for this brief — the model sees exactly these tools. */
  servers: readonly ServerName[];
  /** What a faithful implementation is expected to project to. */
  covers: ExpectedConstruct[];
  /** Rough size the brief implies, used to score "did it actually build the thing". */
  targetLines: number;
  /** The brief, written as a product requirement. */
  prompt: string;
}

/**
 * Seven briefs. Each one is sized so that a faithful implementation cannot fit
 * in 40 lines, and each forces a different combination of the constructs 01 §2
 * supports — the point is not that the model knows `try`, it is whether it still
 * writes `try` the CodeFlow way on the 200th line of a file.
 */
export const LARGE_INTENTS: LargeIntent[] = [
  {
    id: "repo-triage-bot",
    servers: ["filesystem", "memory"],
    covers: ["loop", "nested-loop", "condition", "else-if-chain", "try", "jump", "early-return"],
    targetLines: 180,
    prompt: [
      "Build the flow behind our repository triage bot.",
      "",
      "It is triggered with a root directory, a list of risky filename patterns, and a maximum",
      "number of files to inspect in one run.",
      "",
      "What it has to do:",
      "",
      "1. First check which directories the bot is allowed to touch. If the root directory it was",
      "   given is not one of them, stop immediately and return that the run was refused.",
      "2. Take a listing of the root directory with file sizes, and also the recursive tree, so the",
      "   report can say how big the repository is.",
      "3. For each risky pattern, search the repository for files matching it. If a pattern matches",
      "   nothing, skip straight to the next pattern.",
      "4. For each matching file, and only until we hit the maximum number of files for this run:",
      "   read the file's text. If reading it fails, append a line about the failure to",
      "   \"triage-errors.log\" and carry on with the next file rather than aborting the run.",
      "   When the read succeeds, also fetch the file's metadata, and decide a severity:",
      "   \"high\" if the file is larger than 100 KB or its contents mention a password,",
      "   \"medium\" if the contents mention TODO or FIXME,",
      "   \"low\" otherwise.",
      "   Record the file in the knowledge graph as an entity of type \"triaged-file\" whose",
      "   observations are its severity and its size.",
      "5. Every high-severity file must also be linked in the knowledge graph to an entity named",
      "   after this run, so we can pull them all back later.",
      "6. Once the maximum is reached, stop scanning — do not keep walking the rest of the patterns.",
      "7. At the end, read the whole knowledge graph back, and write \"triage-report.md\" containing",
      "   the number of files seen, the count per severity, and the list of high-severity paths.",
      "8. Return the per-severity counts and how many files failed to read.",
    ].join("\n"),
  },
  {
    id: "research-pipeline",
    servers: ["duckduckgo", "context7", "deepwiki", "sequential-thinking", "memory", "filesystem"],
    covers: ["loop", "nested-loop", "condition", "try", "parallel", "jump", "function"],
    targetLines: 200,
    prompt: [
      "Build the research pipeline flow our analysts trigger before writing a brief.",
      "",
      "Input: a research question, a list of library names to look up, and a GitHub repository",
      "that is relevant to the question.",
      "",
      "Requirements:",
      "",
      "1. Start by planning the research in three sequential thoughts, so the plan is on record.",
      "2. Search the web for the research question, and in parallel with that, fetch the wiki page",
      "   of the GitHub repository. Neither of those two should wait for the other.",
      "3. For every library name we were given: resolve it to a documentation id first. If it does",
      "   not resolve, skip that library and go on to the next one. When it does resolve, pull the",
      "   documentation for the research question topic. Wrap the documentation fetch so that a",
      "   failing source does not kill the run — on failure, note the library name in a list of dead",
      "   sources and continue.",
      "4. We frequently get the same source twice. Deduplicate the collected sources by their URL",
      "   before doing anything with them, using a helper function for the dedupe rather than",
      "   scattering the logic through the flow.",
      "5. For each surviving source, store it in the knowledge graph as an entity of type",
      "   \"source\" with the question as an observation, and relate it to an entity named after the",
      "   research question.",
      "6. Write two files: \"research/sources.md\" listing every source that survived, and",
      "   \"research/dead-sources.md\" listing the ones that failed. Write the dead-sources file only",
      "   if there were any.",
      "7. Return the number of sources kept, the number deduplicated away, and the number dead.",
    ].join("\n"),
  },
  {
    id: "browser-qa-suite",
    servers: ["playwright", "filesystem"],
    covers: ["loop", "nested-loop", "condition", "try", "jump", "early-return", "function"],
    targetLines: 220,
    prompt: [
      "Build the flow that runs our browser smoke-test suite before a release.",
      "",
      "Input: a base URL, and a list of scenarios. Each scenario has a name, a path to open, a list",
      "of steps (each step has a kind — \"click\", \"type\" or \"wait\" — plus a target and an optional",
      "text), and an expected piece of text that must appear at the end.",
      "",
      "Requirements:",
      "",
      "1. Resize the browser to a desktop viewport once, before any scenario runs.",
      "2. For each scenario: navigate to the base URL joined with the scenario path, then take an",
      "   accessibility snapshot so the steps have something to aim at.",
      "3. Then run the scenario's steps in order. A \"click\" step clicks the target, a \"type\" step",
      "   types the text into the target, a \"wait\" step waits for the target text to appear.",
      "   Steps that are none of those three kinds are skipped — move on to the next step.",
      "4. The whole per-scenario body must be wrapped so that a scenario that throws is recorded as",
      "   failed and the suite carries on with the next scenario instead of aborting. Whatever",
      "   happens, at the end of every scenario we take a screenshot and collect the browser console",
      "   messages — that clean-up must run even when the scenario failed.",
      "5. After the steps, check that the expected text is on the page. Passed and failed scenarios",
      "   are counted separately.",
      "6. If more than three scenarios fail, stop the suite early — do not run the rest.",
      "7. Whatever happened, close the browser at the very end, and write \"qa-report.md\" with the",
      "   pass and fail counts and the names of the failing scenarios.",
      "8. Return the pass count, the fail count and whether the run was cut short.",
    ].join("\n"),
  },
  {
    id: "incident-responder",
    servers: ["filesystem", "everything", "sequential-thinking"],
    covers: ["condition", "else-if-chain", "parallel", "loop", "try", "early-return", "function"],
    targetLines: 170,
    prompt: [
      "Build the incident responder flow.",
      "",
      "Input: an incident with an id, a title, a numeric error rate, a number of affected users, a",
      "service name, and a list of log file paths.",
      "",
      "Requirements:",
      "",
      "1. Classify the severity first, from the incident numbers alone:",
      "   \"sev1\" when the error rate is above 50 percent or more than 10000 users are affected,",
      "   \"sev2\" when the error rate is above 20 percent or more than 1000 users are affected,",
      "   \"sev3\" when the error rate is above 5 percent,",
      "   otherwise \"sev4\".",
      "2. A sev4 incident is not worth waking anyone: record it in an \"incidents/low.log\" file and",
      "   return straight away.",
      "3. For everything else, collect context. Three things have to be gathered at the same time,",
      "   not one after the other: the environment the service runs in, a structured status payload,",
      "   and the directory listing of the incident's log folder.",
      "4. Then read each log file the incident references. A log file that cannot be read is not a",
      "   reason to fail the response — note it and keep going through the rest.",
      "5. For a sev1 or sev2 incident, reason through the collected context in three sequential",
      "   thoughts before doing anything else, and use a helper function to build the escalation",
      "   message rather than assembling it inline.",
      "6. Escalation: sev1 notifies the on-call channel and the incident commander (both at once,",
      "   neither waits for the other), sev2 notifies only the on-call channel, sev3 just gets a",
      "   line appended to \"incidents/tracked.log\".",
      "7. Always write the incident timeline to \"incidents/<id>.md\" at the end.",
      "8. Return the severity, how many logs were read and how many failed.",
    ].join("\n"),
  },
  {
    id: "data-migration",
    servers: ["filesystem", "memory"],
    covers: ["loop", "nested-loop", "condition", "try", "jump", "function", "early-return"],
    targetLines: 190,
    prompt: [
      "Build the data migration flow that moves our legacy note files into the knowledge graph.",
      "",
      "Input: a source directory, a destination directory, a batch size, and the maximum number of",
      "failures we tolerate before giving up.",
      "",
      "Requirements:",
      "",
      "1. Make sure the destination directory exists before anything is written.",
      "2. Find every note file under the source directory.",
      "3. If there are no notes at all, write an empty migration report and return immediately.",
      "4. Process the notes in batches of the given batch size. For each batch: read the whole batch",
      "   in one go, then for each note in the batch, transform it — the transformation is its own",
      "   named helper, not inline code — and write the transformed note into the destination",
      "   directory.",
      "5. Count successes and failures as you go. A note that fails to read or write is a failure:",
      "   record the path and the reason, and continue with the next note.",
      "6. Notes that are empty after transformation are skipped rather than written, and they count",
      "   as neither success nor failure.",
      "7. If the number of failures ever exceeds the tolerated maximum, abandon the migration: stop",
      "   processing batches immediately.",
      "8. Every successfully migrated note is recorded in the knowledge graph as an entity of type",
      "   \"note\" with the original path as an observation.",
      "9. At the end write \"migration-report.md\" with the counts and the list of failures, and",
      "   return the number migrated, skipped, failed, and whether we aborted.",
    ].join("\n"),
  },
  {
    id: "knowledge-base-sync",
    servers: ["memory", "context7", "deepwiki", "duckduckgo", "filesystem"],
    covers: ["while-loop", "loop", "nested-loop", "condition", "try", "jump", "function"],
    targetLines: 170,
    prompt: [
      "Build the flow that keeps our knowledge base in sync with upstream documentation.",
      "",
      "Input: a list of topics, a page size, and the maximum number of pages to walk per topic.",
      "",
      "Requirements:",
      "",
      "1. For every topic, page through the existing knowledge graph entries: keep asking for the",
      "   next page of matching nodes until a page comes back smaller than the page size, or until",
      "   we have walked the maximum number of pages for that topic. This must be a loop with a",
      "   visible stopping condition — we have been burned by a runaway sync before.",
      "2. Collect the node names from every page, and deduplicate them with a helper function",
      "   before using them: the same node shows up on more than one page regularly.",
      "3. For each deduplicated node, look for a matching upstream document: search the web for the",
      "   node name plus the topic. If the search returns nothing, skip that node.",
      "4. For nodes that do have an upstream hit, fetch the upstream documentation. A source that",
      "   fails must not stop the sync — note the failure and carry on.",
      "5. When the upstream document is newer than what we hold, add the new text as an observation",
      "   on the node; when the node no longer exists upstream at all, delete it from the graph.",
      "6. Never touch more than the maximum number of pages worth of nodes for a single topic.",
      "7. Write \"sync-log.md\" at the end listing, per topic, how many nodes were updated, deleted,",
      "   skipped and failed, and return those totals.",
    ].join("\n"),
  },
  {
    id: "dependency-audit",
    servers: ["filesystem", "context7", "deepwiki", "sequential-thinking"],
    covers: ["loop", "nested-loop", "condition", "else-if-chain", "try", "parallel", "jump"],
    targetLines: 160,
    prompt: [
      "Build the dependency audit flow that runs weekly over our repositories.",
      "",
      "Input: a list of repository directories, and a list of dependency names we consider risky.",
      "",
      "Requirements:",
      "",
      "1. For each repository directory, find its manifest files. A repository with no manifest is",
      "   skipped — go on to the next repository.",
      "2. For each manifest found, read it. If the read fails, record the repository and manifest in",
      "   a failure list and continue rather than aborting the audit.",
      "3. For each risky dependency name, check whether the manifest mentions it. When it does,",
      "   resolve the dependency's documentation id and fetch its documentation and its wiki page —",
      "   those two lookups should happen at the same time, not one after the other.",
      "4. Grade each finding: \"critical\" when the manifest pins the dependency to a version below 1,",
      "   \"warning\" when the dependency appears in the manifest's direct dependencies,",
      "   \"info\" otherwise.",
      "5. Once the audit has collected more than twenty findings, stop looking at further",
      "   repositories — that is already more than a human can review in a week.",
      "6. Reason over the collected findings in three sequential thoughts to produce a recommendation.",
      "7. Write \"audit/report.md\" with every finding grouped by grade plus the recommendation, and",
      "   write \"audit/failures.md\" when anything failed to read.",
      "8. Return the counts per grade and the number of repositories audited.",
    ].join("\n"),
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
   * `stealth/ox-alpha` is a reasoning model with a 131k window. Small flows fit
   * under 32k; a 300-line flow plus the reasoning that precedes it does not, and
   * a low cap returns `content: null` with `finish_reason: "length"`. 48k is the
   * default here for exactly that reason.
   */
  maxTokens?: number;
  attempts?: number;
  endpoint?: string;
  /**
   * Per-attempt deadline. A feature-sized generation legitimately runs for ten
   * minutes, but a request that has produced nothing after twenty is a stalled
   * connection, not a slow one — observed hanging for 45 minutes with no
   * response and no error. Without this the run silently loses an intent.
   */
  requestTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface ModelUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface ModelCall {
  content: string;
  finishReason: string | null;
  usage: ModelUsage;
  ms: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

/**
 * Duplicated from `real-mcp-suite.ts` rather than imported: the runner script is
 * executed by Node with type stripping, which does not resolve a `./x.js`
 * specifier to `x.ts`, so a cross-suite import would run under vitest and break
 * under the runner. Fifty lines of HTTP is the cheaper half of that trade.
 */
export async function callModel(messages: ChatMessage[], config: ModelConfig): Promise<ModelCall> {
  const endpoint = config.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
  // The free tier of `stealth/ox-alpha` shares one upstream pool, and a
  // feature-sized generation sits in it for minutes; 429 is routine rather than
  // exceptional. Eight attempts with a backoff that reaches a minute is what it
  // takes for a seven-intent run to finish without holes in the data.
  const attempts = config.attempts ?? 8;
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
          "X-Title": "CodeFlow large-scale conformance eval",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens ?? 48000,
          messages,
        }),
        signal: AbortSignal.timeout(config.requestTimeoutMs ?? 20 * 60 * 1000),
      });
      const text = await response.text();
      if (!response.ok) {
        lastError = `HTTP ${String(response.status)}: ${text.slice(0, 200)}`;
        if (response.status === 429 || response.status >= 500) {
          const wait = Math.min(60_000, 3000 * attempt * attempt);
          log(`  retrying in ${String(Math.round(wait / 1000))}s after ${lastError}`);
          await sleep(wait);
          continue;
        }
        throw new Error(lastError);
      }
      const payload = JSON.parse(text) as {
        choices?: { message?: { content?: string | null }; finish_reason?: string }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
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
        usage: {
          promptTokens: payload.usage?.prompt_tokens ?? null,
          completionTokens: payload.usage?.completion_tokens ?? null,
          totalTokens: payload.usage?.total_tokens ?? null,
        },
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

/**
 * What the graph is made of. `code` and `unknown` are counted apart from the
 * rest because they are the two node types a non-developer cannot read: the
 * ratio between them and everything else is the "map đẹp" number that a
 * conformance level rounds away.
 */
export interface GraphShape {
  nodes: number;
  edges: number;
  /** node type → count */
  nodeTypes: Record<string, number>;
  codeNodes: number;
  unknownNodes: number;
  /** Nodes a reader can name, over total. */
  meaningfulRatio: number;
  /** Deepest nesting of loop/condition/try nodes, measured from source ranges. */
  maxNesting: number;
  toolCalls: number;
}

const CONTAINER_TYPES = new Set(["loop", "condition", "try", "parallel"]);

export function graphShape(graph: WorkflowGraph): GraphShape {
  const nodeTypes: Record<string, number> = {};
  for (const node of graph.nodes) {
    nodeTypes[node.type] = (nodeTypes[node.type] ?? 0) + 1;
  }
  const total = graph.nodes.length;
  const codeNodes = nodeTypes["code"] ?? 0;
  const unknownNodes = nodeTypes["unknown"] ?? 0;

  // Nesting from source containment: a container node whose range strictly
  // contains another container's range is one level shallower than it. Reading
  // it off the source avoids depending on how the graph happens to store
  // parentage, which 03 leaves to the mapper.
  const containers = graph.nodes.filter((node) => CONTAINER_TYPES.has(node.type));
  let maxNesting = 0;
  for (const node of containers) {
    let depth = 1;
    for (const other of containers) {
      if (other.id === node.id) continue;
      const contains =
        other.source.start.offset <= node.source.start.offset &&
        other.source.end.offset >= node.source.end.offset &&
        (other.source.start.offset < node.source.start.offset ||
          other.source.end.offset > node.source.end.offset);
      if (contains) depth += 1;
    }
    if (depth > maxNesting) maxNesting = depth;
  }

  return {
    nodes: total,
    edges: graph.edges.length,
    nodeTypes,
    codeNodes,
    unknownNodes,
    meaningfulRatio: total === 0 ? 0 : (total - codeNodes - unknownNodes) / total,
    maxNesting,
    toolCalls: nodeTypes["tool"] ?? 0,
  };
}

/**
 * Which of the constructs a brief asked for actually made it into the graph.
 * Measured on nodes, never on the source text: a `try` the analyzer could not
 * project is a `try` the reader of the graph does not get.
 */
export function coveredConstructs(graph: WorkflowGraph): Set<ExpectedConstruct> {
  const found = new Set<ExpectedConstruct>();
  const byType = (type: string): typeof graph.nodes =>
    graph.nodes.filter((node) => node.type === type);

  const loops = byType("loop");
  if (loops.length > 0) found.add("loop");
  if (loops.some((node) => node.data["kind"] === "while")) found.add("while-loop");
  if (byType("try").length > 0) found.add("try");
  if (byType("parallel").length > 0) found.add("parallel");
  if (byType("jump").length > 0) found.add("jump");
  if (byType("function").length > 0) found.add("function");

  const conditions = byType("condition");
  if (conditions.length > 0) found.add("condition");
  // An else-if chain is a condition node whose range contains another one, with
  // no loop or try in between — the shape 01 §2 projects `else if` to.
  for (const outer of conditions) {
    for (const inner of conditions) {
      if (inner.id === outer.id) continue;
      const nested =
        outer.source.start.offset < inner.source.start.offset &&
        outer.source.end.offset >= inner.source.end.offset;
      if (nested) found.add("else-if-chain");
    }
  }

  // A flow with more than one output node returned early somewhere.
  if (byType("output").length > 1) found.add("early-return");

  // Nested loop: a loop node whose source range contains another loop node.
  for (const outer of loops) {
    for (const inner of loops) {
      if (inner.id === outer.id) continue;
      if (
        outer.source.start.offset < inner.source.start.offset &&
        outer.source.end.offset >= inner.source.end.offset
      ) {
        found.add("nested-loop");
      }
    }
  }

  return found;
}

export interface LargeRound {
  round: number;
  source: string;
  lines: number;
  level: ConformanceLevel;
  diagnostics: Diagnostic[];
  diagnosticCodes: Record<string, number>;
  shape: GraphShape | null;
  covered: ExpectedConstruct[];
  missing: ExpectedConstruct[];
  feedback: string | null;
  finishReason: string | null;
  usage: ModelUsage;
  ms: number;
}

export interface LargeResult {
  intent: string;
  servers: readonly ServerName[];
  toolCount: number;
  systemPromptTokens: number;
  covers: ExpectedConstruct[];
  targetLines: number;
  includeExamples: boolean;
  firstLevel: ConformanceLevel;
  finalLevel: ConformanceLevel;
  retries: number;
  rounds: LargeRound[];
  /** Tool names the final source calls, resolved against the scoped registry. */
  toolsUsed: string[];
  totalMs: number;
  error?: string;
}

export interface RunLargeIntentOptions {
  cf: CodeFlowModule;
  adapter: McpAdapterModule;
  intent: LargeIntent;
  config: ModelConfig;
  maxRetries?: number;
  /** Defaults to `L2`: the whole question here is whether size costs quality. */
  target?: "L0" | "L1" | "L2";
  includeExamples?: boolean;
  log?: (message: string) => void;
}

const LEVEL_ORDER: Record<ConformanceLevel, number> = { invalid: 0, L0: 1, L1: 2, L2: 3 };

function countCodes(diagnostics: readonly Diagnostic[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.severity}/${diagnostic.code}`;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export async function runLargeIntent(options: RunLargeIntentOptions): Promise<LargeResult> {
  const { cf, intent, config } = options;
  const maxRetries = options.maxRetries ?? 2;
  const target = options.target ?? "L2";
  const includeExamples = options.includeExamples ?? true;
  const log = options.log ?? ((): void => undefined);

  const registry = createScopedRegistry(cf, options.adapter, intent.servers);
  const session = cf.createCodeFlow({ registry });
  const context = await session.buildGenerationContext({ includeExamples });
  const system = cf.renderSystemPrompt(context);

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: intent.prompt },
  ];

  const rounds: LargeRound[] = [];
  let retries = 0;
  const startedAt = Date.now();

  for (let round = 0; round <= maxRetries; round += 1) {
    log(`  [${intent.id}] round ${String(round)} …`);
    const call = await callModel(messages, config);
    const source = extractFlowSource(call.content);
    const result = await session.validate(source);
    const feedback = cf.renderDiagnosticsFeedback(result, { target });

    // The graph is what the size and coverage numbers are read off. It only
    // exists when the file parses; below L0 there is nothing to measure.
    let shape: GraphShape | null = null;
    let covered: ExpectedConstruct[] = [];
    if (result.level !== "invalid") {
      const graph = await session.analyze(source);
      shape = graphShape(graph);
      covered = [...coveredConstructs(graph)].sort();
    }

    rounds.push({
      round,
      source,
      lines: source.trimEnd().split("\n").length,
      level: result.level,
      diagnostics: result.diagnostics,
      diagnosticCodes: countCodes(result.diagnostics),
      shape,
      covered,
      missing: intent.covers.filter((construct) => !covered.includes(construct)),
      feedback,
      finishReason: call.finishReason,
      usage: call.usage,
      ms: call.ms,
    });
    log(
      `  [${intent.id}] round ${String(round)} → ${result.level} · ` +
        `${String(rounds[rounds.length - 1]!.lines)} lines · ` +
        `${String(shape?.nodes ?? 0)} nodes · ${String(call.ms)}ms`,
    );

    if (LEVEL_ORDER[result.level] >= LEVEL_ORDER[target] || feedback === null) break;
    if (round === maxRetries) break;

    retries += 1;
    messages.push({ role: "assistant", content: source });
    messages.push({ role: "user", content: feedback });
  }

  const final = rounds[rounds.length - 1]!.source;
  const toolsUsed = registry
    .listTools()
    .map((tool) => tool.name)
    .filter((name) => final.includes(`tools.${name}(`))
    .sort();

  return {
    intent: intent.id,
    servers: intent.servers,
    toolCount: registry.listTools().length,
    systemPromptTokens: Math.ceil(system.length / 4),
    covers: intent.covers,
    targetLines: intent.targetLines,
    includeExamples,
    firstLevel: rounds[0]!.level,
    finalLevel: rounds[rounds.length - 1]!.level,
    retries,
    rounds,
    toolsUsed,
    totalMs: Date.now() - startedAt,
  };
}

export interface ConformanceRates {
  total: number;
  l0: number;
  l1: number;
  l2: number;
}

export function conformanceRates(results: readonly LargeResult[]): ConformanceRates {
  const at = (level: ConformanceLevel): number =>
    results.filter((result) => LEVEL_ORDER[result.finalLevel] >= LEVEL_ORDER[level]).length;
  return { total: results.length, l0: at("L0"), l1: at("L1"), l2: at("L2") };
}

/**
 * The same ladder scored on **round 0** — before any diagnostics were fed back.
 * A host that generates once and renders the graph gets this number, not the
 * one above, and at feature scale the two came apart completely: the retry loop
 * is doing the work the prompt alone used to do at 20–40 lines.
 */
export function firstRoundRates(results: readonly LargeResult[]): ConformanceRates {
  const at = (level: ConformanceLevel): number =>
    results.filter((result) => LEVEL_ORDER[result.firstLevel] >= LEVEL_ORDER[level]).length;
  return { total: results.length, l0: at("L0"), l1: at("L1"), l2: at("L2") };
}

/** Diagnostic codes over every round of every result — the "what breaks" table. */
export function diagnosticHistogram(results: readonly LargeResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    for (const round of result.rounds) {
      for (const [code, n] of Object.entries(round.diagnosticCodes)) {
        counts[code] = (counts[code] ?? 0) + n;
      }
    }
  }
  return counts;
}

/** How much of what each brief asked for the model actually projected. */
export function constructCoverage(results: readonly LargeResult[]): {
  asked: number;
  covered: number;
  missingByConstruct: Record<string, number>;
} {
  let asked = 0;
  let covered = 0;
  const missingByConstruct: Record<string, number> = {};
  for (const result of results) {
    const last = result.rounds[result.rounds.length - 1];
    if (last === undefined) continue;
    asked += result.covers.length;
    covered += result.covers.length - last.missing.length;
    for (const construct of last.missing) {
      missingByConstruct[construct] = (missingByConstruct[construct] ?? 0) + 1;
    }
  }
  return { asked, covered, missingByConstruct };
}
