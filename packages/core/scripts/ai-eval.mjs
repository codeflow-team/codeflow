#!/usr/bin/env node
/**
 * AI conformance eval runner — 11-testing.md §3.6.
 *
 *   pnpm --filter @codeflow-team/core build   # the script runs against dist
 *   node scripts/ai-eval.mjs             # all six intents
 *   node scripts/ai-eval.mjs --intent bounded-retry --repeat 3
 *
 * Reads `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` from the repo-root `.env`
 * (parsed here — no dotenv dependency) or from the environment. Writes one JSON
 * file per run plus a `summary.md` under `test/ai/results/`, so a later run can
 * be compared against an earlier one: the point of this layer is the *trend* of
 * the conformance rate, not a single verdict (11 §4).
 *
 * Never a CI gate: it needs the network and a non-deterministic model.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const RESULTS_DIR = join(PACKAGE_ROOT, "test", "ai", "results");

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
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

function parseArgs(argv) {
  const args = {
    intents: [],
    repeat: 1,
    maxRetries: 2,
    target: "L1",
    examples: true,
    label: "",
    from: "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--intent") args.intents.push(argv[(i += 1)]);
    else if (arg === "--repeat") args.repeat = Number(argv[(i += 1)]);
    else if (arg === "--max-retries") args.maxRetries = Number(argv[(i += 1)]);
    else if (arg === "--target") args.target = argv[(i += 1)];
    else if (arg === "--no-examples") args.examples = false;
    // Name the summary file, so an ablation run does not overwrite the baseline.
    else if (arg === "--label") args.label = argv[(i += 1)];
    // Re-render the summary of a finished run instead of calling the model.
    else if (arg === "--from") args.from = argv[(i += 1)];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function summaryTable(results) {
  return [
    "| intent | covers | first | final | retries |",
    "| --- | --- | --- | --- | --- |",
    ...results.map(
      (result) =>
        `| ${result.intent} | ${result.covers.join(", ")} | ${result.firstLevel} | ${result.finalLevel} | ${result.retries} |`,
    ),
  ];
}

/**
 * The human-readable half of a run. Kept as a pure function of the run record so
 * `--from run-x.json` can re-render an old run with a newer report format.
 */
