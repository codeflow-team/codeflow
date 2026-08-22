/**
 * `<CodeFlowProvider>` — the single place UI state lives (07 §2).
 *
 * Everything held here is **view state** (03 §8): selection, disclosure level,
 * the source range the code panel should reveal. None of it is derived back into
 * the graph, and none of it is persisted — the graph stays a pure projection of
 * source.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  CodeFlowSession,
  Diagnostic,
  RegistryLookup,
  SourceMapping,
  WorkflowGraph,
  WorkflowNode,
} from "@codeflow/core";
import { buildIndex, diagnosticsByNode, nodeAtOffset, type GraphIndex } from "../graph/index.js";
import type { DisclosureMode } from "../flow/summary.js";

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

  /**
   * Phase 6a is read-only: the patch engine (06) is not wired yet, so every
   * inspector field renders disabled with this reason as its tooltip.
   */
  editingEnabled: boolean;
  editingDisabledReason: string;
}

export const EDITING_DISABLED_REASON = "Editing lands with the patch engine";

const CodeFlowContext = createContext<CodeFlowContextValue | null>(null);

export interface CodeFlowProviderProps {
  /** The graph to display. Falls back to `session.getGraph()` when omitted. */
  graph?: WorkflowGraph | null;
  /** Session the graph came from — the one source for registry + future patching (02 §4). */
  session?: CodeFlowSession | null;
  /** Registry override; defaults to `session.registry`. */
  registry?: RegistryLookup | null;
  defaultMode?: DisclosureMode;
  /** Controlled disclosure level. */
  mode?: DisclosureMode;
  onModeChange?: (mode: DisclosureMode) => void;
  selectedNodeId?: string | null;
  onSelectNode?: (nodeId: string | null) => void;
  children: ReactNode;
}

export function CodeFlowProvider(props: CodeFlowProviderProps): ReactNode {
  const { session = null, onSelectNode, onModeChange } = props;
  const graph = props.graph ?? session?.getGraph() ?? null;
  const registry = props.registry ?? session?.registry ?? null;

  const [internalSelected, setInternalSelected] = useState<string | null>(null);
  const [internalMode, setInternalMode] = useState<DisclosureMode>(props.defaultMode ?? "expanded");
  const [focusedRange, setFocusedRange] = useState<SourceMapping | null>(null);

  const selectedNodeId = props.selectedNodeId === undefined ? internalSelected : props.selectedNodeId;
  const mode = props.mode ?? internalMode;

  const index = useMemo(() => buildIndex(graph), [graph]);
  const nodeDiagnostics = useMemo(() => diagnosticsByNode(graph), [graph]);

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
      editingEnabled: false,
      editingDisabledReason: EDITING_DISABLED_REASON,
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
    ],
  );

  return <CodeFlowContext.Provider value={value}>{props.children}</CodeFlowContext.Provider>;
}

export function useCodeFlow(): CodeFlowContextValue {
  const value = useContext(CodeFlowContext);
  if (value === null) throw new Error("useCodeFlow must be used inside <CodeFlowProvider>");
  return value;
}

export function useSelectedNode(): WorkflowNode | null {
  return useCodeFlow().selectedNode;
}

export function useNodeDiagnostics(nodeId: string | null): Diagnostic[] {
  const { nodeDiagnostics } = useCodeFlow();
  if (nodeId === null) return [];
  return nodeDiagnostics.get(nodeId) ?? [];
}
