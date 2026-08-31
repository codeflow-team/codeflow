/**
 * One run, from source text to a stream of frames.
 *
 * Transport-free on purpose: the dev server wraps this in SSE, and
 * `scripts/run-examples.mjs` drives the same function straight from a terminal
 * to sweep the whole gallery. A runner that can only be exercised through a
 * browser is a runner nobody checks.
 *
 * ```text
 * source + nodeRanges
 *   → instrument()      markers before and after each statement
 *   → scratch dir       flow.ts + lib.ts, deleted when the run ends
 *   → Worker            node:worker_threads — killable, credential-free
 *   → frames            emitted the instant they arrive, never batched
 * ```
 *
 * ⚠️ Demo runner, **not a sandbox**. The worker has the developer's own
 * permissions; what it does not have is credentials, a network client other
 * than the allow-listed MCP transports, or anywhere to write except a
 * throwaway directory. A production runtime must isolate properly (09 §1).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { instrument, type ProbeRange, type SkippedProbe } from "./instrument.ts";
import { resolveWorkspaceToken, synthesizeInput } from "./input.ts";
import { planFor, stubReason, userPlan, type McpServerPlan, type UserServerSpec } from "./mcp-servers.ts";
import { stdioAllowed, stdioDisabledReason } from "./mcp-discover.ts";
import type { EmitFrame, ToolBinding, WorkerJob } from "./worker.ts";

export const DEFAULT_TIMEOUT_MS = 120_000;
export const MAX_TIMEOUT_MS = 600_000;
export const MAX_PREVIEW_CHARS = 600;
/** A runaway flow can emit events faster than a browser can draw them. */
export const MAX_EVENTS = 20_000;

export interface RunRequest {
  exampleId?: string;
  source: string;
  ranges?: ProbeRange[];
  tools?: ToolBinding[];
  functions?: { name: string; code?: string; modulePath?: string }[];
  input?: unknown;
  timeoutMs?: number;
  /** Leave the scratch directory behind so its files can be shown. */
  keepScratch?: boolean;
  /**
   * Servers the *user* configured in the MCP manager, keyed by nothing — the
   * namespace is on each spec. Consulted only for a namespace the built-in
   * allowlist does not claim, so adding a server can never redirect `fs` or
   * `memory` somewhere else.
   */
  servers?: UserServerSpec[];
}

export interface BindingReport {
  namespace: string;
  mode: "mcp" | "stub";
  server?: string;
  safety?: string;
  reason?: string;
}

export type RunFrame =
  | {
      type: "plan";
      runId: string;
      scratch: string;
      workspace: string;
      probed: string[];
      skipped: SkippedProbe[];
      droppedImports: string[];
      bindings: BindingReport[];
      timeoutMs: number;
      libraryFunctions: string[];
      /** Loops this run can number the passes of — see `instrument()`. */
      counted: string[];
      /** Steps that make an iteration number a guess, so none is sent inside them. */
      uncounted: string[];
      /** True when nothing in this run may carry an iteration at all. */
      blind: boolean;
      note: string;
    }
  | { type: "input"; input: unknown }
  | { type: "event"; nodeId: string; phase: string; at: number; durationMs?: number; preview?: unknown; error?: { message: string; stack?: string }; iteration?: number[] }
  | EmitFrame
  | { type: "ready"; namespaces: { namespace: string; mode: string; server?: string; tools?: number }[] }
  | { type: "done"; status: "ok" | "failed" | "timeout" | "cancelled"; ms?: number; result?: unknown; error?: { message: string; stack?: string } };

export interface RunHandle {
  runId: string;
  /** Stop the worker and remove the scratch directory. Idempotent. */
  cancel: () => void;
  /** Resolves once the final frame has been emitted. Never rejects. */
  finished: Promise<void>;
}

/**
 * One library function's source, guaranteed to be exported.
 *
 * The obvious version of this was `code.startsWith("export ") ? code : "export
 * " + code`, and it is wrong for the most natural thing anyone writing a
 * library function does — open it with a doc comment. Both halves fail on it:
 *
 *  - `/** … *\/ export function f()` does not *start with* `export`, so one is
 *    prepended and the result is `export /** … *\/ export function`;
 *  - `/** … *\/ function f()` genuinely needs the keyword, but prepending it at
 *    offset 0 puts it in front of the comment, where it modifies nothing.
 *
 * Either way `lib.ts` stops parsing — and it is one file for the whole
 * registry, so a single doc comment stops *every* flow in that registry at its
 * first step, with a syntax error nobody wrote. (Found for real; the author's
 * workaround was to keep doc blocks inside function bodies, which is a tax on
 * writing the comment rather than a fix.)
 *
 * So leading whitespace and comments are skipped, the question is asked of the
 * first *token*, and the keyword goes exactly where a person would have typed
 * it — after the comment, in front of the declaration it applies to.
 */
