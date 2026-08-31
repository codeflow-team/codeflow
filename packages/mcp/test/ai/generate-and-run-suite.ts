/**
 * The **generate → validate → run** eval — 10-ai-codegen.md §5 taken one step
 * further than it has ever been taken here.
 *
 * `real-mcp-suite.ts` and `large-scale-suite.ts` both stop at the conformance
 * ladder: L0 (it parses and honours the contract), L1 (every name resolves),
 * L2 (it projects to a clean graph). All three are *static* judgements. None of
 * them has ever answered the question the owner of this project actually asks:
 *
 *   > cho agent sinh ra và test xem có chạy được không
 *
 * A flow can be L2 and still be dead code — it can read `listDirectory(...)`
 * as an array when the server returns `{ content: string }`, pass a `path`
 * where the server wants `paths`, or write to a directory it never created.
 * The ladder cannot see any of that, because the ladder never executes
 * anything.
 *
 * So this suite adds a fourth rung nobody can fake:
 *
 *  1. **Only runnable tools.** The registry is built from the four MCP servers
 *     the demo runner will really start (`filesystem`, `memory`, `everything`,
 *     `sequential-thinking` — see `apps/demo/server/mcp-servers.ts`), under the
 *     same namespaces (`fs`, `memory`, `everything`, `reasoning`) and the same
 *     method slugging (`packages/examples/scripts/servers.mjs`). If a stubbed
 *     namespace were in the registry, "it ran" would mean "it called a sample",
 *     which is worth nothing.
 *  2. **The flow is executed** through `apps/demo/server/runner.ts`, against
 *     real servers, over a real seeded workspace.
 *  3. **The effect is checked on disk**, not in the transcript: the files a
 *     brief asked for must exist and contain what they were asked to contain,
 *     and the entities a brief asked for must be in the memory server's JSON.
 *  4. **Runtime errors are fed back to the model** — the same loop as
 *     `renderDiagnosticsFeedback`, except the input is what the machine did,
 *     not what the analyzer thought.
 *
 * Never a CI gate: network, a non-deterministic model, and four `npx` servers
 * (11 §4). The offline half of `generate-and-run.test.ts` is the part that runs
 * in `pnpm test`.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
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

/* -------------------------------------------------------------------------- */
/* model transport                                                             */
/* -------------------------------------------------------------------------- */

/*
 * Copied from `large-scale-suite.ts` rather than imported, for the reason that
 * file already documents: this suite is executed by Node with type stripping,
 * which does not resolve a `./x.js` specifier to `x.ts`. A cross-suite import
 * therefore works under vitest and explodes under the eval runner — which is
 * where it matters.
 */