function renderSummary(run) {
  const { rates, results, options } = run;
  const pct = (value) => `${((value / rates.total) * 100).toFixed(0)}%`;
  const lines = [
    `# AI conformance eval — ${new Date().toISOString()}`,
    "",
    `- model: \`${run.model}\``,
    `- registry version: ${run.registryVersion}`,
    `- runs: ${rates.total} (max ${options.maxRetries} retries, target ${options.target}, examples ${options.examples ? "on" : "off"})`,
    ...(run.durationSeconds === undefined ? [] : [`- duration: ${run.durationSeconds.toFixed(0)}s`]),
    "",
    "## Conformance (final level)",
    "",
    "| level | runs | rate |",
    "| --- | --- | --- |",
    `| L0 or better | ${rates.l0}/${rates.total} | ${pct(rates.l0)} |`,
    `| L1 or better | ${rates.l1}/${rates.total} | ${pct(rates.l1)} |`,
    `| L2 | ${rates.l2}/${rates.total} | ${pct(rates.l2)} |`,
    "",
    "## Per intent",
    "",
    ...summaryTable(results),
    "",
    "## Diagnostics seen (all rounds)",
    "",
  ];

  const counts = new Map();
  for (const result of results) {
    for (const round of result.rounds) {
      for (const diagnostic of round.diagnostics) {
        const key = `${diagnostic.severity}/${diagnostic.code}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  lines.push("| diagnostic | count |", "| --- | --- |");
  for (const [key, count] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    lines.push(`| ${key} | ${count} |`);
  }

  // What kept a run below L2 — the part that tells you *what to fix* in the
  // style guide or the context builder, which is the point of this layer.
  const below = results.filter((result) => result.finalLevel !== "L2");
  if (below.length > 0) {
    lines.push("", "## What kept a run below L2", "");
    for (const result of below) {
      const last = result.rounds[result.rounds.length - 1];
      lines.push(`### ${result.intent} — ${result.finalLevel}`, "");
      if (result.error !== undefined) lines.push(`- run failed: ${result.error}`);
      for (const diagnostic of last?.diagnostics ?? []) {
        if (diagnostic.severity === "info") continue;
        const at = diagnostic.source === undefined ? "" : ` (line ${diagnostic.source.start.line})`;
        lines.push(`- ${diagnostic.code}${at}: ${diagnostic.message}`);
      }
      lines.push("");
    }
  }

  lines.push("");
  return lines;
}

const args = parseArgs(process.argv.slice(2));

// Re-render an existing run with the current report format; no network involved.
if (args.from !== "") {
  const run = JSON.parse(readFileSync(args.from, "utf8"));
  const label = args.label === "" ? (run.options?.label ?? "") : args.label;
  const target = join(RESULTS_DIR, `summary${label === "" ? "" : `-${label}`}.md`);
  writeFileSync(target, `${renderSummary(run).join("\n")}\n`);
  console.log(`wrote ${target}`);
  process.exit(0);
}
const dotEnv = loadDotEnv(join(REPO_ROOT, ".env"));
const apiKey = process.env.OPENROUTER_API_KEY ?? dotEnv.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL ?? dotEnv.OPENROUTER_MODEL ?? "stealth/ox-alpha";

if (!apiKey) {
  console.error("No OPENROUTER_API_KEY in the environment or in .env — nothing to run.");
  process.exit(2);
}

const cf = await import(join(PACKAGE_ROOT, "dist", "index.js"));
const suite = await import(join(HERE, "..", "test", "ai", "suite.ts"));

const intents =
  args.intents.length === 0
    ? suite.EVAL_INTENTS
    : suite.EVAL_INTENTS.filter((intent) => args.intents.includes(intent.id));
if (intents.length === 0) throw new Error(`no intent matched ${args.intents.join(", ")}`);

const log = (message) => {
  console.log(message);
};

console.log(
  `model=${model}  intents=${intents.length}  repeat=${args.repeat}  maxRetries=${args.maxRetries}  target=${args.target}`,
);

const started = Date.now();
const results = [];
for (const intent of intents) {
  for (let run = 1; run <= args.repeat; run += 1) {
    const label = args.repeat === 1 ? intent.id : `${intent.id}#${run}`;
    try {
      const result = await suite.runIntent({
        cf,
        intent,
        config: { apiKey, model, maxTokens: 8000, log },
        maxRetries: args.maxRetries,
        target: args.target,
        includeExamples: args.examples,
        log,
      });
      results.push({ ...result, intent: label, intentId: intent.id });
    } catch (error) {
      console.error(`  [${label}] failed: ${error.message}`);
      results.push({
        intent: label,
        intentId: intent.id,
        covers: intent.covers,
        firstLevel: "invalid",
        finalLevel: "invalid",
        retries: 0,
        rounds: [],
        error: error.message,
      });
    }
  }
}

const rates = suite.conformanceRates(results);
const table = summaryTable(results);
const summaryLines = renderSummary({
  model,
  registryVersion: suite.EVAL_REGISTRY_VERSION,
  options: args,
  rates,
  results,
  durationSeconds: (Date.now() - started) / 1000,
});

mkdirSync(RESULTS_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const suffix = args.label === "" ? "" : `-${args.label}`;
const jsonPath = join(RESULTS_DIR, `run-${stamp}${suffix}.json`);
writeFileSync(
  jsonPath,
  `${JSON.stringify(
    {
      startedAt: new Date(started).toISOString(),
      model,
      registryVersion: suite.EVAL_REGISTRY_VERSION,
      options: args,
      rates,
      results,
    },
    null,
    2,
  )}\n`,
);
writeFileSync(join(RESULTS_DIR, `summary${suffix}.md`), `${summaryLines.join("\n")}\n`);

const share = (value) => `${((value / rates.total) * 100).toFixed(0)}%`;
console.log(`\n${table.join("\n")}`);
console.log(
  `\nL0+ ${rates.l0}/${rates.total} (${share(rates.l0)})  L1+ ${rates.l1}/${rates.total} (${share(rates.l1)})  L2 ${rates.l2}/${rates.total} (${share(rates.l2)})`,
);
console.log(`\nwrote ${jsonPath}`);
