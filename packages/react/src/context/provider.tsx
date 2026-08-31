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
import { buildDataLinks, resolveDataEdgeMode, type DataEdgeMode } from "../flow/data-links.js";
import { autoCollapse, buildCollapseView, expandFor, isSameFlow } from "../flow/collapse.js";
import { EDITING_DISABLED_REASON } from "./types.js";
import { NodeEditor } from "../editor/NodeEditor.js";
import type { PreviewRenderer } from "../editor/preview.js";
import type {
  CodeFlowContextValue,
  RunView,
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
  /**
   * Start with every data edge drawn. Off by default — see
   * `CodeFlowContextValue.showDataLinks` for why.
   */
  defaultShowDataLinks?: boolean;
  /**
   * Let a large flow arrive with its containers folded. On by default — see
   * `flow/collapse.ts` for why a 101-step flow drawn whole is not readable.
   * `false` keeps every box open, which is the right choice for a host that
   * only ever shows small flows.
   */
  autoCollapse?: boolean;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  /**
   * What a runtime is reporting about the flow right now (09 §1).
   *
   * The library never executes anything — this is the host handing over the
   * result of folding `RunEvent`s with `summarizeRun`, and the canvas renders
   * it. `null` (the default) means "no run has happened", which is a different
   * thing from "the run reached nothing".
   */
  run?: RunView | null;
  /**
   * Host renderers for emit payloads and observed values, in priority order —
   * the `previewRenderers` half of the renderer seam (`editor/preview.ts`).
   *
   * The library ships exactly one built-in (readable JSON/text) and uses it as
   * the fallback, so a value always renders even with this left unset.
   */
  previewRenderers?: readonly PreviewRenderer[];
  children: ReactNode;
}

