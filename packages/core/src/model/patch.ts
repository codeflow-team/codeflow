/** Result of `patchNode` — 06-patch-engine.md §4. */

import type { Diagnostic } from "./diagnostic.js";
import type { WorkflowGraph } from "./graph.js";
import type { TextPatch } from "./source.js";

export interface PatchResult {
  /** The new source. */
  source: string;
  /** The ranges that changed. */
  patches: TextPatch[];
  /** Graph after re-analyze. */
  graph: WorkflowGraph;
  diagnostics: Diagnostic[];
}
