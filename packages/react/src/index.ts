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
  RunView,
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
export { useDiagnosticCounts } from "./diagnostics/use-diagnostic-counts.js";
export type { DiagnosticsPanelProps } from "./diagnostics/DiagnosticsPanel.js";

export { DisclosureToggle } from "./controls/DisclosureToggle.js";
export { DataLinksToggle } from "./controls/DataLinksToggle.js";
export type { DataLinksToggleProps } from "./controls/DataLinksToggle.js";
export { ThemeToggle } from "./controls/ThemeToggle.js";
export { applyTheme, useTheme } from "./controls/theme.js";
export type { CodeFlowTheme } from "./controls/theme.js";

export { CodeFlowNode, CodeFlowContainerNode } from "./flow/nodes.js";

/* --- the node editor (07 §4) ---------------------------------------------
 * The three-pane editor is mounted by `<CodeFlowProvider>` itself, so a host
 * needs no wiring: double-click a step on the canvas, or press "Open editor" in
 * the inspector. It is exported anyway for a host that wants to drive it (open
 * it from its own chrome, or render it against a fixed node).
 */

export { NodeEditor } from "./editor/NodeEditor.js";
export type { NodeEditorProps } from "./editor/NodeEditor.js";
export { PreviewValue } from "./editor/PreviewValue.js";
export type { PreviewValueProps } from "./editor/PreviewValue.js";

export {
  scopeRows,
  groupScope,
  describeSchema,
  sampleForSchema,
  rowValueText,
} from "./editor/scope-rows.js";
export type { ScopeRow, ScopeRowsOptions, ScopeGroups, ValueSource } from "./editor/scope-rows.js";
export { dropInto, canDrop, rootNameOf } from "./editor/drop.js";
export type { DropOutcome, DropRefusal, DropResult, DropOptions, DropCheck } from "./editor/drop.js";
export {
  resultItems,
  iterationLabel,
  traceNotice,
  observedAt,
  unwrapPreview,
  previewOrigin,
  declaredOutput,
  LATEST_LABEL,
} from "./editor/result.js";
export type { ResultItem, TraceNotice, DeclaredOutput } from "./editor/result.js";
export { pickPreviewRenderer, previewText, mediaTypeOf } from "./editor/preview.js";
export type { PreviewRenderer, PreviewContext } from "./editor/preview.js";

/* --- the node renderer seam (`NodeDefinition.renderer`, 05 §1) ------------ */

export { resolveNodeRenderer, rendererMeasurer, DEFAULT_NODE_BODY_HEIGHT } from "./flow/renderer.js";
export { runBadgeKind, isCompleted } from "./flow/run-badge.js";
export type { RunBadgeKind } from "./flow/run-badge.js";
export type { NodeBodyProps, NodeBodySpec, NodeBodyRenderer, ResolvedNodeRenderer } from "./flow/renderer.js";

/* --- design system -------------------------------------------------------
 * shadcn-shaped components over Base UI primitives. Exported so a host app can
 * build its own chrome (top bar, panels, empty states) out of the same buttons,
 * selects and notices the library uses, instead of approximating them.
 */

export { cn } from "./ui/cn.js";
export { Button } from "./ui/button.js";
export { buttonVariants } from "./ui/button-variants.js";
export type { ButtonProps } from "./ui/button.js";
export { Badge, Kbd } from "./ui/badge.js";
export { badgeVariants } from "./ui/badge-variants.js";
export type { BadgeProps } from "./ui/badge.js";
export { Field, FieldHint, FieldLabel, Input, Textarea } from "./ui/input.js";
export type { InputProps, TextareaProps } from "./ui/input.js";
export { Select } from "./ui/select.js";
export type { SelectOption, SelectProps } from "./ui/select.js";
export { Modal, Sheet } from "./ui/dialog.js";
export { DialogPrimitive } from "./ui/dialog-primitive.js";
export type { ModalProps, SheetProps } from "./ui/dialog.js";
export { Popover } from "./ui/popover.js";
export type { PopoverProps } from "./ui/popover.js";
export { Segmented } from "./ui/segmented.js";
export type { SegmentedItem, SegmentedProps } from "./ui/segmented.js";
export { Hint, TooltipProvider } from "./ui/tooltip.js";
export type { HintProps } from "./ui/tooltip.js";
export { Notice, EngineNotice } from "./ui/notice.js";
export type { NoticeProps, NoticeTone } from "./ui/notice.js";
export { ToastHost } from "./ui/toast.js";
export { useToast } from "./ui/use-toast.js";

export { diagnosticHeadline, errorHeadline, humanFieldLabel, nodeTypeName, splitSpecRefs } from "./copy.js";
export type { SplitMessage } from "./copy.js";

export { NodeGlyph, RegistryGlyph } from "./flow/glyphs.js";
export { nodeVisual, REGISTRY_ICONS } from "./flow/visual.js";
export type { NodeVisual, NodeVisualType } from "./flow/visual.js";

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
  dataEdgeState,
  dataEdgeClassName,
  dataEdgeVisuals,
  NODE_TYPE_LEAF,
  NODE_TYPE_CONTAINER,
} from "./flow/to-react-flow.js";

export {
  buildDataLinks,
  resolveDataEdgeMode,
  takesLines,
  takesText,
  EMPTY_DATA_LINKS,
  MAX_TAKES_ROWS,
} from "./flow/data-links.js";
export type { DataLink, NodeDataLinks, DataEdgeMode } from "./flow/data-links.js";

export {
  autoCollapse,
  ancestorsOf,
  buildCollapseView,
  expandFor,
  innerCounts,
  insideLabel,
  isSameFlow,
  standIn,
  SAME_FLOW_OVERLAP,
  EMPTY_COLLAPSE,
  FOLD_ABOVE,
  FOLD_MIN_INNER,
  FOLD_TRY_MAX_SHARE,
} from "./flow/collapse.js";
export type { CollapseView, AutoCollapseOptions } from "./flow/collapse.js";
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
export { measureNode, isMinorNode, CONTAINER_PADDING, CONTAINER_MIN_SIZE } from "./layout/measure.js";
export type { NodeSize, Measurer } from "./layout/measure.js";

export {
  nodeIcon,
  nodeCaption,
  nodeKindLabel,
  nodeTitle,
  plainCondition,
  nodeSummaryRows,
  takesRows,
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