export function exported(code: string): string {
  let at = 0;
  for (;;) {
    while (at < code.length && /\s/.test(code[at])) at++;
    if (code.startsWith("//", at)) {
      const line = code.indexOf("\n", at);
      if (line === -1) return code; // nothing but a comment — nothing to export
      at = line + 1;
      continue;
    }
    if (code.startsWith("/*", at)) {
      const end = code.indexOf("*/", at + 2);
      if (end === -1) return code; // unterminated — not this runner's to repair
      at = end + 2;
      continue;
    }
    break;
  }
  // `\b` rather than a trailing space: `export{f}` and `export\nfunction` are
  // both already exported, and neither has a space after the keyword.
  if (/^export\b/.test(code.slice(at))) return code;
  return `${code.slice(0, at)}export ${code.slice(at)}`;
}

/**
 * Write the module the worker imports.
 *
 * `@flows/lib` is a real import in the flow's own text (05 §4) and the library
 * functions are real code the registry carries, so they are written next to the
 * flow and the import is repointed at them — they run for real. Every other
 * import is blanked by `instrument()`: `../generated/tools` is a `.d.ts` that
 * only exists at author time.
 */
function writeModule(
  scratch: string,
  source: string,
  ranges: ProbeRange[],
  functions: { name: string; code?: string }[],
): ReturnType<typeof instrument> & { entry: string } {
  const result = instrument(source, ranges, { rewriteImports: { "@flows/lib": "./lib.ts" } });

  const bodies = functions
    .map((fn) => fn.code?.trim())
    .filter((code): code is string => code !== undefined && code.length > 0)
    .map(exported);
  writeFileSync(
    join(scratch, "lib.ts"),
    `/* Library functions, from the registry (05 §4). Real code, really run. */\n${bodies.join("\n\n")}\n`,
    "utf8",
  );

  const entry = join(scratch, "flow.ts");
  writeFileSync(entry, result.code, "utf8");
  return { ...result, entry };
}

/**
 * A tiny, believable project for a flow to work on.
 *
 * A filesystem MCP server rooted at an empty directory makes every flow in the
 * gallery stop at its first step with "no files found", which demonstrates
 * nothing. So the scratch directory starts as a small source tree — a couple of
 * modules, a test, a doc, a stale doc — chosen so the real flows have something
 * true to say about it: `doc-freshness-audit` finds a doc older than the module
 * it documents, `memory-graph-sync` finds modules to turn into entities.
 *
 * All of it is created fresh per run and deleted with the run.
 */
