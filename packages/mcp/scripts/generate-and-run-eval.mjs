#!/usr/bin/env node
/**
 * The **generate → validate → run** eval — 10-ai-codegen.md §5 plus execution.
 *
 *   pnpm build                                                   # the suite runs against dist
 *   node packages/mcp/scripts/generate-and-run-eval.mjs
 *   node packages/mcp/scripts/generate-and-run-eval.mjs --intent csv-ledger --repeat 2
 *   node packages/mcp/scripts/generate-and-run-eval.mjs --dry    # sizing only, no tokens
 *   node packages/mcp/scripts/generate-and-run-eval.mjs --merge a.json,b.json --label all
 *
 * Every other eval in this repo stops at the conformance ladder. This one takes
 * what the model wrote, hands it to `apps/demo/server/runner.ts`, and starts the
 * four real MCP servers behind it. Then it looks on disk.
 *
 * Writes `generate-and-run-<stamp><label>.{json,md}` under
 * `packages/core/test/ai/results/`.
 *
 * Never a CI gate: network, a non-deterministic model, four `npx` servers.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const RESULTS_DIR = join(REPO_ROOT, "packages", "core", "test", "ai", "results");
const WORKER = join(REPO_ROOT, "apps", "demo", "server", "worker.ts");

function loadDotEnv(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function parseArgs(argv) {
  const args = {
    intents: [],
    repeat: 2,
    staticRetries: 2,
    runtimeRetries: 2,
    label: "",
    noExamples: false,
    parameterDocs: false,
    maxTokens: 32000,
    timeoutMs: 120000,
    dry: false,
    merge: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--intent") args.intents.push(argv[++i]);
    else if (arg === "--repeat") args.repeat = Number(argv[++i]);
    else if (arg === "--static-retries") args.staticRetries = Number(argv[++i]);
    else if (arg === "--runtime-retries") args.runtimeRetries = Number(argv[++i]);
    else if (arg === "--label") args.label = argv[++i];
    else if (arg === "--max-tokens") args.maxTokens = Number(argv[++i]);
    else if (arg === "--timeout") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--no-examples") args.noExamples = true;
    else if (arg === "--param-docs") args.parameterDocs = true;
    else if (arg === "--dry") args.dry = true;
    else if (arg === "--merge") args.merge = argv[++i].split(",");
  }
  return args;
}

const pct = (n, total) => (total === 0 ? "—" : `${((n / total) * 100).toFixed(0)}%`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotenv = loadDotEnv(join(REPO_ROOT, ".env"));
  const apiKey = process.env.OPENROUTER_API_KEY ?? dotenv.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL ?? dotenv.OPENROUTER_MODEL ?? "stealth/ox-alpha";
  if (!apiKey && !args.dry && args.merge === null) {
    console.error("OPENROUTER_API_KEY is not set (env or .env).");
    process.exit(1);
  }

  const cf = await import("@codeflow/core");
  const adapter = await import("../dist/index.js");
  const suite = await import("../test/ai/generate-and-run-suite.ts");

  if (args.merge !== null) {
    const shards = args.merge.map((path) =>
      JSON.parse(readFileSync(path.startsWith("/") ? path : join(RESULTS_DIR, path), "utf8")),
    );
    report(suite, shards.flatMap((shard) => shard.results), {
      model,
      maxTokens: shards[0]?.maxTokens ?? args.maxTokens,
      runtimeRetries: shards[0]?.runtimeRetries ?? args.runtimeRetries,
      includeExamples: shards[0]?.includeExamples ?? !args.noExamples,
      label: args.label,
      mergedFrom: args.merge,
    });
    return;
  }

  const selected =
    args.intents.length > 0
      ? suite.RUN_INTENTS.filter((intent) => args.intents.includes(intent.id))
      : suite.RUN_INTENTS;
  if (selected.length === 0) {
    console.error(`No intent matched. Known: ${suite.RUN_INTENTS.map((i) => i.id).join(", ")}`);
    process.exit(1);
  }

  const registry = suite.createRunnableRegistry(cf, adapter);
  const session = cf.createCodeFlow({ registry });
  const context = await session.buildGenerationContext({
    includeExamples: !args.noExamples,
    parameterDocs: args.parameterDocs,
  });
  const prompt = cf.renderSystemPrompt(context);
  console.error(
    `runnable registry: ${registry.listTools().length} tools across ` +
      `${suite.RUNNABLE_SERVERS.map((s) => s.namespace).join(", ")} — ` +
      `system prompt ≈ ${Math.ceil(prompt.length / 4)} tokens`,
  );
  for (const intent of selected) {
    console.error(`  ${intent.id}: target ${intent.targetLines} lines, covers ${intent.covers.join("/")}`);
  }
  if (args.dry) return;

  // `startRun` is transport-free by design, so the eval drives exactly the code
  // path the endpoint drives — no browser, no dev server.
  const { startRun } = await import(new URL("../../../apps/demo/server/runner.ts", import.meta.url).href);

  /** Scratch directories kept alive long enough for the effect check. */
  const kept = [];
  const runFlow = async (request, emit) => {
    const handle = startRun(
      {
        source: request.source,
        ranges: request.ranges,
        tools: request.tools,
        functions: [],
        timeoutMs: request.timeoutMs,
        keepScratch: request.keepScratch,
      },
      WORKER,
      (frame) => {
        if (frame.type === "plan") kept.push(frame.scratch);
        emit(frame);
      },
    );
    await handle.finished;
  };

  const checkpointPath = join(RESULTS_DIR, `checkpoint-${args.label ? `${args.label}-` : ""}generate-and-run.json`);
  const results = [];

  for (let repetition = 1; repetition <= args.repeat; repetition += 1) {
    for (const intent of selected) {
      const began = Date.now();
      console.error(`\n=== ${intent.id} · repetition ${repetition}/${args.repeat} ===`);
      try {
        results.push(
          await suite.runGenerateAndRun({
            cf,
            adapter,
            intent,
            repetition,
            config: { apiKey, model, maxTokens: args.maxTokens, log: (m) => console.error(m) },
            runFlow,
            maxStaticRetries: args.staticRetries,
            maxRuntimeRetries: args.runtimeRetries,
            includeExamples: !args.noExamples,
            parameterDocs: args.parameterDocs,
            timeoutMs: args.timeoutMs,
            log: (m) => console.error(m),
          }),
        );
      } catch (error) {
        console.error(`  [${intent.id}] FAILED: ${error.message}`);
        results.push({
          intent: intent.id,
          repetition,
          parameterDocs: args.parameterDocs,
          toolCount: registry.listTools().length,
          systemPromptTokens: 0,
          targetLines: intent.targetLines,
          covers: intent.covers,
          attempts: [],
          firstLevel: "invalid",
          firstRunPassed: false,
          finalLevel: "invalid",
          finalRunPassed: false,
          staticRetries: 0,
          runtimeRetries: 0,
          totalMs: Date.now() - began,
          error: error.message,
        });
      }
      // The effect check has already read what it needed off disk.
      for (const scratch of kept.splice(0)) rmSync(scratch, { recursive: true, force: true });
      mkdirSync(RESULTS_DIR, { recursive: true });
      writeFileSync(checkpointPath, `${JSON.stringify({ results }, null, 2)}\n`);
    }
  }

  report(suite, results, {
    model,
    maxTokens: args.maxTokens,
    runtimeRetries: args.runtimeRetries,
    includeExamples: !args.noExamples,
    parameterDocs: args.parameterDocs,
    label: args.label,
  });
  rmSync(checkpointPath, { force: true });
}

