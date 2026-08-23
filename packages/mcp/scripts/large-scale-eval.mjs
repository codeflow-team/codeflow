#!/usr/bin/env node
/**
 * Large-scale AI conformance eval runner — 11-testing.md §3.6, 10-ai-codegen.md §5.
 *
 *   pnpm build                                     # the suite runs against dist
 *   node packages/mcp/scripts/large-scale-eval.mjs
 *   node packages/mcp/scripts/large-scale-eval.mjs --intent repo-triage-bot --repeat 2
 *   node packages/mcp/scripts/large-scale-eval.mjs --no-examples --label no-examples
 *
 * Same ladder as `real-mcp-eval.mjs`, at feature scale: product-shaped briefs
 * that need 150–400 lines and 20–38 real MCP tools, scored on size, construct
 * coverage, code-node ratio, diagnostics, time and tokens as well as on L0/L1/L2.
 *
 * Writes `large-<stamp><label>.json` plus `large-scale-summary<label>.md` under
 * `packages/core/test/ai/results/`.
 *
 * Never a CI gate: network + non-deterministic model.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, "..");
const REPO_ROOT = join(PACKAGE_ROOT, "..", "..");
const RESULTS_DIR = join(REPO_ROOT, "packages", "core", "test", "ai", "results");

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
    label: "",
    noExamples: false,
    target: "L2",
    maxTokens: 48000,
    dry: false,
    merge: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--intent") args.intents.push(argv[++i]);
    else if (arg === "--repeat") args.repeat = Number(argv[++i]);
    else if (arg === "--max-retries") args.maxRetries = Number(argv[++i]);
    else if (arg === "--label") args.label = argv[++i];
    else if (arg === "--target") args.target = argv[++i];
    else if (arg === "--max-tokens") args.maxTokens = Number(argv[++i]);
    else if (arg === "--no-examples") args.noExamples = true;
    // Context sizing without spending a token — checks the harness, not the model.
    else if (arg === "--dry") args.dry = true;
    // A feature-sized generation takes minutes, so a full run is sharded across
    // processes; `--merge a.json,b.json` stitches the shards into one report.
    else if (arg === "--merge") args.merge = argv[++i].split(",");
  }
  return args;
}

function pct(n, total) {
  return total === 0 ? "—" : `${((n / total) * 100).toFixed(0)}%`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotenv = loadDotEnv(join(REPO_ROOT, ".env"));
  const apiKey = process.env.OPENROUTER_API_KEY ?? dotenv.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL ?? dotenv.OPENROUTER_MODEL ?? "stealth/ox-alpha";
  if (!apiKey && !args.dry) {
    console.error("OPENROUTER_API_KEY is not set (env or .env).");
    process.exit(1);
  }

  const cf = await import("@codeflow/core");
  const adapter = await import("../dist/index.js");
  const suite = await import("../test/ai/large-scale-suite.ts");

  if (args.merge !== null) {
    const shards = args.merge.map((path) =>
      JSON.parse(readFileSync(path.startsWith("/") ? path : join(RESULTS_DIR, path), "utf8")),
    );
    const merged = shards.flatMap((shard) => shard.results);
    report(suite, merged, {
      model,
      maxTokens: shards[0]?.maxTokens ?? args.maxTokens,
      maxRetries: shards[0]?.maxRetries ?? args.maxRetries,
      target: shards[0]?.target ?? args.target,
      includeExamples: shards[0]?.includeExamples ?? !args.noExamples,
      label: args.label,
      mergedFrom: args.merge,
    });
    return;
  }

  const selected =
    args.intents.length > 0
      ? suite.LARGE_INTENTS.filter((i) => args.intents.includes(i.id))
      : suite.LARGE_INTENTS;
  if (selected.length === 0) {
    console.error(`No intent matched. Known: ${suite.LARGE_INTENTS.map((i) => i.id).join(", ")}`);
    process.exit(1);
  }

  for (const intent of selected) {
    const registry = suite.createScopedRegistry(cf, adapter, intent.servers);
    const session = cf.createCodeFlow({ registry });
    const context = await session.buildGenerationContext({ includeExamples: !args.noExamples });
    const prompt = cf.renderSystemPrompt(context);
    console.error(
      `${intent.id}: ${registry.listTools().length} tools (${intent.servers.join(", ")}), ` +
        `system prompt ≈ ${Math.ceil(prompt.length / 4)} tokens, target ${intent.targetLines} lines`,
    );
  }
  if (args.dry) return;

  // A feature-sized generation runs for minutes and a full shard for hours, so
  // finished intents are flushed to disk as they land: a run interrupted at hour
  // two still leaves usable data behind.
  // Deliberately *not* named `large-*.json`: that glob is how a shard's finished
  // run is found for `--merge`, and a half-written checkpoint matching it would
  // silently double-count intents in the merged report.
  const checkpointPath = join(
    RESULTS_DIR,
    `checkpoint-${args.label ? `${args.label}-` : ""}large.json`,
  );

  const results = [];
  for (let run = 0; run < args.repeat; run += 1) {
    for (const intent of selected) {
      try {
        results.push(
          await suite.runLargeIntent({
            cf,
            adapter,
            intent,
            config: {
              apiKey,
              model,
              maxTokens: args.maxTokens,
              log: (m) => console.error(m),
            },
            maxRetries: args.maxRetries,
            target: args.target,
            includeExamples: !args.noExamples,
            log: (m) => console.error(m),
          }),
        );
      } catch (error) {
        console.error(`  [${intent.id}] FAILED: ${error.message}`);
        results.push({
          intent: intent.id,
          servers: intent.servers,
          toolCount: 0,
          systemPromptTokens: 0,
          covers: intent.covers,
          targetLines: intent.targetLines,
          includeExamples: !args.noExamples,
          firstLevel: "invalid",
          finalLevel: "invalid",
          retries: 0,
          rounds: [],
          toolsUsed: [],
          totalMs: 0,
          error: error.message,
        });
      }
      mkdirSync(RESULTS_DIR, { recursive: true });
      writeFileSync(checkpointPath, `${JSON.stringify({ results }, null, 2)}\n`);
    }
  }


  report(suite, results, {
    model,
    maxTokens: args.maxTokens,
    maxRetries: args.maxRetries,
    target: args.target,
    includeExamples: !args.noExamples,
    label: args.label,
  });
  // The full run is on disk now; the checkpoint has nothing left to protect.
  rmSync(checkpointPath, { force: true });
}

/**
 * One JSON run plus one markdown summary, from a set of results — whether they
 * were just generated or read back off sharded runs.
 */