// `types: []` in this package; the host APIs used here are declared locally.
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

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelConfig {
  apiKey: string;
  model: string;
  maxTokens?: number;
  attempts?: number;
  endpoint?: string;
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

export async function callModel(messages: ChatMessage[], config: ModelConfig): Promise<ModelCall> {
  const endpoint = config.endpoint ?? "https://openrouter.ai/api/v1/chat/completions";
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
          "X-Title": "CodeFlow generate-and-run eval",
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxTokens ?? 32000,
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

/** What the graph is made of — the shape numbers a level rounds away. */
export interface GraphShape {
  nodes: number;
  edges: number;
  nodeTypes: Record<string, number>;
  codeNodes: number;
  unknownNodes: number;
  meaningfulRatio: number;
  toolCalls: number;
}

export function graphShape(graph: WorkflowGraph): GraphShape {
  const nodeTypes: Record<string, number> = {};
  for (const node of graph.nodes) {
    nodeTypes[node.type] = (nodeTypes[node.type] ?? 0) + 1;
  }
  const total = graph.nodes.length;
  const codeNodes = nodeTypes["code"] ?? 0;
  const unknownNodes = nodeTypes["unknown"] ?? 0;
  return {
    nodes: total,
    edges: graph.edges.length,
    nodeTypes,
    codeNodes,
    unknownNodes,
    meaningfulRatio: total === 0 ? 0 : (total - codeNodes - unknownNodes) / total,
    toolCalls: nodeTypes["tool"] ?? 0,
  };
}

/**
 * Bump when the servers, the briefs, the seeded workspace or the effect checks
 * change — rates only compare within a version.
 *
 * **v2** relaxed three effect checks that were stricter than the brief they
 * scored. `input.maxModules` is synthesized as `3`, so a flow that audits the
 * first three `*.ts` files it finds is *obeying* the brief and never reaches
 * `orders.ts` (fourth alphabetically); v1 nevertheless demanded the word
 * `orders.ts` in the report and marked two correct runs as effect-less. v2 asks
 * for `money.ts`, which is inside any limit ≥ 2. Likewise `batch-migrate` is now
 * scored on the migrated file that has to exist in `archive/` rather than on
 * whether the report happens to list it — the brief only ever asked the report
 * for counts and failures. Baseline numbers taken under v1 are labelled as such
 * in the summary; the difference between them is a measurement of the harness,
 * not of the model.
 */
export const GENERATE_AND_RUN_EVAL_VERSION = 2;

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "real-schemas");

export interface McpAdapterModule {
  mcpToolsToDefinitions: typeof mcpToolsToDefinitions;
}

export interface CodeFlowModule {
  createRegistry: typeof createRegistry;
  createCodeFlow: typeof createCodeFlow;
  renderSystemPrompt: typeof renderSystemPrompt;
  renderDiagnosticsFeedback: typeof renderDiagnosticsFeedback;
}

/* -------------------------------------------------------------------------- */
/* the runnable registry                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The four servers `apps/demo/server/mcp-servers.ts` is willing to start, with
 * the namespaces and renames `packages/examples/scripts/servers.mjs` uses.
 *
 * The two lists have to agree method-for-method: the worker maps
 * `tools.<ns>.<method>` back to an MCP tool name with the *same* slugging, so a
 * namespace spelled `filesystem` here would be a namespace the runner stubs.
 */
export const RUNNABLE_SERVERS = [
  { file: "filesystem.json", namespace: "fs" },
  { file: "memory.json", namespace: "memory" },
  { file: "everything.json", namespace: "everything" },
  {
    file: "sequential-thinking.json",
    namespace: "reasoning",
    rename: { sequentialthinking: "sequentialThinking" } as Record<string, string>,
  },
] as const;

/** Every tool in it is backed by a server the runner really launches. */
export function createRunnableRegistry(cf: CodeFlowModule, adapter: McpAdapterModule): Registry {
  const registry = cf.createRegistry();
  for (const server of RUNNABLE_SERVERS) {
    const capture = JSON.parse(readFileSync(join(SCHEMA_DIR, server.file), "utf8")) as {
      tools: McpTool[];
      server?: string;
    };
    const rename = "rename" in server ? server.rename : undefined;
    for (const definition of adapter.mcpToolsToDefinitions(capture.tools, {
      namespace: server.namespace,
      server: capture.server ?? server.file.replace(/\.json$/, ""),
      methodName: (tool) => rename?.[tool.name] ?? tool.name,
    })) {
      registry.registerTool(definition);
    }
  }
  return registry;
}

/* -------------------------------------------------------------------------- */
/* the workspace every brief is written against                                */
/* -------------------------------------------------------------------------- */

/**
 * What `seedWorkspace()` in `apps/demo/server/runner.ts` puts on disk before a
 * run, restated for the model.
 *
 * Restated rather than imported on purpose: this text is *prompt material*, and
 * a prompt that drifts from the runner is a bug the eval must be able to catch
 * — `generate-and-run.test.ts` asserts the two agree.
 */
export const SEEDED_FILES = [
  "README.md",
  "package.json",
  "index.ts",
  "orders.ts",
  "money.ts",
  "session.ts",
  "orders.test.ts",
  "docs/orders.md",
  "docs/money.md",
  "CHANGELOG.md",
  "drop-east.csv",
  "drop-west.csv",
] as const;

export const WORKSPACE_BRIEF = [
  "The flow runs against a real filesystem MCP server rooted at one directory — the",
  "value of `input.root`. Nothing outside it can be read or written. When the flow",
  "starts, that directory contains exactly:",
  "",
  "```",
  "README.md            # a two-line markdown file",
  "CHANGELOG.md         # a two-line markdown file",
  "package.json         # { name, version, type, dependencies: { '@modelcontextprotocol/sdk', '@codeflow-team/core', 'zod' } }",
  "index.ts             # re-exports parseOrder and formatMoney, declares VERSION",
  "orders.ts            # exports interface Order and function parseOrder (has a JSDoc comment)",
  "money.ts             # exports formatMoney",
  "session.ts           # exports isExpired, mentions Auth in a comment",
  "orders.test.ts       # imports parseOrder and calls it",
  "docs/orders.md       # documents orders.ts — its mtime is 400 DAYS OLD",
  "docs/money.md        # documents money.ts — freshly written",
  "drop-east.csv        # header `id,region,amount`, then E-1/east/1200.50, E-2/east/880, E-3/east/not-a-number, E-4//410.25",
  "drop-west.csv        # header `id,region,amount`, then W-1/west/2200, W-2/central/145.75, W-3/west/90.10",
  "```",
  "",
  "There is no `docs/session.md`, no `docs/index.md`, and no subdirectory other than",
  "`docs/`. Paths you pass to the filesystem server must be absolute — build them by",
  "joining `input.root` with the relative path, e.g. `` `${input.root}/ledger.md` ``.",
  "Every file you are asked to write goes directly under `input.root` unless the",
  "requirement says otherwise.",
].join("\n");

/* -------------------------------------------------------------------------- */
/* what "it really did something" means                                        */
/* -------------------------------------------------------------------------- */

export interface FileExpectation {
  /** Path relative to the workspace root. */
  path: string;
  /** Case-insensitive substrings the file has to contain. */
  contains?: string[];
  /** Minimum byte size — a file written empty is not an effect. */
  minBytes?: number;
}

export interface MemoryExpectation {
  /** At least this many entities in the memory server's graph. */
  minEntities?: number;
  /** At least one entity of each of these `entityType`s. */
  entityTypes?: string[];
  minRelations?: number;
}

export interface Expectation {
  files?: FileExpectation[];
  memory?: MemoryExpectation;
}

export interface EffectCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface MemoryGraphOnDisk {
  entities: { name: string; entityType: string; observations: string[] }[];
  relations: { from: string; to: string; relationType: string }[];
}

/** `server-memory` writes one JSON object per line, not one JSON document. */
export function readMemoryGraph(workspace: string): MemoryGraphOnDisk {
  const graph: MemoryGraphOnDisk = { entities: [], relations: [] };
  let text: string;
  try {
    text = readFileSync(join(workspace, "memory.json"), "utf8");
  } catch {
    return graph;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      if (record["type"] === "entity") {
        graph.entities.push({
          name: String(record["name"] ?? ""),
          entityType: String(record["entityType"] ?? ""),
          observations: Array.isArray(record["observations"])
            ? (record["observations"] as unknown[]).map((value) => String(value))
            : [],
        });
      } else if (record["type"] === "relation") {
        graph.relations.push({
          from: String(record["from"] ?? ""),
          to: String(record["to"] ?? ""),
          relationType: String(record["relationType"] ?? ""),
        });
      }
    } catch {
      // A half-written line is not an entity; skipping it is the honest read.
    }
  }
  return graph;
}

/** Every file under `dir`, relative, sorted, with sizes. */
export function listTree(dir: string, base = dir): { path: string; bytes: number }[] {
  const out: { path: string; bytes: number }[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) out.push(...listTree(full, base));
    else out.push({ path: relative(base, full), bytes: info.size });
  }
  return out;
}

export interface EffectReport {
  checks: EffectCheck[];
  ok: boolean;
  /** Files that were not there before the flow ran. */
  newFiles: { path: string; bytes: number }[];
  memoryEntities: number;
  memoryRelations: number;
  /** A short, quotable piece of what the flow actually wrote. */
  evidence: { path: string; bytes: number; head: string }[];
}

const IGNORED_ARTEFACTS = new Set(["memory.json"]);