export function seedWorkspace(workspace: string): void {
  const files: Record<string, string> = {
    "README.md": "# Demo workspace\n\nCreated for one CodeFlow run, and deleted after it.\n",
    // Scoped dependency names on their own lines: the flows that read a
    // manifest look for `@` per line rather than parsing JSON, which is what a
    // real flow written against a `requirements`-style file does.
    "package.json": JSON.stringify(
      {
        name: "demo-workspace",
        version: "1.0.0",
        type: "module",
        dependencies: {
          "@modelcontextprotocol/sdk": "^1.30.0",
          "@codeflow/core": "^0.1.0",
          zod: "^3.24.1",
        },
      },
      null,
      2,
    ),
    // Flat, not nested under `src/`: the real filesystem server matches
    // `search_files` patterns against the file *name*, so a flow that asks for
    // `*.ts` — as several of these do — has to be able to find something.
    "index.ts":
      "export { parseOrder } from './orders.ts';\nexport { formatMoney } from './money.ts';\n\nexport const VERSION = '1.0.0';\n",
    "orders.ts":
      "export interface Order { id: string; total: number; }\n\n/** Parse an order coming off the queue. */\nexport function parseOrder(raw: string): Order {\n  const parsed = JSON.parse(raw) as Order;\n  if (typeof parsed.id !== 'string') throw new Error('order has no id');\n  return parsed;\n}\n",
    "money.ts":
      "export function formatMoney(cents: number): string {\n  return `$${(cents / 100).toFixed(2)}`;\n}\n",
    "session.ts":
      "/** Auth: whether a session issued at `issuedAt` has aged out. */\nexport function isExpired(issuedAt: number, ttlMs: number): boolean {\n  return Date.now() - issuedAt > ttlMs;\n}\n",
    "orders.test.ts":
      "import { parseOrder } from './orders.ts';\n\nit('parses', () => { parseOrder('{\"id\":\"a\",\"total\":1}'); });\n",
    "docs/orders.md": "# Orders\n\nHow an order moves through the system.\n",
    "docs/money.md": "# Money\n\nEverything is cents.\n",
    "CHANGELOG.md": "# Changelog\n\n## 1.0.0\n- first cut\n",
    // A drop folder of delimited data, because several flows in the gallery are
    // about folding one. An empty inbox makes them return `empty-inbox` on
    // their second step, which demonstrates the early return and nothing else.
    "drop-east.csv":
      "id,region,amount\nE-1,east,1200.50\nE-2,east,880\nE-3,east,not-a-number\nE-4,,410.25\n",
    "drop-west.csv":
      "id,region,amount\nW-1,west,2200\nW-2,central,145.75\nW-3,west,90.10\n",
    /*
     * Two JSON documents, for the flows built out of the `common` registry.
     *
     * Both are shaped so the flow has something true to say rather than
     * something empty: `orders.json` has two customers with more than one paid
     * order, so a group-and-total has groups; `tickets.json` repeats `T-1` so
     * Remove Duplicates removes something, and gives `T-3` a timestamp that is
     * not a date so the "could not read this one" branch is a branch that
     * actually runs. Without these the flows read an empty file and honestly
     * return `unreadable`, which demonstrates the honesty and nothing else.
     */
    "orders.json": JSON.stringify(
      {
        orders: [
          { id: "A-1", customer: "Acme", status: "paid", total: 1200 },
          { id: "A-2", customer: "Beta", status: "open", total: 300 },
          { id: "A-3", customer: "Acme", status: "paid", total: 450 },
          { id: "A-4", customer: "Gamma", status: "paid", total: 450 },
        ],
      },
      null,
      2,
    ),
    "tickets.json": JSON.stringify(
      {
        tickets: [
          {
            id: "T-1",
            customer: "Acme",
            plan: "enterprise",
            openedAt: "2026-01-30T08:00:00Z",
            body: "Checkout times out on card payment.",
          },
          // Deliberately the same ticket twice — Remove Duplicates has to have
          // a duplicate to remove, or the step proves nothing.
          {
            id: "T-1",
            customer: "Acme",
            plan: "enterprise",
            openedAt: "2026-01-30T08:00:00Z",
            body: "Checkout times out on card payment.",
          },
          {
            id: "T-2",
            customer: "Beta",
            plan: "free",
            openedAt: "2026-01-29T08:00:00Z",
            body: "Search is slow above 10k rows.",
          },
          {
            id: "T-3",
            customer: "Gamma",
            plan: "team",
            openedAt: "not a date",
            body: "Bad timestamp, exercises the skip branch.",
          },
        ],
      },
      null,
      2,
    ),
  };

  for (const [relative, contents] of Object.entries(files)) {
    const full = join(workspace, relative);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }

  // One doc deliberately older than the module it documents, so a freshness
  // audit has something real to find rather than a manufactured nothing.
  const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  utimesSync(join(workspace, "docs/orders.md"), old, old);
}

/**
 * Make every file path in `input` exist.
 *
 * A flow that is handed `ledgerPath` usually writes it — and often reads it
 * first, to append. `data-pipeline` does exactly that, and stopped 32 steps in
 * with `ENOENT` on a file whose whole purpose was to be created. An empty file
 * is the honest starting state for "the ledger from last time", so any path the
 * input points at inside the workspace is created if it is not there.
 *
 * Scoped to the workspace: a path outside it is not this runner's to touch, and
 * the filesystem server would refuse it anyway.
 */