/** Stable identity, so an unset `previewRenderers` never re-renders consumers. */
const EMPTY_RENDERERS: readonly PreviewRenderer[] = [];

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
  const [showDataLinks, setShowDataLinks] = useState<boolean>(props.defaultShowDataLinks ?? false);
  const [focusedRange, setFocusedRange] = useState<SourceMapping | null>(null);
  const [patchError, setPatchError] = useState<PatchFailure | null>(null);
  const [lastPatch, setLastPatch] = useState<PatchSuccess | null>(null);
  const [changedNodeIds, setChangedNodeIds] = useState<Set<string>>(() => new Set());
  const [editorNodeId, setEditorNodeId] = useState<string | null>(null);

  const selectedNodeId = props.selectedNodeId === undefined ? internalSelected : props.selectedNodeId;
  const mode = props.mode ?? internalMode;

  const index = useMemo(() => buildIndex(graph), [graph]);
  const nodeDiagnostics = useMemo(() => diagnosticsByNode(graph), [graph]);
  const dataLinks = useMemo(() => buildDataLinks(graph, index), [graph, index]);

  /* --- folding (flow/collapse.ts) ---------------------------------------- */

  const [collapsedNodeIds, setCollapsedNodeIds] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  /**
   * Which graph the current folds belong to.
   *
   * Adjusted *during render* rather than in an effect on purpose: a flow that
   * folds one commit after it first paints would draw all 101 steps, re-run
   * ELK, and redraw — a visible flash of the exact picture folding exists to
   * avoid. `undefined` is the "nothing seen yet" sentinel, distinct from the
   * `null` that means "nothing analyzed".
   */
  const [foldedGraph, setFoldedGraph] = useState<WorkflowGraph | null | undefined>(undefined);
  if (foldedGraph !== graph) {
    setFoldedGraph(graph);
    if (graph === null) {
      if (collapsedNodeIds.size > 0) setCollapsedNodeIds(new Set<string>());
    } else if (isSameFlow(foldedGraph, graph)) {
      // The same flow, analyzed again: an edit can retire a node id, and a fold
      // on an id that no longer exists would silently hide nothing. Folding is
      // *not* recomputed — the user may have opened boxes by hand, and undoing
      // that on every keystroke would be the app arguing with them.
      const kept = new Set<string>();
      for (const id of collapsedNodeIds) if (index.containerIds.has(id)) kept.add(id);
      if (kept.size !== collapsedNodeIds.size) setCollapsedNodeIds(kept);
    } else {
      // A different flow — the only moment folding is decided for the user.
      setCollapsedNodeIds(props.autoCollapse === false ? new Set<string>() : autoCollapse(index));
    }
  }

  const collapse = useMemo(() => buildCollapseView(index, collapsedNodeIds), [index, collapsedNodeIds]);

  const toggleCollapsed = useCallback((nodeId: string) => {
    setCollapsedNodeIds((current) => {
      const next = new Set(current);
      if (!next.delete(nodeId)) next.add(nodeId);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => { setCollapsedNodeIds(new Set<string>()); }, []);
  const collapseAll = useCallback(() => {
    setCollapsedNodeIds(new Set(index.containerIds));
  }, [index]);

  /**
   * A selected step is never inside a closed box.
   *
   * This one effect is what makes folding safe, because *everything* that can
   * point at a step arrives here: the outline, the code panel's caret, a
   * diagnostic, the step a failed run ended on, and a click on the canvas. The
   * folds between the step and the canvas open, and the existing pan-to-
   * selection does the rest. Without it, "select this step" could silently
   * resolve to nothing on screen — which is exactly the kind of quiet failure
   * 07 §5 forbids.
   */
  useEffect(() => {
    if (selectedNodeId === null) return;
    setCollapsedNodeIds((current) => expandFor(selectedNodeId, index, current) ?? current);
  }, [selectedNodeId, index]);

  /**
   * Neither is the step that is running right now (09 §1).
   *
   * A run is the one moment the canvas is *watched* rather than read, and a
   * summary box saying "12 steps inside" while one of those twelve is executing
   * would be showing the least useful thing at the most useful moment. Only the
   * folds the run actually enters open, once each, so a loop that runs twenty
   * times costs one re-layout and the branches never taken stay folded.
   */
  const activeNodeId = props.run?.activeNodeId ?? null;
  useEffect(() => {
    if (activeNodeId === null) return;
    setCollapsedNodeIds((current) => expandFor(activeNodeId, index, current) ?? current);
  }, [activeNodeId, index]);

  /**
   * Nor is a step an edit just added or changed.
   *
   * Inserting a step into a folded loop and being told "13 steps inside" is a
   * true sentence and a useless one: the user is looking for the thing they
   * just made. The green "changed" marker is on it, so the box it is in opens.
   */
  useEffect(() => {
    if (changedNodeIds.size === 0) return;
    setCollapsedNodeIds((current) => {
      let next = current;
      for (const id of changedNodeIds) next = expandFor(id, index, next) ?? next;
      return next;
    });
  }, [changedNodeIds, index]);

  /*
   * Select-to-reveal is the *rule*, at every level; the levels only differ in
   * what is drawn when nothing is selected — 07 §4 read onto three levels:
   *
   *   Simple  — nothing by default; the selected step's own values on click.
   *   Details — the same.
   *   Code    — the same, plus "Show data links" for someone who wants all of it.
   *
   * An earlier pass made Simple mean "no data edges *ever*", and that was the
   * wrong reading of "progressive disclosure". The question a beginner asks
   * first is "where does this step get its input from" — pointing at a step and
   * seeing four or seven lines appear is the answer, and four lines do not
   * clutter anything. What clutters is the hundred and seventy drawn at once,
   * and those are still off until the toggle says otherwise.
   *
   * Nothing is lost when they are hidden either: the provenance a hidden edge
   * carried is written on the card as `Takes  rows ← Read Text File`.
   */
  const dataEdgeMode: DataEdgeMode = resolveDataEdgeMode(showDataLinks);

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

  /* --- the node editor --------------------------------------------------- */

  /**
   * Opening the editor selects the step too.
   *
   * The editor and the canvas are two views of one thing, and a user who closes
   * the editor should find the step they were configuring still selected —
   * otherwise the diagram silently disagrees with what they were just doing.
   */
  const openNodeEditor = useCallback(
    (nodeId: string) => {
      setEditorNodeId(nodeId);
      setInternalSelected(nodeId);
      onSelectNode?.(nodeId);
    },
    [onSelectNode],
  );
  const closeNodeEditor = useCallback(() => { setEditorNodeId(null); }, []);

  // A re-analysis can retire the node the editor is open on (03 §5): closing is
  // the honest response — an editor pointed at nothing would show stale fields.
  useEffect(() => {
    if (editorNodeId !== null && !index.nodeById.has(editorNodeId)) setEditorNodeId(null);
  }, [index, editorNodeId]);

  const previewRenderers = props.previewRenderers ?? EMPTY_RENDERERS;

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
      showDataLinks,
      setShowDataLinks,
      dataEdgeMode,
      dataLinks,
      collapse,
      collapsedNodeIds,
      toggleCollapsed,
      expandAll,
      collapseAll,
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
      run: props.run ?? null,
      editorNodeId,
      openNodeEditor,
      closeNodeEditor,
      previewRenderers,
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
      showDataLinks,
      dataEdgeMode,
      dataLinks,
      collapse,
      collapsedNodeIds,
      toggleCollapsed,
      expandAll,
      collapseAll,
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
      props.run,
      editorNodeId,
      openNodeEditor,
      closeNodeEditor,
      previewRenderers,
    ],
  );

  return (
    <CodeFlowContext.Provider value={value}>
      {props.children}
      {/*
        The node editor is mounted here, not by the host.

        It is the surface a non-developer connects two steps in, and a feature
        that only appears when an app remembers to render it is a feature most
        apps ship without. Nothing is drawn until a step's editor is opened.
      */}
      <NodeEditor />
    </CodeFlowContext.Provider>
  );
}
