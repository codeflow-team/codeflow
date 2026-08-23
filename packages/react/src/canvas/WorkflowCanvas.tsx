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
  dataEdgeClassName,
  dataEdgeState,
  dataEdgeVisuals,
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

/**
 * Fitting a flow is not the same as making it readable.
 *
 * A 200-line flow lays out tall and narrow, and fitting *all* of it into a
 * window means a scale at which every node is a grey smudge — technically the
 * whole graph, practically nothing. So the fit is floored: past that point it
 * shows the start of the flow at a size that can still be read, and the minimap,
 * the outline and the scroll wheel take over from there.
 */
const FIT = { minZoom: 0.42 } as const;

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


/** Outer bounds of the top-level nodes — children live inside their container. */
function rootBounds(
  nodes: readonly CodeFlowRFNode[],
): { x: number; y: number; width: number; height: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (node.parentId !== undefined) continue;
    const width = node.width ?? 200;
    const height = node.height ?? 60;
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface WorkflowCanvasProps {
  /** Overrides the provider-wide disclosure level for this canvas only. */
  mode?: DisclosureMode;
  direction?: LayoutDirection;
  minimap?: boolean;
  controls?: boolean;
  background?: boolean;
  fitView?: boolean;
  /**
   * Pan to the selected step when it is off-screen. On by default: on a long
   * flow, selection usually arrives from somewhere that is not the canvas (the
   * outline, the diagnostics list, the code panel), and a selection the user
   * cannot see is not a selection.
   */
  focusSelection?: boolean;
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
  const {
    graph,
    index,
    nodeDiagnostics,
    mode: providerMode,
    selectedNodeId,
    selectNode,
    dataEdgeMode,
    dataLinks,
  } = useCodeFlow();
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
      dataEdges: dataEdgeMode,
      dataLinks,
    });
    return { nodes, edges };
    /*
     * `selectedNodeId` and `dataEdgeMode` are intentionally excluded.
     *
     * Both are re-applied by the effects below, over the edges that already
     * exist. Putting them in here would rebuild `mapped`, and a new `mapped` is
     * what triggers the re-fit — so turning "Show data links" on would throw
     * away the pan and zoom the user had set, which is the opposite of what a
     * view switch should do to a view.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, mode, layout, nodeDiagnostics, index, dataLinks]);

  const [nodes, setNodes, onNodesChange] = useNodesState<CodeFlowRFNode>(mapped.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<CodeFlowRFEdge>(mapped.edges);

  const { fitView, setCenter, getViewport, getInternalNode } = useReactFlow();

  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setNodes(mapped.nodes);
    setEdges(mapped.edges);
    if (mapped.nodes.length === 0 || props.fitView === false) return;
    // ELK just moved everything; refit once the new positions are committed.
    const frame = requestAnimationFrame(() => {
      void fitView({ ...FIT, padding: 0.12, duration: 200 });
      /**
       * When the fit hit its floor the diagram is taller than the window, and
       * centring it would open the flow somewhere in the middle of itself. A
       * flow is read from the start, so the view is nudged to the top instead.
       */
      window.setTimeout(() => {
        const element = wrapperRef.current;
        const bounds = rootBounds(mapped.nodes);
        if (element === null || bounds === null) return;
        const rect = element.getBoundingClientRect();
        const { zoom } = getViewport();
        if (bounds.height * zoom <= rect.height) return;
        setCenter(
          bounds.x + bounds.width / 2,
          bounds.y + rect.height / (2 * zoom) - 24 / zoom,
          { zoom, duration: 220 },
        );
      }, 260);
    });
    return () => { cancelAnimationFrame(frame); };
  }, [mapped, setNodes, setEdges, fitView, getViewport, setCenter, props.fitView]);

  useEffect(() => {
    setNodes((current) =>
      current.map((node) => (node.selected === (node.id === selectedNodeId) ? node : { ...node, selected: node.id === selectedNodeId })),
    );
  }, [selectedNodeId, setNodes]);

  /**
   * Selecting a step reveals *its* values, and only its values.
   *
   * This is the half of the data layer that earns its ink: the flow-wide view
   * is a control spine, and the moment someone points at one step the diagram
   * answers "where did this get its input, and who uses its output" with real
   * lines. Applied here rather than in the mapping memo so a click costs one
   * pass over the edges instead of a full re-map and a re-layout of 101 nodes —
   * and so that switching the view never moves the view.
   *
   * `mapped` is a dependency because a fresh mapping resets the edges to
   * whatever `toReactFlow` decided; this pass is what puts the current
   * selection and the current toggle back on top of them.
   */
  useEffect(() => {
    setEdges((current) =>
      current.map((edge) => {
        if (edge.data?.kind !== "data") return edge;
        const state = dataEdgeState(edge, dataEdgeMode, selectedNodeId);
        if (edge.hidden === state.hidden && edge.className === dataEdgeClassName(state.focused)) return edge;
        return { ...edge, ...dataEdgeVisuals(edge.data.value, state) };
      }),
    );
  }, [mapped, selectedNodeId, dataEdgeMode, setEdges]);

  /**
   * Bring the selected step into view — but only when it is not already there.
   *
   * Clicking a node on the canvas must never move the canvas under the cursor,
   * so the pan is conditional on the node being outside the visible area (with a
   * margin, so a node half-off the edge still counts as hidden). The zoom is
   * kept: the user chose it, and a jump that also rescales loses the reading.
   */
  useEffect(() => {
    if (selectedNodeId === null || props.focusSelection === false) return;
    const element = wrapperRef.current;
    if (element === null) return;
    const internal = getInternalNode(selectedNodeId);
    if (internal === undefined) return;

    const position = internal.internals.positionAbsolute;
    const width = internal.measured.width ?? 200;
    const height = internal.measured.height ?? 60;
    const centerX = position.x + width / 2;
    const centerY = position.y + height / 2;

    const { x, y, zoom } = getViewport();
    const screenX = centerX * zoom + x;
    const screenY = centerY * zoom + y;
    const rect = element.getBoundingClientRect();
    const margin = 48;
    const visible =
      screenX > margin &&
      screenX < rect.width - margin &&
      screenY > margin &&
      screenY < rect.height - margin;
    if (visible) return;

    setCenter(centerX, centerY, { zoom, duration: 320 });
  }, [selectedNodeId, props.focusSelection, getInternalNode, getViewport, setCenter]);

  /**
   * Refit when the canvas itself changes size.
   *
   * The diagram is the window's main object, so a narrower window should show
   * the same flow smaller rather than the same flow half off-screen. React Flow
   * only fits on mount, so the observer supplies the rest.
   */
  useEffect(() => {
    const element = wrapperRef.current;
    if (element === null || typeof ResizeObserver === "undefined") return;
    let first = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (first) { first = false; return; }
      clearTimeout(timer);
      timer = setTimeout(() => { void fitView({ ...FIT, padding: 0.14, duration: 200 }); }, 140);
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
          fitViewOptions={{ ...FIT, padding: 0.15 }}
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
              see all of. Past that threshold it is not optional at any width —
              a 250-line flow is exactly where a narrow window needs it most —
              so it sits bottom-left, clear of the controls and of whatever
              chrome the host floats over the top of the canvas. */}
          {(props.minimap ?? graph.nodes.length > 12) ? (
            <MiniMap
              pannable
              zoomable
              position="bottom-left"
              className="!m-3 !h-24 !w-36 opacity-80 transition-opacity hover:opacity-100 sm:!w-44"
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
