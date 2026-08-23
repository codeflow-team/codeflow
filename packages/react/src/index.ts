/**
 * @codeflow/react — UI layer (07-ui.md).
 *
 * Phase 6a covered the read half: provider + state, React Flow canvas with
 * hierarchical ELK layout, the three disclosure levels, inspector, Monaco code
 * panel with two-way selection sync, and the diagnostics panel.
 *
 * Phase 6b wires the patch engine (06) to it: editable fields, conditions and
 * iterables, delete with its dependency check, palette insert, tool change,
 * opaque-region editing through Monaco, and a diff preview. Every operation the
 * MVP does not support renders as a disabled control with the reason next to it
 * — 07 §5 forbids failing silently or approximating.
 *
 * Host apps must also import the stylesheets:
 *   import "@xyflow/react/dist/style.css";
 *   import "@codeflow/react/styles.css";
 */

export { CodeFlowProvider } from "./context/provider.js";
export type { CodeFlowProviderProps } from "./context/provider.js";
export {
  useCodeFlow,
  useOptionalCodeFlow,
  useSelectedNode,
  useNodeDiagnostics,
} from "./context/hooks.js";
export { EDITING_DISABLED_REASON } from "./context/types.js";
export type {
  CodeFlowContextValue,
  PatchFailure,
  PatchSuccess,
  PatchOutcome,
  PreviewOutcome,
} from "./context/types.js";

export { WorkflowCanvas } from "./canvas/WorkflowCanvas.js";
export type { WorkflowCanvasProps } from "./canvas/WorkflowCanvas.js";

export { NodeInspector } from "./inspector/NodeInspector.js";
export type { NodeInspectorProps } from "./inspector/NodeInspector.js";

export { CodePanel } from "./code/CodePanel.js";
export type { CodePanelProps } from "./code/CodePanel.js";

export { CodeDialog } from "./code/CodeDialog.js";
export type { CodeDialogProps } from "./code/CodeDialog.js";
export { nodeRegionText, localFunctionBody } from "./code/region.js";

export { NodePalette } from "./palette/NodePalette.js";
export type { NodePaletteProps, InsertPlacement } from "./palette/NodePalette.js";

export { CodeDiff } from "./diff/CodeDiff.js";
export type { CodeDiffProps } from "./diff/CodeDiff.js";

export { DiagnosticsPanel } from "./diagnostics/DiagnosticsPanel.js";
export type { DiagnosticsPanelProps } from "./diagnostics/DiagnosticsPanel.js";

export { DisclosureToggle } from "./controls/DisclosureToggle.js";
export { ThemeToggle, applyTheme, useTheme } from "./controls/ThemeToggle.js";
export type { CodeFlowTheme } from "./controls/ThemeToggle.js";

export { CodeFlowNode, CodeFlowContainerNode } from "./flow/nodes.js";

/* --- adapters and pure helpers (also the unit-test surface) --------------- */

export {
  buildIndex,
  orderedNodes,
  diagnosticsByNode,
  nodeAtOffset,
  isContainerNode,
  isSlotEdge,
  parentIdOf,
  parentSlotOf,
  worstSeverity,
  CONTAINER_NODE_TYPES,
  CONTAINER_SLOTS,
} from "./graph/index.js";
export type { GraphIndex, ContainerSlot } from "./graph/index.js";

export {
  toReactFlow,
  slotHandleId,
  NODE_TYPE_LEAF,
  NODE_TYPE_CONTAINER,
} from "./flow/to-react-flow.js";
export type {
  CodeFlowNodeData,
  CodeFlowEdgeData,
  CodeFlowRFNode,
  CodeFlowRFEdge,
  ToReactFlowOptions,
  ToReactFlowResult,
} from "./flow/to-react-flow.js";

export { toElkGraph, collectLayout, ROOT_ID } from "./layout/elk-graph.js";
export type { ElkGraphOptions, ElkGraphResult, LayoutBox, LayoutDirection } from "./layout/elk-graph.js";
export { runLayout } from "./layout/run.js";
export type { LayoutResult } from "./layout/run.js";
export { useElkLayout } from "./layout/use-layout.js";
export type { UseElkLayoutOptions, UseElkLayoutState } from "./layout/use-layout.js";
export { measureNode, CONTAINER_PADDING, CONTAINER_MIN_SIZE } from "./layout/measure.js";
export type { NodeSize, Measurer } from "./layout/measure.js";

export {
  nodeIcon,
  nodeKindLabel,
  nodeSummaryRows,
  nodeSourceText,
  developerLines,
  rowsForMode,
} from "./flow/summary.js";
export type { DisclosureMode, SummaryRow } from "./flow/summary.js";

export { formatFieldValue } from "./inspector/expression.js";
export type { FieldDisplay, FieldDisplayKind } from "./inspector/expression.js";
export { resolveInspectorFields } from "./inspector/fields.js";
export type { InspectorField, InspectorModel, FieldPatchOp, CodeEditTarget } from "./inspector/fields.js";

export {
  editorSpecFor,
  encodeFieldValue,
  encodeAsTemplate,
  templateBodyFromDisplay,
  hasInterpolation,
  changesFor,
  mergeChanges,
  IMPLICIT_TEMPLATE_REFUSAL,
} from "./inspector/edit.js";
export type { FieldEditorKind, FieldEditorSpec, EncodeResult } from "./inspector/edit.js";

export { useDebounced } from "./util/use-debounced.js";