export function checkEffects(workspace: string, expectation: Expectation): EffectReport {
  const tree = listTree(workspace);
  const seeded = new Set<string>(SEEDED_FILES);
  const newFiles = tree.filter((file) => !seeded.has(file.path) && !IGNORED_ARTEFACTS.has(file.path));
  const memory = readMemoryGraph(workspace);
  const checks: EffectCheck[] = [];
  const evidence: EffectReport["evidence"] = [];

  for (const wanted of expectation.files ?? []) {
    const found = tree.find((file) => file.path === wanted.path);
    if (found === undefined) {
      checks.push({
        label: `file ${wanted.path}`,
        ok: false,
        detail: `not written (the run left: ${newFiles.map((f) => f.path).join(", ") || "no new files at all"})`,
      });
      continue;
    }
    const minBytes = wanted.minBytes ?? 1;
    if (found.bytes < minBytes) {
      checks.push({
        label: `file ${wanted.path}`,
        ok: false,
        detail: `written but only ${String(found.bytes)} bytes (wanted at least ${String(minBytes)})`,
      });
      continue;
    }
    const body = readFileSync(join(workspace, wanted.path), "utf8");
    const missing = (wanted.contains ?? []).filter(
      (needle) => !body.toLowerCase().includes(needle.toLowerCase()),
    );
    evidence.push({ path: wanted.path, bytes: found.bytes, head: body.slice(0, 400) });
    checks.push(
      missing.length === 0
        ? { label: `file ${wanted.path}`, ok: true, detail: `${String(found.bytes)} bytes` }
        : {
            label: `file ${wanted.path}`,
            ok: false,
            detail: `written (${String(found.bytes)} bytes) but does not mention: ${missing.join(", ")}`,
          },
    );
  }

  const wantedMemory = expectation.memory;
  if (wantedMemory !== undefined) {
    if (wantedMemory.minEntities !== undefined) {
      checks.push({
        label: "memory entities",
        ok: memory.entities.length >= wantedMemory.minEntities,
        detail: `${String(memory.entities.length)} on disk (wanted ≥ ${String(wantedMemory.minEntities)})`,
      });
    }
    for (const type of wantedMemory.entityTypes ?? []) {
      const hits = memory.entities.filter((entity) => entity.entityType === type);
      checks.push({
        label: `memory entityType "${type}"`,
        ok: hits.length > 0,
        detail:
          hits.length > 0
            ? `${String(hits.length)}, e.g. ${JSON.stringify(hits[0])}`
            : `none (types present: ${[...new Set(memory.entities.map((e) => e.entityType))].join(", ") || "—"})`,
      });
    }
    if (wantedMemory.minRelations !== undefined) {
      checks.push({
        label: "memory relations",
        ok: memory.relations.length >= wantedMemory.minRelations,
        detail: `${String(memory.relations.length)} on disk (wanted ≥ ${String(wantedMemory.minRelations)})`,
      });
    }
  }

  return {
    checks,
    ok: checks.every((check) => check.ok),
    newFiles,
    memoryEntities: memory.entities.length,
    memoryRelations: memory.relations.length,
    evidence,
  };
}

/* -------------------------------------------------------------------------- */
/* the briefs                                                                  */
/* -------------------------------------------------------------------------- */

export type ExpectedConstruct =
  | "loop"
  | "nested-loop"
  | "while-loop"
  | "condition"
  | "try"
  | "parallel"
  | "jump"
  | "early-return"
  | "function";

export interface RunIntent {
  id: string;
  covers: ExpectedConstruct[];
  targetLines: number;
  /** The brief, minus the workspace description, which is appended to all. */
  prompt: string;
  expect: Expectation;
}

/**
 * Seven briefs, each of which needs the machine to do something a checker can
 * see afterwards. They are deliberately smaller than `large-scale-suite`'s
 * (60–140 lines rather than 150–400): the question here is not whether size
 * costs conformance — that is measured — but whether *correct-looking* code
 * survives contact with a real server.
 *
 * `input` is synthesized by `apps/demo/server/input.ts` from the parameter
 * type, so every brief names the exact parameter shape it must declare and
 * every path-ish name is one that file maps onto the workspace (`root` →
 * the scratch directory, `max…`/`…Limit` → 3, booleans → true).
 */