function ensureInputFiles(input: unknown, workspace: string): void {
  if (typeof input !== "object" || input === null) return;
  for (const value of Object.values(input as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    if (!value.startsWith(`${workspace}/`)) continue;
    if (!/\.[a-z0-9]+$/i.test(value)) continue;
    if (existsSync(value)) continue;
    mkdirSync(dirname(value), { recursive: true });
    writeFileSync(value, "", "utf8");
  }
}

/**
 * Start a run. `emit` is called synchronously for every frame — do not buffer
 * it: the whole point is that a viewer sees each step light up as it happens.
 */
export function startRun(request: RunRequest, workerEntry: string, emit: (frame: RunFrame) => void): RunHandle {
  const runId = `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const ranges = request.ranges ?? [];
  const tools = request.tools ?? [];
  const functions = request.functions ?? [];
  const timeoutMs = Math.min(Math.max(request.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000), MAX_TIMEOUT_MS);

  let settle: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => { settle = resolve; });

  // realpath, because on macOS `tmpdir()` is a symlink (/var → /private/var) and
  // the filesystem MCP server answers with resolved paths. A flow that joins or
  // strips its own root against what the server returns then builds a path that
  // does not exist — a live run hit exactly that.
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "codeflow-run-")));
  const workspace = join(scratch, "workspace");
  seedWorkspace(workspace);

  let worker: Worker | null = null;
  let timer: NodeJS.Timeout | null = null;
  let over = false;
  let events = 0;

  const stop = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    const dying = worker;
    worker = null;
    const sweep = (): void => {
      if (request.keepScratch !== true) rmSync(scratch, { recursive: true, force: true });
    };
    if (dying === null) { sweep(); return; }
    void dying.terminate().then(sweep, sweep);
  };

  const done = (frame: Extract<RunFrame, { type: "done" }>): void => {
    if (over) return;
    over = true;
    emit(frame);
    stop();
    settle();
  };

  try {
    const built = writeModule(scratch, request.source, ranges, functions);

    const namespaces = [...new Set(tools.map((tool) => tool.name.split(".")[0]).filter((ns) => ns.length > 0))];
    const userServers = new Map((request.servers ?? []).map((spec) => [spec.namespace, spec]));
    const servers: Record<string, McpServerPlan> = {};
    const bindings: BindingReport[] = namespaces.map((namespace) => {
      // The allowlist wins. A namespace it claims is a namespace whose safety
      // this file vouches for, and a user-added server must not be able to take
      // `fs` over and be started with the same "harmless on a laptop" badge.
      const plan = planFor(namespace);
      if (plan !== undefined) {
        servers[namespace] = plan;
        return { namespace, mode: "mcp", server: plan.server, safety: plan.safety };
      }

      const spec = userServers.get(namespace);
      if (spec === undefined) return { namespace, mode: "stub", reason: stubReason(namespace) };
      if (spec.transport === "stdio" && !stdioAllowed()) {
        return { namespace, mode: "stub", reason: stdioDisabledReason() };
      }
      const user = userPlan(spec);
      servers[namespace] = user;
      return { namespace, mode: "mcp", server: user.server, safety: user.safety };
    });

    emit({
      type: "plan",
      runId,
      scratch,
      workspace,
      probed: built.probed,
      skipped: built.skipped,
      droppedImports: built.droppedImports,
      bindings,
      timeoutMs,
      libraryFunctions: functions.map((fn) => fn.name),
      counted: built.counted,
      uncounted: built.uncounted,
      blind: built.blind,
      note: "Demo runner — a worker thread on the dev server, not a production sandbox (09 §1).",
    });

    // A caller-supplied input was written before this run existed, so it can
    // only name the scratch directory by the token (see `WORKSPACE_TOKEN`).
    // Expanding it here is what makes an input the browser remembered from
    // yesterday point at today's folder instead of a deleted one.
    const input =
      request.input === undefined
        ? synthesizeInput(request.source, { scratch: workspace })
        : resolveWorkspaceToken(request.input, workspace);
    ensureInputFiles(input, workspace);

    const job: WorkerJob = {
      entry: pathToFileURL(built.entry).href,
      input,
      tools,
      servers,
      scratch: workspace,
      maxPreviewChars: MAX_PREVIEW_CHARS,
    };
    emit({ type: "input", input: job.input });

    worker = new Worker(workerEntry, { workerData: job, stdout: true, stderr: true });
    timer = setTimeout(() => {
      done({
        type: "done",
        status: "timeout",
        ms: timeoutMs,
        error: { message: `The run passed its ${String(Math.round(timeoutMs / 1000))}s ceiling and was stopped.` },
      });
    }, timeoutMs);

    worker.on("message", (message: RunFrame) => {
      if (over) return;
      if (message.type === "event") {
        events += 1;
        if (events > MAX_EVENTS) {
          done({
            type: "done",
            status: "failed",
            error: { message: `This run produced more than ${String(MAX_EVENTS)} trace events and was stopped.` },
          });
          return;
        }
      }
      if (message.type === "done") { done(message); return; }
      emit(message);
    });

    worker.on("error", (error: Error) => {
      done({ type: "done", status: "failed", error: { message: error.message, stack: error.stack } });
    });

    worker.on("exit", (code) => {
      done(
        code === 0
          ? { type: "done", status: "ok" }
          : { type: "done", status: "failed", error: { message: `The run thread exited with code ${String(code)}.` } },
      );
    });
  } catch (cause) {
    done({
      type: "done",
      status: "failed",
      error: { message: cause instanceof Error ? cause.message : String(cause) },
    });
  }

  return {
    runId,
    cancel: () => {
      done({ type: "done", status: "cancelled" });
    },
    finished,
  };
}
