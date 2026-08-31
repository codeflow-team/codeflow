#!/usr/bin/env node
/**
 * Real-MCP AI conformance eval runner — 11-testing.md §3.6, 10-ai-codegen.md §5.
 *
 *   pnpm build                              # the suite runs against dist
 *   node packages/mcp/scripts/real-mcp-eval.mjs
 *   node packages/mcp/scripts/real-mcp-eval.mjs --intent resilient-edit --repeat 2
 *
 * Same ladder as `packages/core/scripts/ai-eval.mjs`, but the registry is built
 * from the captured schemas of real MCP servers instead of a hand-written
 * github/slack one. Writes a JSON run plus `real-mcp-summary.md` (and the
 * generated flow for every intent) under `packages/core/test/ai/results/`, next
 * to the existing eval output so the two are read together.
 *
 * Never a CI gate: network + non-deterministic model.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
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
  const args = { intents: [], repeat: 1, maxRetries: 2, label: "", noExamples: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--intent") args.intents.push(argv[++i]);
    else if (arg === "--repeat") args.repeat = Number(argv[++i]);
    else if (arg === "--max-retries") args.maxRetries = Number(argv[++i]);
    else if (arg === "--label") args.label = argv[++i];
    else if (arg === "--no-examples") args.noExamples = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dotenv = loadDotEnv(join(REPO_ROOT, ".env"));
  const apiKey = process.env.OPENROUTER_API_KEY ?? dotenv.OPENROUTER_API_KEY;
  const model = process.env.OPENROUTER_MODEL ?? dotenv.OPENROUTER_MODEL ?? "stealth/ox-alpha";
  if (!apiKey) {
    console.error("OPENROUTER_API_KEY is not set (env or .env).");
    process.exit(1);
  }

  const cf = await import("@codeflow-team/core");
  // The suite is type-stripped by Node; the adapter comes from dist so the
  // script measures the same build a host would install.
  const adapter = await import("../dist/index.js");
  const suite = await import("../test/ai/real-mcp-suite.ts");

  const selected =
    args.intents.length > 0
      ? suite.REAL_MCP_INTENTS.filter((i) => args.intents.includes(i.id))
      : suite.REAL_MCP_INTENTS;
  if (selected.length === 0) {
    console.error(`No intent matched. Known: ${suite.REAL_MCP_INTENTS.map((i) => i.id).join(", ")}`);
    process.exit(1);
  }

  // Report the size of the context the model is actually handed.
  const registry = suite.createRealMcpRegistry(cf, adapter);
  const session = cf.createCodeFlow({ registry });
  const context = await session.buildGenerationContext({ includeExamples: !args.noExamples });
  const systemPrompt = cf.renderSystemPrompt(context);
  console.error(
    `registry: ${registry.listTools().length} real MCP tools from ` +
      `${suite.EVAL_SERVERS.join(", ")}; system prompt ≈ ${Math.ceil(systemPrompt.length / 4)} tokens`,
  );

  const results = [];
  for (let run = 0; run < args.repeat; run += 1) {
    for (const intent of selected) {
      try {
        results.push(
          await suite.runIntent({
            cf,
            adapter,
            intent,
            config: { apiKey, model, maxTokens: 32000, log: (m) => console.error(m) },
            maxRetries: args.maxRetries,
            includeExamples: !args.noExamples,
            log: (m) => console.error(m),
          }),
        );
      } catch (error) {
        console.error(`  [${intent.id}] FAILED: ${error.message}`);
        results.push({
          intent: intent.id,
          covers: intent.covers,
          firstLevel: "invalid",
          finalLevel: "invalid",
          retries: 0,
          rounds: [],
          toolsUsed: [],
          error: error.message,
        });
      }
    }
  }

  const rates = suite.conformanceRates(results);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const suffix = args.label ? `-${args.label}` : "";
  mkdirSync(RESULTS_DIR, { recursive: true });

  const payload = {
    kind: "real-mcp",
    evalVersion: suite.REAL_MCP_EVAL_VERSION,
    servers: suite.EVAL_SERVERS,
    toolCount: registry.listTools().length,
    model,
    maxTokens: 32000,
    maxRetries: args.maxRetries,
    includeExamples: !args.noExamples,
    systemPromptTokens: Math.ceil(systemPrompt.length / 4),
    ranAt: new Date().toISOString(),
    rates,
    results,
  };
  const jsonPath = join(RESULTS_DIR, `real-mcp-${stamp}${suffix}.json`);
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`);

  const pct = (n) => `${((n / rates.total) * 100).toFixed(0)}%`;
  const lines = [
    `# Real-MCP AI conformance — ${model}`,
    "",
    `Registry: **${registry.listTools().length} tools** captured from real MCP servers ` +
      `(${suite.EVAL_SERVERS.join(", ")}). Eval version ${suite.REAL_MCP_EVAL_VERSION}. ` +
      `System prompt ≈ ${Math.ceil(systemPrompt.length / 4)} tokens, \`max_tokens\` 32000.`,
    "",
    `Ran ${payload.ranAt} · ${rates.total} generations · max ${args.maxRetries} retries.`,
    "",
    "| Level | Reached | Rate |",
    "| --- | --- | --- |",
    `| L0 (parses + typechecks) | ${rates.l0}/${rates.total} | ${pct(rates.l0)} |`,
    `| L1 (analyzes to a graph) | ${rates.l1}/${rates.total} | ${pct(rates.l1)} |`,
    `| L2 (idiomatic) | ${rates.l2}/${rates.total} | ${pct(rates.l2)} |`,
    "",
    "## Per intent",
    "",
    "| Intent | First | Final | Retries | Real tools called |",
    "| --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.intent} | ${r.firstLevel} | ${r.finalLevel} | ${r.retries} | ` +
        `${r.toolsUsed.length > 0 ? r.toolsUsed.map((t) => `\`${t}\``).join(", ") : "—"} |`,
    ),
    "",
  ];

  for (const result of results) {
    lines.push(`## ${result.intent}`, "");
    if (result.error) {
      lines.push("```", result.error, "```", "");
      continue;
    }
    for (const round of result.rounds) {
      lines.push(`### round ${round.round} → ${round.level} (${round.ms}ms)`, "");
      if (round.diagnostics.length > 0) {
        lines.push("Diagnostics:", "");
        for (const d of round.diagnostics) {
          lines.push(`- \`${d.code ?? d.rule ?? "?"}\` ${d.message}`);
        }
        lines.push("");
      }
      lines.push("```ts", round.source.trimEnd(), "```", "");
    }
  }

  const mdPath = join(RESULTS_DIR, `real-mcp-summary${suffix}.md`);
  writeFileSync(mdPath, `${lines.join("\n")}\n`);

  console.error(
    `\nL0 ${rates.l0}/${rates.total} · L1 ${rates.l1}/${rates.total} · L2 ${rates.l2}/${rates.total}`,
  );
  console.error(`→ ${jsonPath}\n→ ${mdPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