export const RUN_INTENTS: RunIntent[] = [
  {
    id: "csv-ledger",
    covers: ["loop", "nested-loop", "condition", "try", "jump", "early-return"],
    targetLines: 110,
    expect: {
      files: [
        { path: "ledger.md", contains: ["east", "west"], minBytes: 20 },
        { path: "rejects.md", contains: ["E-3"], minBytes: 10 },
      ],
    },
    prompt: [
      "Build the flow that folds our regional drop files into one ledger.",
      "",
      "The flow's input parameter type must be exactly `{ root: string; maxRows: number }`.",
      "",
      "Requirements:",
      "",
      "1. List the root directory. If it contains no file whose name starts with `drop-` and",
      "   ends with `.csv`, write nothing and return `{ folded: 0, reason: \"no-drops\" }`",
      "   immediately.",
      "2. Also try to read `drop-north.csv`. That file does not exist and the server will",
      "   throw — that must not end the run: catch it, count it as a missing region, and",
      "   carry on.",
      "3. For each drop file, read its text, then for each data row in it (skip the header",
      "   line): split the row on commas into id, region and amount.",
      "4. A row whose region is empty, or whose amount is not a number, is a reject: record",
      "   it and `continue` with the next row rather than adding it to the totals.",
      "5. Stop folding once `maxRows` valid rows have been folded across all files — do not",
      "   keep reading the remaining files.",
      "6. Write `ledger.md` with one line per region and its total, and `rejects.md` listing",
      "   every rejected row id with the reason.",
      "7. Return the number of rows folded, the number rejected, and the number of missing",
      "   regions.",
    ].join("\n"),
  },
  {
    id: "doc-freshness",
    covers: ["loop", "condition", "try", "parallel", "early-return", "function"],
    targetLines: 110,
    expect: {
      files: [{ path: "freshness.md", contains: ["orders"], minBytes: 20 }],
      memory: { minEntities: 1, entityTypes: ["stale-doc"] },
    },
    prompt: [
      "Build the documentation freshness audit.",
      "",
      "The flow's input parameter type must be exactly `{ root: string; maxModules: number }`.",
      "",
      "Requirements:",
      "",
      "1. Search the root directory for TypeScript modules (pattern `*.ts`). If nothing",
      "   matches, write nothing and return `{ audited: 0 }` immediately.",
      "2. Skip any match whose name ends in `.test.ts` — tests are not documented.",
      "3. For each remaining module, up to `maxModules` of them: the module's doc is",
      "   `docs/<basename>.md`. Fetch the module's metadata and the doc's metadata **at the",
      "   same time** with a single `Promise.all` over an array literal, so neither waits",
      "   for the other. A module with no doc at all makes that call throw — catch it and",
      "   record the module as undocumented, then move on to the next module.",
      "4. A doc is stale when its modification time is older than the module's. Decide that",
      "   in a named helper function rather than inline.",
      "5. Every stale doc is recorded in the knowledge graph as an entity whose `entityType`",
      "   is exactly `stale-doc`, named after the doc path, with the module path as an",
      "   observation.",
      "6. Write `freshness.md` listing, per module, whether its doc is fresh, stale or",
      "   missing.",
      "7. Return how many modules were audited, how many docs were stale and how many were",
      "   missing.",
    ].join("\n"),
  },
  {
    id: "memory-index",
    covers: ["loop", "condition", "while-loop", "function", "try"],
    targetLines: 110,
    expect: {
      // `money.ts`, not `orders.ts`: `maxModules` is synthesized as 3 and the
      // brief caps the run at it, so the fourth file alphabetically is one a
      // correct flow never reaches (see GENERATE_AND_RUN_EVAL_VERSION).
      files: [{ path: "index-report.md", contains: ["money.ts"], minBytes: 20 }],
      memory: { minEntities: 3, entityTypes: ["module"], minRelations: 1 },
    },
    prompt: [
      "Build the flow that indexes a repository into the knowledge graph.",
      "",
      "The flow's input parameter type must be exactly `{ root: string; maxModules: number }`.",
      "",
      "Requirements:",
      "",
      "1. Create one entity for the repository itself, named after `input.root`, with",
      "   `entityType` `repository`.",
      "2. Search the root directory for `*.ts` files. For each of them, up to `maxModules`:",
      "   read the file, then record it in the knowledge graph as an entity whose",
      "   `entityType` is exactly `module`, named after the file path, whose observations",
      "   are its line count and the names it exports. Extract the exported names with a",
      "   named helper function rather than inline.",
      "3. Relate every module entity to the repository entity.",
      "4. The memory server is occasionally slow to settle. After the writes, read the whole",
      "   graph back in a retry loop: keep re-reading until the graph reports at least as",
      "   many entities as you wrote, or until you have tried three times. The attempt",
      "   counter must be visible in the loop.",
      "5. Wrap each individual module read so that a file that cannot be read is recorded as",
      "   a failure and the indexing carries on.",
      "6. Write `index-report.md` listing every indexed module path and its line count, plus",
      "   the failures.",
      "7. Return the number of modules indexed, the number that failed, and how many read",
      "   attempts the graph took to settle.",
    ].join("\n"),
  },
  {
    id: "resilient-reader",
    covers: ["loop", "condition", "try", "jump", "early-return"],
    targetLines: 90,
    expect: {
      files: [{ path: "read-report.md", contains: ["missing", "orders.ts"], minBytes: 20 }],
    },
    prompt: [
      "Build the flow that reads a fixed checklist of files and reports which of them are",
      "actually there.",
      "",
      "The flow's input parameter type must be exactly `{ root: string; maxFiles: number }`.",
      "",
      "Requirements:",
      "",
      "1. The checklist is written in the flow itself, in this order:",
      "   `orders.ts`, `docs/session.md`, `money.ts`, `MISSING-ONE.md`, `session.ts`,",
      "   `docs/orders.md`, `nope/deep/other.md`, `index.ts`.",
      "   Four of those do not exist and the filesystem server will throw for each.",
      "2. If the checklist is empty, return `{ read: 0 }` immediately.",
      "3. Read each file in turn. A read that throws is not a reason to stop: record the",
      "   path and the server's message under \"missing\", and `continue` with the next one.",
      "4. A file that reads back empty counts as neither read nor missing — skip it.",
      "5. Stop after `maxFiles` files have been read successfully; do not read the rest.",
      "6. Write `read-report.md` with a `## read` section listing every path that was read",
      "   with its size in characters, and a `## missing` section listing every path that",
      "   was not, each with the reason the server gave.",
      "7. Return the number read, the number missing, and whether the limit cut the run",
      "   short.",
    ].join("\n"),
  },
  {
    id: "parallel-audit",
    covers: ["parallel", "loop", "condition", "function", "try"],
    targetLines: 110,
    expect: {
      files: [{ path: "audit.md", contains: ["money.ts", "reasoning"], minBytes: 40 }],
    },
    prompt: [
      "Build the repository audit our release checklist runs.",
      "",
      "The flow's input parameter type must be exactly `{ root: string; maxModules: number }`.",
      "",
      "Requirements:",
      "",
      "1. Gather three things about the root directory **at the same time**, with a single",
      "   `Promise.all` over an array literal — the directory listing with sizes, the",
      "   recursive directory tree, and the list of directories the server is allowed to",
      "   touch. None of the three may wait for the others.",
      "2. Search for `*.ts` modules. For each of them, up to `maxModules`: fetch its",
      "   metadata, then read it. Grade it in a named helper: `large` when the file is over",
      "   200 bytes, `documented` when its text contains `/**`, `plain` otherwise.",
      "3. A module that cannot be read must be recorded and skipped, not fatal.",
      "4. Then think the audit through in exactly three sequential thoughts using the",
      "   reasoning tool, numbering them 1, 2 and 3 out of 3, and telling the tool after the",
      "   third that no further thought is needed. Collect what it returns.",
      "5. Write `audit.md` containing: the grade of every module, and a `## reasoning`",
      "   section recording that the three thoughts were taken.",
      "6. Return the count per grade and the number of thoughts recorded.",
    ].join("\n"),
  },
  {
    id: "batch-migrate",
    covers: ["loop", "nested-loop", "condition", "try", "jump", "early-return", "function"],
    targetLines: 130,
    expect: {
      // The migrated file itself, not a mention of it: the brief asks the report
      // for counts and failures, so scoring it on a list it never requested was
      // the harness inventing a requirement.
      files: [
        { path: "archive/orders.md", contains: ["migrated"], minBytes: 20 },
        { path: "migration-report.md", minBytes: 20 },
      ],
      memory: { minEntities: 1, entityTypes: ["note"] },
    },
    prompt: [
      "Build the flow that migrates our markdown notes into an archive directory and the",
      "knowledge graph.",
      "",
      "The flow's input parameter type must be exactly",
      "`{ root: string; batchSize: number; maxFailures: number }`.",
      "",
      "Requirements:",
      "",
      "1. Create the destination directory `<root>/archive` before anything is written.",
      "2. Find every `*.md` file under the root directory. If there are none, write an empty",
      "   `migration-report.md` and return immediately.",
      "3. Process the notes in batches of `batchSize`. For each batch, read the whole batch",
      "   in one call, then handle each note in the batch one at a time — so this is a loop",
      "   over batches with a loop over notes inside it.",
      "4. Transform each note with a named helper that prefixes the text with a",
      "   `<!-- migrated -->` line. A note that is empty after transformation is skipped and",
      "   counts as neither a success nor a failure.",
      "5. Write each transformed note to `<root>/archive/<original file name>`.",
      "6. A note that fails to read or write is a failure: record its path and the reason,",
      "   and carry on with the next note. If the number of failures ever exceeds",
      "   `maxFailures`, abandon the migration and stop processing batches immediately.",
      "7. Every successfully migrated note is recorded in the knowledge graph as an entity",
      "   whose `entityType` is exactly `note`, named after the original path, with the",
      "   destination path as an observation.",
      "8. Write `migration-report.md` with the counts and the list of failures, and return",
      "   how many were migrated, skipped and failed, and whether the run was abandoned.",
    ].join("\n"),
  },
  {
    id: "status-digest",
    covers: ["while-loop", "loop", "condition", "try", "early-return"],
    targetLines: 100,
    expect: {
      files: [{ path: "digest.md", contains: ["new york"], minBytes: 30 }],
    },
    prompt: [
      "Build the status digest flow that polls our demo status service.",
      "",
      "The flow's input parameter type must be exactly `{ root: string; maxCycles: number }`.",
      "",
      "Requirements:",
      "",
      "1. If `maxCycles` is less than one, return `{ cycles: 0 }` without writing anything.",
      "2. Poll in a `while` loop with a visible attempt counter that stops at `maxCycles`.",
      "   In each cycle, in this order:",
      "   a. echo a progress message through the demo service so the poll is on record;",
      "   b. ask the demo service for the structured status payload of one location. The",
      "      locations to rotate through are New York, Chicago and Los Angeles, in that",
      "      order — the service only accepts exactly those three spellings and rejects",
      "      anything else;",
      "   c. add the temperature it returns to a running total, and keep the conditions",
      "      string.",
      "3. A cycle whose status call throws must not end the poll: record the failure and let",
      "   the loop go round again.",
      "4. After the loop, ask the demo service to add the number of successful cycles to the",
      "   number of failed cycles, and use what it returns as the total in the report.",
      "5. Write `digest.md` with one line per cycle — the location, the temperature and the",
      "   conditions — plus the totals.",
      "6. Return the number of cycles polled, how many failed, and the average temperature.",
    ].join("\n"),
  },
];

