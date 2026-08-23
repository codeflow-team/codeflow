/**
 * `<CodeFlowProvider>` — the single place UI state lives (07 §2).
 *
 * View state (03 §8) — selection, disclosure level, the source range the code
 * panel reveals — is held here and never derived back into the graph.
 *
 * Editing (phase 6b) is wired to the patch engine (06) and follows its shape
 * exactly: every edit goes through `session.patchNode`, which either commits an
 * atomically-validated patch or throws a `CodeFlowError` with a `patch-*` code.
 * The provider keeps that failure around as state — a refusal is information the
 * user has to be able to read, not a toast that disappears (07 §5). The new
 * source and graph are handed to the host through `onPatched`; the provider
 * never owns them, because the graph is a projection of the host's source
 * (00 §2.1).
 */

// The context object lives in its own module so it keeps one identity across
// Fast Refresh re-execution — see context.ts.
import { CodeFlowContext } from "./context.js";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CodeFlowError,
  type CodeFlowErrorCode,
  type CodeFlowSession,
  type PatchResult,
  type RegistryLookup,
  type SourceMapping,
  type WorkflowGraph,
} from "@codeflow/core";
import { computePatch } from "@codeflow/core";
import { buildIndex, diagnosticsByNode, nodeAtOffset } from "../graph/index.js";
import { EDITING_DISABLED_REASON } from "./types.js";
import type {
  CodeFlowContextValue,
  PatchFailure,
  PatchOutcome,
  PatchSuccess,
  PreviewOutcome,
} from "./types.js";
import type { DisclosureMode } from "../flow/summary.js";

