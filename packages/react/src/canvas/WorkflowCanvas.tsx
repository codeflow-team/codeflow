/**
 * `<WorkflowCanvas>` — React Flow canvas over a `WorkflowGraph` (07 §1, §2).
 *
 * Positions come from ELK on every (graph, mode) change; dragging a node is a
 * purely visual act that is deliberately not persisted (03 §8).
 */

import { useCallback, useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
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
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
};

const MINIMAP_COLORS: Record<string, string> = {
  trigger: "#22a06b",
  tool: "#3b82f6",
  function: "#8b5cf6",
  condition: "#f59e0b",
  loop: "#0ea5e9",
  try: "#f97316",
  parallel: "#14b8a6",
  merge: "#94a3b8",
  jump: "#a855f7",
  output: "#ef4444",
  code: "#64748b",
  unknown: "#dc2626",
};

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
    <div className={`cf-canvas ${props.className ?? ""}`} style={props.style} data-pending={pending ? "true" : "false"}>
      {graph === null ? (
        <p className="cf-empty">No graph yet — analyze a flow to see it here.</p>
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
          {(props.background ?? true) ? <Background variant={BackgroundVariant.Dots} gap={18} size={1} /> : null}
          {(props.controls ?? true) ? <Controls showInteractive={false} /> : null}
          {(props.minimap ?? true) ? (
            <MiniMap
              pannable
              zoomable
              nodeColor={(node) => MINIMAP_COLORS[String((node.data as { node?: { type?: string } }).node?.type ?? "")] ?? "#94a3b8"}
            />
          ) : null}
        </ReactFlow>
      )}
      {pending ? <span className="cf-canvas__status">laying out…</span> : null}
      {error !== null ? <span className="cf-canvas__status cf-canvas__status--error">layout failed: {error.message}</span> : null}
    </div>
  );
}