/* -------------------------------------------------------------------------- */
/* running a flow                                                              */
/* -------------------------------------------------------------------------- */

/** The `RunFrame` shapes this suite reads — a structural copy of `runner.ts`. */
export type RunnerFrame =
  | { type: "plan"; workspace: string; probed: string[]; skipped: unknown[]; bindings: { namespace: string; mode: string }[] }
  | { type: "input"; input: unknown }
  | { type: "event"; nodeId: string; phase: string; at: number; durationMs?: number; preview?: unknown; error?: { message: string; stack?: string } }
  | { type: "call"; at: number; tool: string; mode: string; ms: number; ok: boolean; nodeId: string | null; detail?: string }
  | { type: "ready"; namespaces: unknown[] }
  | { type: "done"; status: string; ms?: number; result?: unknown; error?: { message: string; stack?: string } };

export interface RunnerRequest {
  source: string;
  ranges: unknown[];
  tools: { name: string; outputSchema?: unknown }[];
  timeoutMs: number;
  keepScratch: boolean;
}

/** Injected: the runner lives in `apps/demo`, which this package cannot import. */
export interface FlowRunner {
  (request: RunnerRequest, emit: (frame: RunnerFrame) => void): Promise<void>;
}

/** How a run ended, in the terms the report needs. */
export interface RunOutcome {
  status: string;
  ms: number;
  stepsRun: number;
  stepsTotal: number;
  mcpCalls: number;
  mcpCallsOk: number;
  stubCalls: number;
  toolsCalled: string[];
  failedCalls: { tool: string; detail: string }[];
  failedSteps: { nodeId: string; label: string; line: number | null; message: string }[];
  error: { message: string; stack?: string } | null;
  result: unknown;
  workspace: string | null;
  input: unknown;
  effects: EffectReport | null;
  /** `ok` **and** every effect check passed. */
  passed: boolean;
}

export type RuntimeErrorClass =
  | "none"
  | "logic"
  | "tool-schema"
  | "environment"
  | "runner"
  | "no-effect";

/**
 * Which of the four kinds of failure this was — the classification the brief
 * asks for, applied to the evidence rather than to a feeling.
 *
 * The order matters: a run that never started a server is an environment
 * problem no matter what its last step said, and a message coming *out of an
 * MCP server's own argument validation* is the model misreading a schema even
 * when it surfaces as a thrown `Error` like any other.
 */