function report(suite, results, meta) {
  const rates = suite.runRates(results);
  const firstClasses = suite.errorClassHistogram(results, "first");
  const allClasses = suite.errorClassHistogram(results, "all");
  const progress = suite.stepProgress(results);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = meta.label ? `-${meta.label}` : "";
  mkdirSync(RESULTS_DIR, { recursive: true });

  const payload = {
    kind: "generate-and-run",
    evalVersion: suite.GENERATE_AND_RUN_EVAL_VERSION,
    model: meta.model,
    maxTokens: meta.maxTokens,
    runtimeRetries: meta.runtimeRetries,
    includeExamples: meta.includeExamples,
    parameterDocs: meta.parameterDocs === true,
    ...(meta.mergedFrom === undefined ? {} : { mergedFrom: meta.mergedFrom }),
    ranAt: new Date().toISOString(),
    rates,
    errorClassesFirstAttempt: firstClasses,
    errorClassesAllAttempts: allClasses,
    stepProgress: progress,
    results,
  };
  const jsonPath = join(RESULTS_DIR, `generate-and-run-${stamp}${suffix}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  const yesNo = (value) => (value ? "yes" : "**no**");
  const lines = [
    `# Generate → validate → run — ${meta.model}`,
    "",
    "Every flow here was generated by the model, scored on the L0/L1/L2 ladder, and then",
    "**executed** by `apps/demo/server/runner.ts` against the four MCP servers the runner",
    "really starts (filesystem, memory, everything, sequential-thinking). The effects were",
    "then read back off disk. Eval version " +
      `${suite.GENERATE_AND_RUN_EVAL_VERSION}, \`max_tokens\` ${meta.maxTokens}, ` +
      `up to ${meta.runtimeRetries} rounds of runtime feedback, ` +
      `few-shot examples ${meta.includeExamples ? "on" : "**off**"}, ` +
      `per-argument docs in \`tools.d.ts\` ${meta.parameterDocs === true ? "**on**" : "off"}.`,
    "",
    `Ran ${payload.ranAt} · ${rates.total} sequences.`,
    "",
    "## The headline",
    "",
    "| Measure | Count | Share |",
    "| --- | --- | --- |",
    `| Reached L2 first time | ${rates.l2First}/${rates.total} | ${pct(rates.l2First, rates.total)} |`,
    `| Ran clean **and** left the required effects, first time | ${rates.ranFirst}/${rates.total} | ${pct(rates.ranFirst, rates.total)} |`,
    `| **L2 but did not run** | ${rates.l2ButNotRunnable}/${rates.l2First} of the L2 population | ${pct(rates.l2ButNotRunnable, rates.l2First)} |`,
    `| Fixed by feeding the runtime error back | ${rates.fixedByRuntimeFeedback} | — |`,
    `| Still not running after every round | ${rates.neverRan}/${rates.total} | ${pct(rates.neverRan, rates.total)} |`,
    "",
    `Mean share of steps that started, on the first attempt: ${(progress.meanRatio * 100).toFixed(0)}%.`,
    "",
    "## Per sequence",
    "",
    "| intent | rep | level | static retries | steps run/total | MCP calls | real effect | runtime error | fixed after feedback |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map((result) => {
      const first = result.attempts[0];
      const run = first?.run;
      const fixed = result.firstRunPassed
        ? "n/a"
        : result.finalRunPassed
          ? `yes (round ${result.attempts.length - 1})`
          : "**no**";
      return (
        `| ${result.intent} | ${result.repetition} | ${result.firstLevel} | ${result.staticRetries} | ` +
        `${run ? `${run.stepsRun}/${run.stepsTotal}` : "—"} | ${run ? run.mcpCalls : "—"} | ` +
        `${run ? yesNo(run.effects?.ok === true) : "—"} | ${first ? first.errorClass : "—"} | ${fixed} |`
      );
    }),
    "",
    "## Runtime error classes",
    "",
    "`logic` = the model's own reasoning; `tool-schema` = the MCP server rejected the",
    "arguments; `environment` = a ceiling of this harness; `runner` = CodeFlow or the",
    "runner itself; `no-effect` = it ran clean and left nothing behind.",
    "",
    "| class | first attempts | all attempts |",
    "| --- | --- | --- |",
    ...[...new Set([...Object.keys(firstClasses), ...Object.keys(allClasses)])]
      .sort()
      .map((key) => `| ${key} | ${firstClasses[key] ?? 0} | ${allClasses[key] ?? 0} |`),
    "",
  ];

  for (const result of results) {
    lines.push(`## ${result.intent} · repetition ${result.repetition}`, "");
    if (result.error) {
      lines.push("```", result.error, "```", "");
      continue;
    }
    for (const attempt of result.attempts) {
      const run = attempt.run;
      lines.push(
        `### attempt ${attempt.attempt} (${attempt.kind}) → ${attempt.level} · ${attempt.lines} lines · ` +
          `${attempt.shape ? attempt.shape.nodes : 0} nodes · run ${run.status} ` +
          `${run.stepsRun}/${run.stepsTotal} steps · ${run.mcpCalls} MCP calls (${run.mcpCallsOk} ok)`,
        "",
        `Constructs covered: ${attempt.covered.join(", ") || "—"}` +
          (attempt.missing.length > 0 ? ` · **missing: ${attempt.missing.join(", ")}**` : ""),
        "",
        `Tools actually called at runtime: ${run.toolsCalled.map((t) => `\`${t}\``).join(", ") || "—"}`,
        "",
      );
      if (attempt.diagnostics.length > 0) {
        lines.push("Static diagnostics on the final source of this attempt:", "");
        for (const d of attempt.diagnostics.slice(0, 20)) {
          lines.push(`- \`${d.severity}/${d.code}\`${d.source ? ` (line ${d.source.start.line})` : ""} ${d.message}`);
        }
        lines.push("");
      }
      if (run.error) lines.push("Run error:", "", "```", String(run.error.message).slice(0, 1200), "```", "");
      if (run.failedCalls.length > 0) {
        lines.push("Failed MCP calls:", "");
        for (const call of run.failedCalls.slice(0, 12)) {
          lines.push(`- \`tools.${call.tool}\` → ${String(call.detail).slice(0, 400)}`);
        }
        lines.push("");
      }
      if (run.effects) {
        lines.push("Effect checks:", "");
        for (const check of run.effects.checks) {
          lines.push(`- ${check.ok ? "✅" : "❌"} ${check.label} — ${check.detail}`);
        }
        lines.push(
          "",
          `New files left behind: ${
            run.effects.newFiles.map((f) => `\`${f.path}\` (${f.bytes} B)`).join(", ") || "—"
          } · memory entities ${run.effects.memoryEntities} · relations ${run.effects.memoryRelations}`,
          "",
        );
        for (const item of run.effects.evidence) {
          lines.push(`Evidence — \`${item.path}\` (${item.bytes} B):`, "", "```", item.head.trimEnd(), "```", "");
        }
      }
      lines.push(`Classified as: **${attempt.errorClass}**${attempt.errorReason ? ` — ${attempt.errorReason.slice(0, 300)}` : ""}`, "");
      lines.push("```ts", attempt.source.trimEnd(), "```", "");
    }
  }

  const mdPath = join(RESULTS_DIR, `generate-and-run-summary${suffix}.md`);
  writeFileSync(mdPath, `${lines.join("\n")}\n`);

  console.error(
    `\nL2 first ${rates.l2First}/${rates.total} · ran first ${rates.ranFirst}/${rates.total} · ` +
      `L2-but-not-runnable ${rates.l2ButNotRunnable}/${rates.l2First} · ` +
      `fixed by runtime feedback ${rates.fixedByRuntimeFeedback}`,
  );
  console.error(`→ ${jsonPath}\n→ ${mdPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
