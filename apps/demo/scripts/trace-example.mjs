#!/usr/bin/env node
/**
 * Print one example's trace, line by line, as the runner produces it.
 *
 *     node apps/demo/scripts/trace-example.mjs memory-graph-sync
 *
 * The batch sweep (`run-examples.mjs`) answers "did it run"; this answers "what
 * happened, in what order, with what values" — which is the question you have
 * when a flow stops earlier than expected. Same code path as the endpoint, no
 * browser in the way.
 */

import { analyzeSource, createRegistry, nodeRanges } from "@codeflow-team/core";
import { EXAMPLES, registryFor } from "@codeflow-team/examples";
const { startRun } = await import(new URL("/Users/lucas/code/codeflow/apps/demo/server/runner.ts", import.meta.url).href);
const ex = EXAMPLES.find(e=>e.id===process.argv[2]);
const { tools, functions } = registryFor(ex);
const g = analyzeSource(ex.source, createRegistry({tools,functions}), {file:"f.ts"});
const ranges = nodeRanges(g);
const label = id => g.nodes.find(n=>n.id===id)?.label ?? id;
const h = startRun({source: ex.source, ranges, tools: tools.map(t=>({name:t.name,outputSchema:t.outputSchema})), functions: functions.map(f=>({name:f.name,code:f.code})), timeoutMs: 60000}, "/Users/lucas/code/codeflow/apps/demo/server/worker.ts", f => {
  if (f.type==="event") console.log(`${String(f.at).padStart(6)}ms ${f.phase.padEnd(8)} ${f.iteration?`[${f.iteration.join(",")}] `:""}${label(f.nodeId)}${f.preview?" → "+JSON.stringify(f.preview).slice(0,240):""}${f.error?" ! "+f.error.message:""}`);
  else if (f.type==="emit") console.log(`  emit ${f.kind} ${f.iteration?`[${f.iteration.join(",")}] `:""}${JSON.stringify(f.payload)}`);
  else if (f.type==="plan") console.log(`plan: ${f.counted.length} counted loop(s), ${f.uncounted.length} uncounted, blind=${String(f.blind)}`);
  else if (f.type==="input") console.log("input", JSON.stringify(f.input));
  else if (f.type==="done") console.log("DONE", f.status, JSON.stringify(f.result??f.error??"").slice(0,300));
});
await h.finished;
