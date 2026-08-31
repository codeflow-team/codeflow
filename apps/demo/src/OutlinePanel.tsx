/**
 * `<OutlinePanel>` — the flow as a list, in source order.
 *
 * A 300-line flow becomes a graph that no longer fits on a screen, and panning
 * around looking for "the Slack step inside the second loop" is not reading. The
 * outline is the table of contents for it: every node in the order the file
 * declares them, indented by nesting, with the branch or slot it belongs to.
 * Clicking one selects it, which is what makes the canvas pan to it and the
 * inspector open on it — the same selection everything else already listens to.
 *
 * It is a projection, like everything else in this layer: no state of its own
 * beyond the filter box.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  NodeGlyph,
  cn,
  nodeKindLabel,
  nodeTitle,
  nodeVisual,
  orderedNodes,
  useCodeFlow,
  worstSeverity,
  type DisclosureMode,
} from "@codeflow-team/react";
import type { WorkflowNode } from "@codeflow-team/core";
import { ListTree, Search, X } from "lucide-react";

export interface OutlinePanelProps {
  onClose?: () => void;
  className?: string;
}

export function OutlinePanel(props: OutlinePanelProps): ReactNode {
  const { graph, index, selectedNodeId, selectNode, nodeDiagnostics, mode } = useCodeFlow();
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement | null>(null);

  // Selection can come from the canvas or the code panel, and on a long flow the
  // matching row is usually far off the visible part of this list.
  useEffect(() => {
    if (selectedNodeId === null) return;
    const row = listRef.current?.querySelector<HTMLElement>(`[data-testid="outline-${CSS.escape(selectedNodeId)}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [selectedNodeId]);

  const rows = useMemo(() => {
    if (graph === null) return [];
    return orderedNodes(graph, index).map((node) => ({
      node,
      depth: index.depthOf.get(node.id) ?? 0,
      slot: typeof node.data["parentSlot"] === "string" ? (node.data["parentSlot"] as string) : null,
      branch: typeof node.data["branch"] === "string" ? (node.data["branch"] as string) : null,
    }));
  }, [graph, index]);

  const needle = query.trim().toLowerCase();
  const visible = needle.length === 0
    ? rows
    : rows.filter(
        (row) =>
          row.node.label.toLowerCase().includes(needle) ||
          // The list reads a decision the way the canvas draws it, so the filter
          // has to find it by that wording too — otherwise typing what is on
          // screen returns nothing.
          nodeTitle(row.node, mode).toLowerCase().includes(needle) ||
          nodeKindLabel(row.node).toLowerCase().includes(needle),
      );

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-surface font-sans", props.className)} data-testid="outline">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <ListTree className="size-3.5 text-ink-faint" />
        <h2 className="m-0 text-[12px] font-semibold tracking-[-0.005em] text-ink">Steps</h2>
        <span className="text-[11px] text-ink-faint">{rows.length}</span>
        {props.onClose === undefined ? null : (
          <button
            type="button"
            aria-label="Hide the step list"
            onClick={props.onClose}
            className="ml-auto grid size-6 cursor-pointer place-items-center rounded-md border-0 bg-transparent text-ink-faint hover:bg-surface-2 hover:text-ink"
          >
            <X className="size-3.5" />
          </button>
        )}
      </header>

      <div className="relative shrink-0 border-b border-line">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-ink-faint" />
        <input
          type="text"
          id="cf-outline-search"
          name="outline-search"
          aria-label="Filter steps"
          placeholder="Filter steps…"
          value={query}
          onChange={(event) => { setQuery(event.target.value); }}
          className="h-9 w-full appearance-none border-0 bg-transparent pl-8 pr-3 font-sans text-[12px] text-ink outline-none placeholder:text-ink-faint"
        />
      </div>

      <div ref={listRef} className="cf-scroll min-h-0 flex-1 overflow-y-auto py-1">
        {visible.length === 0 ? (
          <p className="m-0 px-3 py-6 text-center text-[11.5px] text-ink-dim">
            {rows.length === 0 ? "No steps yet." : `Nothing matches “${query.trim()}”.`}
          </p>
        ) : (
          visible.map((row) => (
            <OutlineRow
              key={row.node.id}
              node={row.node}
              depth={row.depth}
              slot={row.slot}
              branch={row.branch}
              selected={row.node.id === selectedNodeId}
              mode={mode}
              severity={worstSeverity(nodeDiagnostics.get(row.node.id) ?? [])}
              onSelect={() => { selectNode(row.node.id); }}
            />
          ))
        )}
      </div>
    </div>
  );
}

function OutlineRow(props: {
  node: WorkflowNode;
  depth: number;
  slot: string | null;
  branch: string | null;
  selected: boolean;
  mode: DisclosureMode;
  severity: "error" | "warning" | "info" | null;
  onSelect: () => void;
}): ReactNode {
  const visual = nodeVisual(props.node);
  const tag = props.slot !== null && props.slot !== "body" ? props.slot : props.branch;

  return (
    <button
      type="button"
      data-testid={`outline-${props.node.id}`}
      aria-current={props.selected ? "true" : undefined}
      onClick={props.onSelect}
      style={{ paddingLeft: `${String(0.5 + Math.min(props.depth, 5) * 0.75)}rem` }}
      className={cn(
        "flex w-full cursor-pointer items-center gap-2 border-0 py-1.5 pr-2 text-left transition-colors",
        props.selected ? "bg-accent-soft" : "bg-transparent hover:bg-surface-2",
      )}
    >
      <span className={cn("grid size-5 shrink-0 place-items-center rounded-md [&_svg]:size-3", visual.chipClass)}>
        <NodeGlyph node={props.node} />
      </span>
      <span className="min-w-0 flex-1">
        {/* The same wording the canvas uses, so the list and the diagram never
            name the same step two different ways; the literal expression stays
            in the tooltip. */}
        <span
          title={props.node.label}
          className={cn("block truncate text-[12px] leading-tight", props.selected ? "font-medium text-ink" : "text-ink")}
        >
          {nodeTitle(props.node, props.mode)}
        </span>
        <span className="block truncate text-[10.5px] leading-tight text-ink-faint">
          {nodeKindLabel(props.node)}
          {tag === null ? "" : ` · ${tag}`}
        </span>
      </span>
      {/* `info` deliberately gets no dot: every `code` step carries the same
          note ("kept verbatim"), and twenty-one identical dots down one list
          stop being a signal and start being a texture — including on the row
          that has a real warning. Notes live in the diagnostics panel. */}
      {props.severity === null || props.severity === "info" ? null : (
        <span
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            props.severity === "error" ? "bg-danger" : "bg-warn",
          )}
          title={`has a ${props.severity}`}
        />
      )}
    </button>
  );
}