export interface CodeFlowProviderProps {
  /** The graph to display. Falls back to `session.getGraph()` when omitted. */
  graph?: WorkflowGraph | null;
  /** Session the graph came from — the one source for registry + patching (02 §4). */
  session?: CodeFlowSession | null;
  /** Registry override; defaults to `session.registry`. */
  registry?: RegistryLookup | null;
  /**
   * The host's current source text, when the editor may be ahead of the graph.
   * Passed to `patchNode` so conflict detection can run (06 §5).
   */
  source?: string;
  /**
   * Called with the result of every committed patch — the host owns the source
   * and the graph, so this is how they move forward.
   */
  onPatched?: (result: PatchResult) => void;
  /**
   * Called when the session's graph moved without a patch committing (the
   * conflict path of 06 §5 re-analyzes before refusing), so the host can catch
   * up instead of rendering a graph the session no longer holds.
   */
  onGraphSync?: (graph: WorkflowGraph) => void;
  /** Called when the user asks to re-analyze after a conflict. */
  onReanalyze?: () => void;
  /** Turn editing off even when everything else is wired. */
  editable?: boolean;
  defaultMode?: DisclosureMode;
  /** Controlled disclosure level. */
  mode?: DisclosureMode;
  onModeChange?: (mode: DisclosureMode) => void;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  children: ReactNode;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function codeOf(cause: unknown): CodeFlowErrorCode | "unknown" {
  return cause instanceof CodeFlowError ? cause.code : "unknown";
}

export function CodeFlowProvider(props: CodeFlowProviderProps): ReactNode {
  const { session = null, onSelectNode, onModeChange, onPatched, onGraphSync, onReanalyze } = props;
  const graph = props.graph ?? session?.getGraph() ?? null;
  const registry = props.registry ?? session?.registry ?? null;

  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  const [internalMode, setInternalMode] = useState<DisclosureMode>(props.defaultMode ?? "expanded");
  const [focusedRange, setFocusedRange] = useState<SourceMapping | null>(null);
  const [patchError, setPatchError] = useState<PatchFailure | null>(null);
  const [lastPatch, setLastPatch] = useState<PatchSuccess | null>(null);
  const [changedNodeIds, setChangedNodeIds] = useState<Set<string>>(() => new Set());

  const selectedNodeId = props.selectedNodeId === undefined ? internalSelected : props.selectedNodeId;
  const mode = props.mode ?? internalMode;

  const index = useMemo(() => buildIndex(graph), [graph]);
  const nodeDiagnostics = useMemo(() => diagnosticsByNode(graph), [graph]);

  const source = props.source ?? graph?.source.content ?? "";
  const sourceDirty = graph !== null && source !== graph.source.content;

  // A new graph can retire the selected node (03 §5: identity is per-session).
  useEffect(() => {
    if (selectedNodeId !== null && !index.nodeById.has(selectedNodeId)) {
      setInternalSelected(null);
      onSelectNode?.(null);
    }
  }, [index, selectedNodeId, onSelectNode]);

  const selectNode = useCallback(
    (nodeId: string | null) => {
      setInternalSelected(nodeId);
      onSelectNode?.(nodeId);
      const node = nodeId === null ? null : index.nodeById.get(nodeId) ?? null;
      setFocusedRange(node?.source ?? null);
    },
    [index, onSelectNode],
  );

  const selectNodeAtOffset = useCallback(
    (offset: number) => {
      const node = nodeAtOffset(graph, offset);
      setInternalSelected(node?.id ?? null);
      onSelectNode?.(node?.id ?? null);
      // Highlight the owning range too; revealing is a no-op since the caret is
      // already inside it.
      setFocusedRange(node?.source ?? null);
      return node;
    },
    [graph, onSelectNode],
  );

  const setMode = useCallback(
    (next: DisclosureMode) => {
      setInternalMode(next);
      onModeChange?.(next);
    },
    [onModeChange],
  );

  /* --- editing ----------------------------------------------------------- */

  const disabledReason = useMemo(() => {
    if (props.editable === false) return "Editing is turned off by the host (`editable={false}`).";
    if (session === null) return "No session — editing goes through `CodeFlowSession.patchNode` (02 §4, 06 §4).";
    if (graph === null) return "Nothing analyzed yet — analyze a flow before editing.";
    if (onPatched === undefined) {
      return "The host did not wire `onPatched`, so a patched source would have nowhere to go — editing is disabled rather than silently discarded (07 §5).";
    }
    if (graph.registryHash !== session.registryHash()) {
      return "The registry changed since this graph was analyzed — re-analyze the flow before editing (06 §5).";
    }
    return null;
  }, [props.editable, session, graph, onPatched]);

  const editingEnabled = disabledReason === null;

  // Kept in a ref so the callbacks below stay stable across renders.
  const latest = useRef({ session, graph, registry, source, onPatched, onGraphSync });
  latest.current = { session, graph, registry, source, onPatched, onGraphSync };

  const patchNode = useCallback(
    async (nodeId: string, changes: Record<string, unknown>): Promise<PatchOutcome> => {
      const current = latest.current;
      if (current.session === null || current.graph === null || current.onPatched === undefined) {
        const failure: PatchFailure = {
          nodeId,
          code: "unknown",
          message: disabledReason ?? EDITING_DISABLED_REASON,
        };
        setPatchError(failure);
        return { ok: false, ...failure };
      }
      try {
        const result = await current.session.patchNode(nodeId, changes, { source: current.source });
        setPatchError(null);
        // The node that was edited, plus anything the patch added. Deliberately
        // not every `node.updated`: shifting a range by five characters marks
        // every node after the edit as updated, and highlighting all of them
        // would say "these changed" about nodes whose code did not.
        const touched = new Set<string>([nodeId]);
        for (const change of result.changes) {
          if (change.type === "node.added" && change.nodeId !== undefined) touched.add(change.nodeId);
        }
        setLastPatch({
          nodeId,
          nodeIds: [...touched],
          patches: result.patches,
          diagnostics: result.diagnostics,
          changes: result.changes,
          at: Date.now(),
        });
        setChangedNodeIds(touched);
        current.onPatched(result);
        return { ok: true, result };
      } catch (cause) {
        const failure: PatchFailure = { nodeId, code: codeOf(cause), message: messageOf(cause) };
        setPatchError(failure);
        // The conflict path re-analyzes before refusing (06 §5), so the session
        // may now hold a graph the host is not rendering. Say so rather than
        // leaving the two silently out of step.
        const moved = current.session.getGraph();
        if (moved !== null && moved !== current.graph) current.onGraphSync?.(moved);
        return { ok: false, ...failure };
      }
    },
    [disabledReason],
  );

  /**
   * The same computation `patchNode` runs, stopped before the commit (06 §4) —
   * this is what "preview diff before apply" shows. It runs against the analyzed
   * source, so a conflict with unanalyzed editor text only surfaces on apply.
   */
  const previewPatch = useCallback((nodeId: string, changes: Record<string, unknown>): PreviewOutcome => {
    const current = latest.current;
    if (current.graph === null || current.registry === null) {
      return { ok: false, code: "unknown", message: "Nothing analyzed yet — there is no source to diff against." };
    }
    try {
      const computed = computePatch({
        graph: current.graph,
        registry: current.registry,
        nodeId,
        changes,
      });
      return { ok: true, patches: computed.patches, diagnostics: computed.diagnostics };
    } catch (cause) {
      return { ok: false, code: codeOf(cause), message: messageOf(cause) };
    }
  }, []);

  const clearPatchError = useCallback(() => { setPatchError(null); }, []);
  const requestReanalyze = useCallback(() => {
    setPatchError(null);
    onReanalyze?.();
  }, [onReanalyze]);

  const value = useMemo<CodeFlowContextValue>(
    () => ({
      graph,
      session,
      registry,
      index,
      nodeDiagnostics,
      selectedNodeId,
      selectedNode: selectedNodeId === null ? null : index.nodeById.get(selectedNodeId) ?? null,
      selectNode,
      selectNodeAtOffset,
      mode,
      setMode,
      focusedRange,
      focusRange: setFocusedRange,
      editingEnabled,
      editingDisabledReason: disabledReason ?? "",
      source,
      sourceDirty,
      patchNode,
      previewPatch,
      lastPatch,
      patchError,
      clearPatchError,
      changedNodeIds,
      requestReanalyze,
      canReanalyze: onReanalyze !== undefined,
    }),
    [
      graph,
      session,
      registry,
      index,
      nodeDiagnostics,
      selectedNodeId,
      selectNode,
      selectNodeAtOffset,
      mode,
      setMode,
      focusedRange,
      editingEnabled,
      disabledReason,
      source,
      sourceDirty,
      patchNode,
      previewPatch,
      lastPatch,
      patchError,
      clearPatchError,
      changedNodeIds,
      requestReanalyze,
      onReanalyze,
    ],
  );

  return <CodeFlowContext.Provider value={value}>{props.children}</CodeFlowContext.Provider>;
}