export function classifyRuntimeError(outcome: RunOutcome): {
  klass: RuntimeErrorClass;
  reason: string;
} {
  if (outcome.status === "ok" && outcome.effects?.ok === true) return { klass: "none", reason: "" };

  // A run that *completed* handled every error it met — several briefs require
  // exactly that, and the failed calls in its log are the ones it was told to
  // survive. So a completed run is judged only on what it left behind, and a
  // completed run that left the wrong thing is a silent logic failure, which is
  // what `no-effect` means. Reading its handled ENOENTs as the diagnosis would
  // blame the model for doing what the brief asked.
  if (outcome.status === "ok") {
    return {
      klass: "no-effect",
      reason: (outcome.effects?.checks ?? [])
        .filter((check) => !check.ok)
        .map((check) => `${check.label}: ${check.detail}`)
        .join("; "),
    };
  }

  const messages = [
    outcome.error?.message ?? "",
    ...outcome.failedCalls.map((call) => call.detail),
    ...outcome.failedSteps.map((step) => step.message),
  ].filter((message) => message.length > 0);
  const all = messages.join(" | ");

  // (d) the runner or CodeFlow itself: the flow never got to run its own logic.
  if (
    /is not in the registry this flow was analyzed against/i.test(all) ||
    /has no tool matching/i.test(all) ||
    /__cf|globalThis\.__cf|run thread exited|Cannot find module|Unexpected token|SyntaxError|Transform failed/i.test(all)
  ) {
    return { klass: "runner", reason: firstMatch(messages, /is not in the registry|has no tool matching|__cf|run thread exited|Cannot find module|Unexpected token|SyntaxError|Transform failed/i) };
  }

  // (c) the environment: a ceiling this harness imposes, or a server that would
  // not start. Not the model's mistake and not CodeFlow's.
  if (outcome.status === "timeout" || /passed its .* ceiling|ECONNREFUSED|spawn npx|MCP error -32001|Connection closed/i.test(all)) {
    return { klass: "environment", reason: outcome.status === "timeout" ? "run hit the wall-clock ceiling" : firstMatch(messages, /ECONNREFUSED|spawn npx|MCP error -32001|Connection closed/i) };
  }

  // (b) the schema: the server itself rejected the arguments, or refused a path.
  if (
    /invalid[_ ]?arguments|invalid arguments for tool|required|expected .* received|must be|not allowed|outside allowed directories|access denied|Invalid enum value|unrecognized_keys|zod/i.test(
      all,
    )
  ) {
    return {
      klass: "tool-schema",
      reason: firstMatch(messages, /invalid[_ ]?arguments|invalid arguments for tool|required|expected .* received|must be|not allowed|outside allowed directories|access denied|Invalid enum value|unrecognized_keys|zod/i),
    };
  }

  // (a) the model's own logic — including the classic "treat `{ content: string }`
  // as an array" and an unguarded ENOENT that ended the run.
  return { klass: "logic", reason: messages[0] ?? "the run did not complete and said nothing about why" };
}

function firstMatch(messages: string[], pattern: RegExp): string {
  return messages.find((message) => pattern.test(message)) ?? messages[0] ?? "";
}

/**
 * Feed the run back to the model.
 *
 * Deliberately only *facts about the execution*: what the server said, which
 * step it happened on, what it got as input, and which of the required effects
 * are not on disk. No advice about how to fix it — if the model needs to be
 * told the answer, the interesting result is that it needed to be told.
 */
