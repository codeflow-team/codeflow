/** Result of `patchNode` — 06-patch-engine.md §4. */

import type { Diagnostic } from "./diagnostic.js";
import type { GraphChange, WorkflowGraph } from "./graph.js";
import type { TextPatch } from "./source.js";

export interface PatchResult {
  /** The new source. */
  source: string;
  /** The ranges that changed. */
  patches: TextPatch[];
  /** Graph after re-analyze. */
  graph: WorkflowGraph;
  diagnostics: Diagnostic[];
  /**
   * Graph diff of this patch (03 §10) — the same value `lastChanges()` reports,
   * handed over here so a caller that only holds the result can update
   * incrementally without asking the session again.
   */
  changes: GraphChange[];
}

/** Options of `patchNode` — conflict detection, 06 §5. */
export interface PatchNodeOptions {
  /**
   * The file's current content, when the host may hold a newer revision than
   * the graph was built from. Different content triggers a re-analyze first;
   * the patch then only proceeds if the node's **raw text** is unchanged
   * (06 §5 — raw text, not the normalized fingerprint, because a fingerprint
   * ignores trivia and would miss a comment edit a region-replacing patch
   * would overwrite).
   */
  source?: string;
}
