/**
 * @codeflow/react — UI layer (07-ui.md).
 *
 * Phase 6a covers the read/display half: provider + state, React Flow canvas
 * with hierarchical ELK layout, the three disclosure levels, inspector, Monaco
 * code panel with two-way selection sync, and the diagnostics panel.
 *
 * Editing is deliberately inert until the patch engine (06-patch-engine.md)
 * lands: inspector controls render disabled with a reason instead of pretending
 * to work (07 §5 — never fail silently, never approximate).
 *
 * Host apps must also import the stylesheets:
 *   import "@xyflow/react/dist/style.css";
 *   import "@codeflow/react/styles.css";
 */

export {
  CodeFlowProvider,
  useCodeFlow,
  useSelectedNode,
  useNodeDiagnostics,
  EDITING_DISABLED_REASON,
} from "./context/provider.js";
export type { CodeFlowContextValue, CodeFlowProviderProps } from "./context/provider.js";

export { WorkflowCanvas } from "./canvas/WorkflowCanvas.js";
export type { WorkflowCanvasProps } from "./canvas/WorkflowCanvas.js";

export { NodeInspector } from "./inspector/NodeInspector.js";
export type { NodeInspectorProps } from "./inspector/NodeInspector.js";

export { CodePanel } from "./code/CodePanel.js";
export type { CodePanelProps } from "./code/CodePanel.js";

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
export type { InspectorField, InspectorModel } from "./inspector/fields.js";