export function renderRuntimeFeedback(outcome: RunOutcome, intent: RunIntent): string {
  const lines: string[] = [
    "Your flow was executed for real: a Node worker imported it and called it with",
    "live MCP servers behind `tools` (the official filesystem, memory, everything and",
    "sequential-thinking servers). Here is what happened.",
    "",
    `- status: **${outcome.status}**`,
    `- steps that started: ${String(outcome.stepsRun)} of ${String(outcome.stepsTotal)}`,
    `- MCP calls made: ${String(outcome.mcpCalls)} (${String(outcome.mcpCallsOk)} succeeded)`,
    `- input it was called with: \`${JSON.stringify(outcome.input)}\``,
    "",
  ];

  if (outcome.error !== null) {
    lines.push("The run ended with this error:", "", "```", outcome.error.message.slice(0, 1500), "```", "");
  }

  if (outcome.failedCalls.length > 0) {
    lines.push("Tool calls that failed, with the message the server itself returned:", "");
    for (const call of outcome.failedCalls.slice(0, 10)) {
      lines.push(`- \`tools.${call.tool}\` → ${call.detail.slice(0, 500)}`);
    }
    lines.push("");
  }

  if (outcome.failedSteps.length > 0) {
    lines.push("Steps that failed:", "");
    for (const step of outcome.failedSteps.slice(0, 10)) {
      const where = step.line === null ? "" : ` (line ${String(step.line)})`;
      lines.push(`- ${step.label}${where}: ${step.message.slice(0, 300)}`);
    }
    lines.push("");
  }

  const unmet = (outcome.effects?.checks ?? []).filter((check) => !check.ok);
  if (unmet.length > 0) {
    lines.push(
      "The run was also checked against what the brief asked it to leave behind. These",
      "are not on disk:",
      "",
    );
    for (const check of unmet) lines.push(`- ${check.label} — ${check.detail}`);
    lines.push("");
    if ((outcome.effects?.newFiles.length ?? 0) > 0) {
      lines.push(
        `Files the run did create: ${outcome
          .effects!.newFiles.map((file) => `\`${file.path}\` (${String(file.bytes)} B)`)
          .join(", ")}`,
        "",
      );
    }
  }

  lines.push(
    "Fix the flow so it runs to completion and leaves those results behind. Keep the same",
    `input parameter type, keep following the CodeFlow contract and style guide, and`,
    "answer with the complete corrected flow file and nothing else.",
    "",
    `(For reference, the brief was: ${intent.id}.)`,
  );

  return lines.join("\n");
}

/* -------------------------------------------------------------------------- */
/* one intent, end to end                                                      */
/* -------------------------------------------------------------------------- */

export interface AttemptRecord {
  attempt: number;
  /** `generate` for the first, `runtime-fix` for the ones driven by a real error. */
  kind: "generate" | "runtime-fix";
  source: string;
  lines: number;
  level: ConformanceLevel;
  /** Rounds spent inside the *static* diagnostics loop for this attempt. */
  validateRounds: number;
  diagnostics: Diagnostic[];
  shape: GraphShape | null;
  covered: ExpectedConstruct[];
  missing: ExpectedConstruct[];
  run: RunOutcome;
  errorClass: RuntimeErrorClass;
  errorReason: string;
  modelMs: number;
  usage: ModelUsage | null;
}

export interface GenerateAndRunResult {
  intent: string;
  repetition: number;
  /** Whether `tools.d.ts` carried per-argument documentation for this run. */
  parameterDocs: boolean;
  toolCount: number;
  systemPromptTokens: number;
  targetLines: number;
  covers: ExpectedConstruct[];
  attempts: AttemptRecord[];
  /** Level of the first attempt, before any runtime feedback. */
  firstLevel: ConformanceLevel;
  /** Did the first attempt run clean **and** leave the required effects? */
  firstRunPassed: boolean;
  finalLevel: ConformanceLevel;
  finalRunPassed: boolean;
  /** Static retries, summed over attempts. */
  staticRetries: number;
  runtimeRetries: number;
  totalMs: number;
  error?: string;
}

export interface RunGenerateAndRunOptions {
  cf: CodeFlowModule;
  adapter: McpAdapterModule;
  intent: RunIntent;
  repetition: number;
  config: ModelConfig;
  runFlow: FlowRunner;
  /** Rounds of static diagnostics feedback per attempt. Default 2. */
  maxStaticRetries?: number;
  /** Rounds of *runtime* feedback. Default 2 — the number the brief asks for. */
  maxRuntimeRetries?: number;
  includeExamples?: boolean;
  /**
   * Put each tool argument's own description into `tools.d.ts` (05 §2). The
   * A/B this flag exists for: does the model stop omitting an optional-looking
   * argument the server actually needs?
   */
  parameterDocs?: boolean;
  timeoutMs?: number;
  log?: (message: string) => void;
}

const LEVEL_ORDER: Record<ConformanceLevel, number> = { invalid: 0, L0: 1, L1: 2, L2: 3 };

export function coveredConstructs(graph: WorkflowGraph): ExpectedConstruct[] {
  const found = new Set<ExpectedConstruct>();
  const byType = (type: string): typeof graph.nodes => graph.nodes.filter((node) => node.type === type);
  const loops = byType("loop");
  if (loops.length > 0) found.add("loop");
  if (loops.some((node) => node.data["kind"] === "while")) found.add("while-loop");
  if (byType("try").length > 0) found.add("try");
  if (byType("parallel").length > 0) found.add("parallel");
  if (byType("jump").length > 0) found.add("jump");
  if (byType("function").length > 0) found.add("function");
  if (byType("condition").length > 0) found.add("condition");
  if (byType("output").length > 1) found.add("early-return");
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
  return [...found].sort();
}

/** Drive one flow through the runner and read the result off the frames. */
export async function executeFlow(
  runFlow: FlowRunner,
  request: RunnerRequest,
  graph: WorkflowGraph,
  expectation: Expectation,
): Promise<RunOutcome> {
  const events: Extract<RunnerFrame, { type: "event" }>[] = [];
  const calls: Extract<RunnerFrame, { type: "call" }>[] = [];
  let plan: Extract<RunnerFrame, { type: "plan" }> | null = null;
  let done: Extract<RunnerFrame, { type: "done" }> | null = null;
  let input: unknown = null;

  const startedAt = Date.now();
  await runFlow(request, (frame) => {
    if (frame.type === "plan") plan = frame;
    else if (frame.type === "input") input = frame.input;
    else if (frame.type === "event") events.push(frame);
    else if (frame.type === "call") calls.push(frame);
    else if (frame.type === "done") done = frame;
  });
  const ms = Date.now() - startedAt;

  // `plan`/`done` are assigned inside a callback the compiler cannot follow.
  const planFrame = plan as Extract<RunnerFrame, { type: "plan" }> | null;
  const doneFrame = done as Extract<RunnerFrame, { type: "done" }> | null;

  const started = new Set(events.filter((event) => event.phase === "started").map((event) => event.nodeId));
  const labelOf = (nodeId: string): string => graph.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
  const lineOf = (nodeId: string): number | null =>
    graph.nodes.find((node) => node.id === nodeId)?.source.start.line ?? null;

  const failedSteps = events
    .filter((event) => event.phase === "failed" && event.error !== undefined)
    .map((event) => ({
      nodeId: event.nodeId,
      label: labelOf(event.nodeId),
      line: lineOf(event.nodeId),
      message: event.error?.message ?? "",
    }))
    // The unwinder marks every enclosing step failed too; only the innermost
    // one carries a message worth showing the model.
    .filter((step) => !/^An error (was )?thrown/.test(step.message));

  const workspace = planFrame?.workspace ?? null;
  const effects = workspace === null ? null : checkEffects(workspace, expectation);

  const outcome: RunOutcome = {
    status: doneFrame?.status ?? "?",
    ms,
    stepsRun: started.size,
    stepsTotal: request.ranges.length,
    mcpCalls: calls.filter((call) => call.mode === "mcp").length,
    mcpCallsOk: calls.filter((call) => call.mode === "mcp" && call.ok).length,
    stubCalls: calls.filter((call) => call.mode === "stub").length,
    toolsCalled: [...new Set(calls.map((call) => call.tool))].sort(),
    failedCalls: calls
      .filter((call) => !call.ok)
      .map((call) => ({ tool: call.tool, detail: call.detail ?? "" })),
    failedSteps,
    error: doneFrame?.error ?? null,
    result: doneFrame?.result ?? null,
    workspace,
    input,
    effects,
    passed: (doneFrame?.status ?? "?") === "ok" && effects !== null && effects.ok,
  };
  return outcome;
}

export async function runGenerateAndRun(
  options: RunGenerateAndRunOptions,
): Promise<GenerateAndRunResult> {
  const { cf, intent, config, runFlow } = options;
  const maxStaticRetries = options.maxStaticRetries ?? 2;
  const maxRuntimeRetries = options.maxRuntimeRetries ?? 2;
  const includeExamples = options.includeExamples ?? true;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const log = options.log ?? ((): void => undefined);

  const registry = createRunnableRegistry(cf, options.adapter);
  const session = cf.createCodeFlow({ registry });
  const context = await session.buildGenerationContext({
    includeExamples,
    ...(options.parameterDocs === undefined ? {} : { parameterDocs: options.parameterDocs }),
  });
  const system = cf.renderSystemPrompt(context);
  const bindings = registry.listTools().map((tool) => ({
    name: tool.name,
    ...(tool.outputSchema === undefined ? {} : { outputSchema: tool.outputSchema }),
  }));

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: `${intent.prompt}\n\n## The workspace this flow runs in\n\n${WORKSPACE_BRIEF}` },
  ];

  const attempts: AttemptRecord[] = [];
  const startedAt = Date.now();
  let staticRetries = 0;
  let runtimeRetries = 0;

  for (let attempt = 0; attempt <= maxRuntimeRetries; attempt += 1) {
    /* ---- generate, with the *static* diagnostics loop of 10 §5 ------------ */
    let source = "";
    let level: ConformanceLevel = "invalid";
    let diagnostics: Diagnostic[] = [];
    let validateRounds = 0;
    let modelMs = 0;
    let usage: ModelUsage | null = null;

    for (let round = 0; round <= maxStaticRetries; round += 1) {
      const call = await callModel(messages, config);
      modelMs += call.ms;
      usage = call.usage;
      source = extractFlowSource(call.content);
      const validated = await session.validate(source);
      level = validated.level;
      diagnostics = [...validated.diagnostics];
      validateRounds = round + 1;
      const feedback = cf.renderDiagnosticsFeedback(validated, { target: "L2" });
      log(
        `  [${intent.id}#${String(options.repetition)}] attempt ${String(attempt)} gen round ${String(round)} → ${level} · ${String(source.trimEnd().split("\n").length)} lines · ${String(call.ms)}ms`,
      );
      if (level === "L2" || feedback === null || round === maxStaticRetries) break;
      staticRetries += 1;
      messages.push({ role: "assistant", content: source });
      messages.push({ role: "user", content: feedback });
    }

    /* ---- run it ----------------------------------------------------------- */
    let shape: GraphShape | null = null;
    let covered: ExpectedConstruct[] = [];
    let run: RunOutcome;

    if (level === "invalid") {
      // Nothing to execute: the file does not parse.
      run = {
        status: "not-run",
        ms: 0,
        stepsRun: 0,
        stepsTotal: 0,
        mcpCalls: 0,
        mcpCallsOk: 0,
        stubCalls: 0,
        toolsCalled: [],
        failedCalls: [],
        failedSteps: [],
        error: { message: "The flow did not reach L0, so there was nothing to run." },
        result: null,
        workspace: null,
        input: null,
        effects: null,
        passed: false,
      };
    } else {
      const graph = await session.analyze(source, { file: `${intent.id}.flow.ts` });
      shape = graphShape(graph);
      covered = coveredConstructs(graph);
      const ranges = cfNodeRanges(cf, graph);
      log(`  [${intent.id}#${String(options.repetition)}] running ${String(ranges.length)} steps …`);
      run = await executeFlow(
        runFlow,
        { source, ranges, tools: bindings, timeoutMs, keepScratch: true },
        graph,
        intent.expect,
      );
      log(
        `  [${intent.id}#${String(options.repetition)}] run → ${run.status} · ${String(run.stepsRun)}/${String(run.stepsTotal)} steps · ${String(run.mcpCalls)} MCP calls · effects ${run.effects?.ok === true ? "ok" : "MISSING"} · ${String(run.ms)}ms`,
      );
    }

    const classified = classifyRuntimeError(run);
    attempts.push({
      attempt,
      kind: attempt === 0 ? "generate" : "runtime-fix",
      source,
      lines: source.trimEnd().split("\n").length,
      level,
      validateRounds,
      diagnostics,
      shape,
      covered,
      missing: intent.covers.filter((construct) => !covered.includes(construct)),
      run,
      errorClass: classified.klass,
      errorReason: classified.reason,
      modelMs,
      usage,
    });

    if (run.passed) break;
    if (attempt === maxRuntimeRetries) break;

    runtimeRetries += 1;
    messages.push({ role: "assistant", content: source });
    messages.push({ role: "user", content: renderRuntimeFeedback(run, intent) });
  }

  const first = attempts[0]!;
  const final = attempts[attempts.length - 1]!;
  return {
    intent: intent.id,
    repetition: options.repetition,
    parameterDocs: options.parameterDocs === true,
    toolCount: registry.listTools().length,
    systemPromptTokens: Math.ceil(system.length / 4),
    targetLines: intent.targetLines,
    covers: intent.covers,
    attempts,
    firstLevel: first.level,
    firstRunPassed: first.run.passed,
    finalLevel: final.level,
    finalRunPassed: final.run.passed,
    staticRetries,
    runtimeRetries,
    totalMs: Date.now() - startedAt,
  };
}

