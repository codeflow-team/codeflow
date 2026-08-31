#!/usr/bin/env node
/**
 * Which steps the instrumenter refuses to probe, and why.
 *
 *     node apps/demo/scripts/skipped-report.mjs
 *
 * Every refusal is a step the UI has to label "not traced" rather than "not
 * reached" (07 §5 forbids the lie), so the list is worth watching: it should be
 * empty for the published gallery, and any new entry is either a real language
 * shape the runner cannot rewrite safely or a gap worth closing.
 */

import { analyzeSource, createRegistry, nodeRanges } from "@codeflow-team/core";
import { EXAMPLES, registryFor } from "@codeflow-team/examples";
const { instrument } = await import(new URL("../server/instrument.ts", import.meta.url).href);
for (const ex of EXAMPLES) {
  const { tools, functions } = registryFor(ex);
  const g = analyzeSource(ex.source, createRegistry({tools,functions}), {file:"f.ts"});
  const ranges = nodeRanges(g);
  const r = instrument(ex.source, ranges, { rewriteImports: { "@flows/lib": "./lib.ts" } });
  if (r.skipped.length === 0) { console.log(`${ex.id}: all ${ranges.length} probed`); continue; }
  console.log(`${ex.id}: ${r.probed.length}/${ranges.length} probed, ${r.skipped.length} skipped`);
  for (const s of r.skipped) {
    const node = g.nodes.find(n => n.id === s.nodeId);
    console.log(`   - ${node?.type} "${node?.label}" → ${s.reason}: ${s.detail}`);
    console.log(`     src: ${ex.source.slice(node.source.start.offset, Math.min(node.source.end.offset, node.source.start.offset+90)).replace(/\n/g," ")}`);
  }
}
