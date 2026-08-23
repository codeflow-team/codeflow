/**
 * `<WorkflowCanvas>` — React Flow canvas over a `WorkflowGraph` (07 §1, §2).
 *
 * Positions come from ELK on every (graph, mode) change; dragging a node is a
 * purely visual act that is deliberately not persisted (03 §8).
 */

import { useCallback, useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type NodeMouseHandler,
  type NodeTypes,
} from "@xyflow/react";
import { LoaderCircle, TriangleAlert, Workflow } from "lucide-react";
import { useCodeFlow } from "../context/hooks.js";
import type { DisclosureMode } from "../flow/summary.js";
import { CodeFlowContainerNode, CodeFlowNode } from "../flow/nodes.js";
import {
  NODE_TYPE_CONTAINER,
  NODE_TYPE_LEAF,
  toReactFlow,
  type CodeFlowRFEdge,
  type CodeFlowRFNode,
} from "../flow/to-react-flow.js";
import { useElkLayout } from "../layout/use-layout.js";
import type { LayoutDirection } from "../layout/elk-graph.js";

const nodeTypes: NodeTypes = {
  [NODE_TYPE_LEAF]: CodeFlowNode,
  [NODE_TYPE_CONTAINER]: CodeFlowContainerNode,
};

const defaultEdgeOptions = {
  markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color: "var(--cf-border-strong)" },
  pathOptions: { borderRadius: 14 },
};

const MINIMAP_TYPES = new Set([
  "trigger",
  "tool",
  "function",
  "condition",
  "loop",
  "try",
  "parallel",
  "merge",
  "jump",
  "output",
  "code",
  "unknown",
]);

/**
 * The minimap paints in the same token as the node it stands for, by reference
 * rather than by copy — an SVG `fill` resolves `var()`, so the map follows a
 * theme swap with everything else instead of holding a second palette.
 */
function minimapColor(type: string): string {
  return MINIMAP_TYPES.has(type) ? `var(--cf-${type})` : "var(--cf-merge)";
}

export interface WorkflowCanvasProps {
  /** Overrides the provider-wide disclosure level for this canvas only. */
  mode?: DisclosureMode;
  direction?: LayoutDirection;
  minimap?: boolean;
  controls?: boolean;
  background?: boolean;
  fitView?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function WorkflowCanvas(props: WorkflowCanvasProps): ReactNode {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

function CanvasInner(props: WorkflowCanvasProps): ReactNode {
  const { graph, index, nodeDiagnostics, mode: providerMode, selectedNodeId, selectNode } = useCodeFlow();
  const mode = props.mode ?? providerMode;
  const direction = props.direction ?? "DOWN";

  const { layout, pending, error } = useElkLayout(graph, { mode, direction });

  const mapped = useMemo(() => {
    if (graph === null) return { nodes: [] as CodeFlowRFNode[], edges: [] as CodeFlowRFEdge[] };
    const { nodes, edges } = toReactFlow(graph, {
      mode,
      boxes: layout?.boxes ?? null,
      diagnostics: nodeDiagnostics,
      index,
      selectedNodeId,
    });
    return { nodes, edges };
    // `selectedNodeId` intentionally excluded: selection is applied below so a
    // click does not force a full re-map of every node.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, mode, layout, nodeDiagnostics, index]);

  const [nodes, setNodes, onNodesChange] = useNodesState<CodeFlowRFNode>(mapped.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CodeFlowRFEdge>(mapped.edges);

  const { fitView } = useReactFlow();

  useEffect(() => {
    setNodes(mapped.nodes);
    setEdges(mapped.edges);
    if (mapped.nodes.length === 0 || props.fitView === false) return;
    // ELK just moved everything; refit once the new positions are committed.
    const frame = requestAnimationFrame(() => { void fitView({ padding: 0.12, duration: 200 }); });
    return () => { cancelAnimationFrame(frame); };
  }, [mapped, setNodes, setEdges, fitView, props.fitView]);

  useEffect(() => {
    setNodes((current) =>
      current.map((node) => (node.selected === (node.id === selectedNodeId) ? node : { ...node, selected: node.id === selectedNodeId })),
    );
  }, [selectedNodeId, setNodes]);

  /**
   * Refit when the canvas itself changes size.
   *
   * The diagram is the window's main object, so a narrower window should show
   * the same flow smaller rather than the same flow half off-screen. React Flow
   * only fits on mount, so the observer supplies the rest.
   */
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const element = wrapperRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    let first = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (first) { first = false; return; }
      clearTimeout(timer);
      timer = setTimeout(() => { void fitView({ padding: 0.14, duration: 200 }); }, 140);
    });
    observer.observe(element);
    return () => { observer.disconnect(); clearTimeout(timer); };
  }, [fitView]);

  const onNodeClick = useCallback<NodeMouseHandler<CodeFlowRFNode>>(
    (_event, node) => {
      selectNode(node.id);
    },
    [selectNode],
  );

  const onPaneClick = useCallback(() => {
    selectNode(null);
  }, [selectNode]);

  return (
    <div
      ref={wrapperRef}
      className={`cf-canvas ${props.className ?? ""}`}
      style={props.style}
      data-pending={pending ? "true" : "false"}
    >
      {graph === null ? (
        <div className="grid h-full place-items-center p-8">
          <div className="flex max-w-sm flex-col items-center gap-3 text-center">
            <span className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-ink-faint ring-1 ring-line">
              <Workflow className="size-6" />
            </span>
            <div>
              <p className="m-0 text-[15px] font-semibold tracking-[-0.01em] text-ink">No workflow yet</p>
              <p className="m-0 mt-1 text-[12.5px] leading-relaxed text-ink-dim">
                Open a flow file and its steps appear here — the diagram is read straight from the code, so the two can
                never disagree.
              </p>
            </div>
          </div>
        </div>
      ) : (
        <ReactFlow<CodeFlowRFNode, CodeFlowRFEdge>
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={onNodeClick}
          onPaneClick={onPaneClick}
          fitView={props.fitView ?? true}
          fitViewOptions={{ padding: 0.15 }}
          minZoom={0.15}
          maxZoom={2}
          proOptions={{ hideAttribution: false }}
        >
          {(props.background ?? true) ? <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} /> : null}
          {(props.controls ?? true) ? (
            <Controls showInteractive={false} position="bottom-right" className="!bottom-3 !right-3" />
          ) : null}
          {/* A minimap earns its space once the flow stops fitting on screen;
              below that it is decoration over a diagram the user can already
              see all of. */}
          {(props.minimap ?? graph.nodes.length > 12) ? (
            <MiniMap
              pannable
              zoomable
              position="top-right"
              className="!m-3 hidden !h-20 !w-32 opacity-80 transition-opacity hover:opacity-100 xl:!block"
              maskStrokeWidth={2}
              nodeColor={(node) => minimapColor(String((node.data as { node?: { type?: string } }).node?.type ?? ""))}
              nodeStrokeWidth={0}
              nodeBorderRadius={3}
            />
          ) : null}
        </ReactFlow>
      )}

      {pending ? (
        <span className="pointer-events-none absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-surface/85 px-2.5 py-1 text-[11px] font-medium text-ink-dim shadow-xs backdrop-blur">
          <LoaderCircle className="size-3 animate-spin" />
          Arranging steps…
        </span>
      ) : null}
      {error !== null ? (
        <span className="absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-danger/40 bg-danger-soft px-2.5 py-1 text-[11px] font-medium text-danger shadow-xs">
          <TriangleAlert className="size-3" />
          Could not arrange the diagram — {error.message}
        </span>
      ) : null}
    </div>
  );
}