/**
 * `nodeRanges` is core's, but the suite receives core as an injected module so
 * it can be the `src` build under vitest and the `dist` build under the runner.
 */
function cfNodeRanges(cf: CodeFlowModule, graph: WorkflowGraph): unknown[] {
  const fn = (cf as unknown as { nodeRanges?: (graph: WorkflowGraph) => unknown[] }).nodeRanges;
  if (typeof fn !== "function") throw new Error("the injected @codeflow-team/core has no nodeRanges export");
  return fn(graph);
}

/* -------------------------------------------------------------------------- */
/* aggregation                                                                 */
/* -------------------------------------------------------------------------- */

export interface RunRates {
  total: number;
  /** Reached L2 on the first attempt. */
  l2First: number;
  /** Ran clean and left the required effects, on the first attempt. */
  ranFirst: number;
  /** **The headline number**: L2 on the first attempt, but did not run. */
  l2ButNotRunnable: number;
  /** Same, as a share of the L2 population. */
  l2ButNotRunnableRate: number;
  /** Passed after at least one round of runtime feedback. */
  fixedByRuntimeFeedback: number;
  /** Still failing after every runtime round. */
  neverRan: number;
}

export function runRates(results: readonly GenerateAndRunResult[]): RunRates {
  const total = results.length;
  const l2First = results.filter((result) => LEVEL_ORDER[result.firstLevel] >= LEVEL_ORDER["L2"]).length;
  const ranFirst = results.filter((result) => result.firstRunPassed).length;
  const l2ButNotRunnable = results.filter(
    (result) => LEVEL_ORDER[result.firstLevel] >= LEVEL_ORDER["L2"] && !result.firstRunPassed,
  ).length;
  const fixedByRuntimeFeedback = results.filter(
    (result) => !result.firstRunPassed && result.finalRunPassed,
  ).length;
  return {
    total,
    l2First,
    ranFirst,
    l2ButNotRunnable,
    l2ButNotRunnableRate: l2First === 0 ? 0 : l2ButNotRunnable / l2First,
    fixedByRuntimeFeedback,
    neverRan: results.filter((result) => !result.finalRunPassed).length,
  };
}

/** Error classes over the first attempt of every result — the "what breaks" table. */
export function errorClassHistogram(
  results: readonly GenerateAndRunResult[],
  which: "first" | "all" = "first",
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const result of results) {
    const attempts = which === "first" ? result.attempts.slice(0, 1) : result.attempts;
    for (const attempt of attempts) {
      counts[attempt.errorClass] = (counts[attempt.errorClass] ?? 0) + 1;
    }
  }
  return counts;
}

/** How far through its steps a flow got, averaged — 0 when nothing ran at all. */
export function stepProgress(results: readonly GenerateAndRunResult[]): {
  attempted: number;
  meanRatio: number;
} {
  const ratios = results
    .map((result) => result.attempts[0]!.run)
    .filter((run) => run.stepsTotal > 0)
    .map((run) => run.stepsRun / run.stepsTotal);
  return {
    attempted: ratios.length,
    meanRatio: ratios.length === 0 ? 0 : ratios.reduce((a, b) => a + b, 0) / ratios.length,
  };
}
