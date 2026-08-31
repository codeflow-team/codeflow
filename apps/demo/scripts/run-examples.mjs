#!/usr/bin/env node
/**
 * Run the published gallery through the demo runner and report what happened.
 *
 * ```
 * node apps/demo/scripts/run-examples.mjs                 # all of them
 * node apps/demo/scripts/run-examples.mjs canonical …     # a few
 * node apps/demo/scripts/run-examples.mjs --keep memory-graph-sync
 * ```
 *
 * The point is a table nobody has to take on trust: for each flow, how many of
 * its steps actually executed, how long it took, whether the tools behind it
 * were real MCP servers or schema-shaped samples, and — when it stopped early —
 * which step it stopped on. `--keep` leaves the scratch directory behind so the
 * files a flow really wrote can be listed afterwards.
 *
 * This drives `server/runner.ts` directly. No browser, no dev server: the same
 * code path the endpoint uses, exercised where it can be watched.
 */

import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeSource, createRegistry, nodeRanges, summarizeRun } from "@codeflow-team/core";
import { EXAMPLES, registryFor } from "@codeflow-team/examples";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, "..");
const { startRun } = await import(new URL("../server/runner.ts", import.meta.url).href);
const WORKER = join(APP_DIR, "server", "worker.ts");

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const timeoutArg = argv.find((arg) => arg.startsWith("--timeout="));
const timeoutMs = timeoutArg === undefined ? 120_000 : Number(timeoutArg.split("=")[1]);
const wanted = argv.filter((arg) => !arg.startsWith("--"));
const selected = wanted.length === 0 ? EXAMPLES : EXAMPLES.filter((example) => wanted.includes(example.id));

function tree(dir, prefix = "", depth = 0) {
  if (depth > 3) return [];
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const info = statSync(full);
    if (info.isDirectory()) {
      out.push(`${prefix}${entry}/`);
      out.push(...tree(full, `${prefix}  `, depth + 1));
    } else {
      out.push(`${prefix}${entry} (${String(info.size)} B)`);
    }
  }
  return out;
}

const rows = [];

for (const example of selected) {
  const { tools, functions } = registryFor(example);
  const registry = createRegistry({ tools, functions });
  const graph = analyzeSource(example.source, registry, { file: `${example.id}.flow.ts` });
  const ranges = nodeRanges(graph);

  const events = [];
  const calls = [];
  let plan = null;
  let outcome = null;
  const startedAt = Date.now();

  process.stderr.write(`→ ${example.id} (${String(example.lines)} lines, ${String(ranges.length)} steps) … `);

  const handle = startRun(
    {
      exampleId: example.id,
      source: example.source,
      ranges,
      tools: tools.map((tool) => ({ name: tool.name, outputSchema: tool.outputSchema })),
      functions: functions.map((fn) => ({ name: fn.name, code: fn.code })),
      timeoutMs,
      keepScratch: keep,
    },
    WORKER,
    (frame) => {
      if (frame.type === "plan") plan = frame;
      else if (frame.type === "event") events.push(frame);
      // One per-node channel: a tool call is an emit like any other (`RunEmit`),
      // and this table reads the `tool-call` kind out of it.
      else if (frame.type === "emit" && frame.kind === "tool-call") calls.push({ ...frame.payload, nodeId: frame.nodeId, at: frame.at });
      else if (frame.type === "done") outcome = frame;
    },
  );

  await handle.finished;
  const ms = Date.now() - startedAt;

  const state = summarizeRun(events);
  const started = new Set(events.filter((event) => event.phase === "started").map((event) => event.nodeId));
  const failed = [...state.values()].filter((entry) => entry.status === "failed");
  const label = (nodeId) => graph.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;

  const modes = new Set((plan?.bindings ?? []).map((binding) => binding.mode));
  const mcpNamespaces = (plan?.bindings ?? []).filter((b) => b.mode === "mcp").map((b) => b.namespace);
  const stubNamespaces = (plan?.bindings ?? []).filter((b) => b.mode === "stub").map((b) => b.namespace);

  rows.push({
    id: example.id,
    lines: example.lines,
    steps: ranges.length,
    probed: plan?.probed.length ?? 0,
    skipped: plan?.skipped.length ?? 0,
    ran: started.size,
    events: events.length,
    calls: calls.length,
    mcpCalls: calls.filter((call) => call.mode === "mcp").length,
    stubCalls: calls.filter((call) => call.mode === "stub").length,
    binding: modes.size === 0 ? "none" : [...modes].join("+"),
    mcpNamespaces,
    stubNamespaces,
    status: outcome?.status ?? "?",
    ms,
    error: outcome?.error?.message ?? null,
    failedAt: failed.map((entry) => label(entry.nodeId)),
    result: outcome?.result,
    workspace: plan?.workspace ?? null,
    files: keep && plan !== null ? tree(plan.workspace) : [],
  });

  process.stderr.write(`${outcome?.status ?? "?"} · ${String(started.size)}/${String(ranges.length)} steps · ${String(ms)}ms\n`);
}

/* --- report --------------------------------------------------------------- */

const cell = (value) => String(value).replaceAll("|", "\\|");
console.log("");
console.log("| flow | lines | steps run / total | tools | calls (mcp/stub) | ms | status | stopped at |");
console.log("|---|---|---|---|---|---|---|---|");
for (const row of rows) {
  console.log(
    `| ${row.id} | ${String(row.lines)} | ${String(row.ran)}/${String(row.steps)}${row.skipped > 0 ? ` (${String(row.skipped)} unprobed)` : ""} | ${row.binding} | ${String(row.mcpCalls)}/${String(row.stubCalls)} | ${String(row.ms)} | ${row.status} | ${cell(row.failedAt.join(", ") || "—")} |`,
  );
}

console.log("");
for (const row of rows) {
  if (row.error === null && row.files.length === 0) continue;
  console.log(`### ${row.id}`);
  if (row.mcpNamespaces.length > 0) console.log(`- real MCP: ${row.mcpNamespaces.join(", ")}`);
  if (row.stubNamespaces.length > 0) console.log(`- sample data: ${row.stubNamespaces.join(", ")}`);
  if (row.error !== null) console.log(`- error: ${row.error}`);
  if (row.files.length > 0) console.log(`- scratch (${row.workspace}):\n${row.files.map((line) => `    ${line}`).join("\n")}`);
  console.log("");
}

console.log(JSON.stringify({ rows: rows.map(({ files: _files, ...rest }) => rest) }, null, 2));
