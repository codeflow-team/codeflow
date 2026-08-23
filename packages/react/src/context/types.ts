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
  NodeRunState,
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

/**
 * What a run looks like to the canvas — 09-future.md §1.
 *
 * The library does not execute anything and never will (00 §5, I7); it renders
 * what a runtime reports. A host that has a runtime (the demo has one, in its
 * dev server) folds `RunEvent`s with `summarizeRun` and hands the result down.
 *
 * `activeNodeId` is deliberately singular. A loop body that has run twenty
 * times has twenty runs behind it and is *not* running now — showing all of
 * them lit would turn the one useful signal into wallpaper.
 */
export interface RunView {
  status: "running" | "ok" | "failed" | "cancelled";
  /** Folded per-node state, keyed by node id. */
  nodes: Map<string, NodeRunState>;
  /** The one step executing right now, or `null` between steps and after. */
  activeNodeId: string | null;
  /**
   * Steps the runtime said it cannot report on.
   *
   * They must read as "not traced", never as "not reached": claiming a step did
   * not run when the truth is that nobody watched is exactly the silent
   * inaccuracy 07 §5 forbids.
   */
  untraced: Set<string>;
  /**
   * Nodes the runtime was asked to report on at all; `null` means "all of them".
   *
   * A synthetic node — the trigger, a merge, an implicit end — owns no source of
   * its own (`nodeRanges` leaves it out, 09 §1), so the absence of events about
   * it is not evidence of anything. Fading it as "never reached" would be an
   * invented fact, so it is left unmarked instead.
   */
  tracked: Set<string> | null;
}

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

  /** The current (or last) run, when the host has a runtime. `null` otherwise. */
  run: RunView | null;
}

export const EDITING_DISABLED_REASON =
  "Editing needs a CodeFlowSession and an `onPatched` handler on <CodeFlowProvider> (06 §4).";
