/**
 * Context value shape and the constants that go with it.
 *
 * Split out of `provider.tsx` so that module exports only its component: a
 * module mixing components with other values is not a Fast Refresh boundary,
 * and gets invalidated (reloading its importers) on any dependency change.
 */

import type {
  CodeFlowErrorCode,
  CodeFlowSession,
  Diagnostic,
  GraphChange,
  PatchResult,
  RegistryLookup,
  SourceMapping,
  TextPatch,
  WorkflowGraph,
  WorkflowNode,
} from "@codeflow/core";
import type { GraphIndex } from "../graph/index.js";
import type { DisclosureMode } from "../flow/summary.js";

/** Why an edit was refused — `code` is the patch engine's, not a UI invention. */
export interface PatchFailure {
  nodeId: string;
  code: CodeFlowErrorCode | "unknown";
  message: string;
}

/** What the last successful patch did, kept so the UI can show it (07 §5). */
export interface PatchSuccess {
  /** The node the edit was addressed to. */
  nodeId: string;
  /**
   * Nodes this patch is *about*: the edited node plus anything it added. An
   * insert is addressed to the anchor node but the user is looking at the new
   * one, so both have to be able to show what happened.
   */
  nodeIds: string[];
  patches: TextPatch[];
  diagnostics: Diagnostic[];
  changes: GraphChange[];
  at: number;
}

export type PatchOutcome =
  | { ok: true; result: PatchResult }
  | ({ ok: false } & PatchFailure);

export type PreviewOutcome =
  | { ok: true; patches: TextPatch[]; diagnostics: Diagnostic[] }
  | { ok: false; code: CodeFlowErrorCode | "unknown"; message: string };

export interface CodeFlowContextValue {
  graph: WorkflowGraph | null;
  session: CodeFlowSession | null;
  registry: RegistryLookup | null;

  index: GraphIndex;
  nodeDiagnostics: Map<string, Diagnostic[]>;

  selectedNodeId: string | null;
  selectedNode: WorkflowNode | null;
  selectNode: (nodeId: string | null) => void;
  /** Select whichever node owns `offset` in the source — code panel → canvas. */
  selectNodeAtOffset: (offset: number) => WorkflowNode | null;

  mode: DisclosureMode;
  setMode: (mode: DisclosureMode) => void;

  /** Source range the code panel should reveal/highlight; canvas → code panel. */
  focusedRange: SourceMapping | null;
  focusRange: (range: SourceMapping | null) => void;

  /* --- editing (06) ------------------------------------------------------ */

  /** False when an edit could not be applied end-to-end; the reason says why. */
  editingEnabled: boolean;
  editingDisabledReason: string;

  /** The host's current text — may be ahead of `graph.source.content`. */
  source: string;
  /** True when the editor holds text the graph was not built from (06 §5). */
  sourceDirty: boolean;

  /** Apply one edit (06 §4). Never throws: refusals come back as `ok: false`. */
  patchNode: (nodeId: string, changes: Record<string, unknown>) => Promise<PatchOutcome>;
  /** The same patch computed but not committed — "preview diff before apply" (07 §5). */
  previewPatch: (nodeId: string, changes: Record<string, unknown>) => PreviewOutcome;

  lastPatch: PatchSuccess | null;
  patchError: PatchFailure | null;
  clearPatchError: () => void;
  /** Nodes the last patch added or updated — highlighted on the canvas. */
  changedNodeIds: Set<string>;

  /** Ask the host to re-analyze its current source (offered after a conflict). */
  requestReanalyze: () => void;
  canReanalyze: boolean;
}

export const EDITING_DISABLED_REASON =
  "Editing needs a CodeFlowSession and an `onPatched` handler on <CodeFlowProvider> (06 §4).";