function report(suite, results, meta) {
  const rates = suite.conformanceRates(results);
  const first = suite.firstRoundRates(results);
  const histogram = suite.diagnosticHistogram(results);
  const coverage = suite.constructCoverage(results);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = meta.label ? `-${meta.label}` : "";
  mkdirSync(RESULTS_DIR, { recursive: true });

  const payload = {
    kind: "large-scale",
    evalVersion: suite.LARGE_SCALE_EVAL_VERSION,
    model: meta.model,
    maxTokens: meta.maxTokens,
    maxRetries: meta.maxRetries,
    target: meta.target,
    includeExamples: meta.includeExamples,
    ...(meta.mergedFrom === undefined ? {} : { mergedFrom: meta.mergedFrom }),
    ranAt: new Date().toISOString(),
    rates,
    firstRoundRates: first,
    diagnosticHistogram: histogram,
    constructCoverage: coverage,
    results,
  };
  const jsonPath = join(RESULTS_DIR, `large-${stamp}${suffix}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  const last = (r) => r.rounds[r.rounds.length - 1];
  const lines = [
    `# Large-scale AI conformance — ${meta.model}`,
    "",
    `Feature-sized briefs (150–400 lines expected) against scoped registries of real MCP tools. ` +
      `Eval version ${suite.LARGE_SCALE_EVAL_VERSION}. \`max_tokens\` ${meta.maxTokens}, ` +
      `target ${meta.target}, max ${meta.maxRetries} retries, ` +
      `few-shot examples ${meta.includeExamples ? "on" : "**off**"}.`,
    "",
    `Ran ${payload.ranAt} · ${rates.total} generations.`,
    "",
    "First round is what a host gets from one generation; final is what the retry loop of",
    "10 §5 gets after feeding diagnostics back.",
    "",
    "| Level | First round | Final | Final rate |",
    "| --- | --- | --- | --- |",
    `| L0 (parses + contract) | ${first.l0}/${first.total} | ${rates.l0}/${rates.total} | ${pct(rates.l0, rates.total)} |`,
    `| L1 (everything resolves) | ${first.l1}/${first.total} | ${rates.l1}/${rates.total} | ${pct(rates.l1, rates.total)} |`,
    `| L2 (maps cleanly) | ${first.l2}/${first.total} | ${rates.l2}/${rates.total} | ${pct(rates.l2, rates.total)} |`,
    "",
    "## Per generation",
    "",
    "| Intent | Tools | Lines (target) | Nodes | Edges | Code nodes | Meaningful | Nesting | First → final | Retries | Time |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map((r) => {
      const l = last(r);
      const shape = l?.shape;
      return (
        `| ${r.intent} | ${r.toolCount} | ${l ? l.lines : "—"} (${r.targetLines}) | ` +
        `${shape ? shape.nodes : "—"} | ${shape ? shape.edges : "—"} | ` +
        `${shape ? shape.codeNodes : "—"} | ` +
        `${shape ? `${(shape.meaningfulRatio * 100).toFixed(0)}%` : "—"} | ` +
        `${shape ? shape.maxNesting : "—"} | ${r.firstLevel} → ${r.finalLevel} | ${r.retries} | ` +
        `${(r.totalMs / 1000).toFixed(0)}s |`
      );
    }),
    "",
    "## Construct coverage",
    "",
    `${coverage.covered}/${coverage.asked} of the constructs the briefs required were projected ` +
      `to the graph (${pct(coverage.covered, coverage.asked)}).`,
    "",
    "| Construct asked for | Times missing |",
    "| --- | --- |",
    ...Object.entries(coverage.missingByConstruct)
      .sort((a, b) => b[1] - a[1])
      .map(([construct, n]) => `| ${construct} | ${n} |`),
    "",
    "## Diagnostics over every round",
    "",
    "| Diagnostic | Count |",
    "| --- | --- |",
    ...Object.entries(histogram)
      .sort((a, b) => b[1] - a[1])
      .map(([code, n]) => `| \`${code}\` | ${n} |`),
    "",
    "## Tokens and time",
    "",
    "| Intent | Round | Prompt tokens | Completion tokens | Time |",
    "| --- | --- | --- | --- | --- |",
    ...results.flatMap((r) =>
      r.rounds.map(
        (round) =>
          `| ${r.intent} | ${round.round} | ${round.usage?.promptTokens ?? "—"} | ` +
          `${round.usage?.completionTokens ?? "—"} | ${(round.ms / 1000).toFixed(0)}s |`,
      ),
    ),
    "",
  ];

  for (const result of results) {
    lines.push(`## ${result.intent}`, "");
    if (result.error) {
      lines.push("```", result.error, "```", "");
      continue;
    }
    lines.push(
      `Servers: ${result.servers.join(", ")} · ${result.toolCount} tools · ` +
        `system prompt ≈ ${result.systemPromptTokens} tokens.`,
      "",
      `Tools actually called: ${
        result.toolsUsed.length > 0 ? result.toolsUsed.map((t) => `\`${t}\``).join(", ") : "—"
      }`,
      "",
    );
    for (const round of result.rounds) {
      lines.push(
        `### round ${round.round} → ${round.level} · ${round.lines} lines · ` +
          `${round.shape ? round.shape.nodes : 0} nodes (${(round.ms / 1000).toFixed(0)}s)`,
        "",
      );
      if (round.shape) {
        lines.push(
          `Node types: ${Object.entries(round.shape.nodeTypes)
            .sort((a, b) => b[1] - a[1])
            .map(([type, n]) => `${type}×${n}`)
            .join(", ")}`,
          "",
          `Covered: ${round.covered.join(", ") || "—"}${
            round.missing.length > 0 ? ` · **missing: ${round.missing.join(", ")}**` : ""
          }`,
          "",
        );
      }
      if (round.diagnostics.length > 0) {
        lines.push("Diagnostics:", "");
        for (const d of round.diagnostics.slice(0, 40)) {
          const at = d.source ? ` (line ${d.source.start.line})` : "";
          lines.push(`- \`${d.severity}/${d.code}\`${at} ${d.message}`);
        }
        if (round.diagnostics.length > 40) {
          lines.push(`- … ${round.diagnostics.length - 40} more`);
        }
        lines.push("");
      }
      lines.push("```ts", round.source.trimEnd(), "```", "");
    }
  }

  const mdPath = join(RESULTS_DIR, `large-scale-summary${suffix}.md`);
  writeFileSync(mdPath, `${lines.join("\n")}\n`);

  console.error(
    `\nL0 ${rates.l0}/${rates.total} · L1 ${rates.l1}/${rates.total} · L2 ${rates.l2}/${rates.total}` +
      ` · constructs ${coverage.covered}/${coverage.asked}`,
  );
  console.error(`→ ${jsonPath}\n→ ${mdPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
