/**
 * `<DiagnosticsPanel>` — the aggregate half of "diagnostics on the node + a
 * panel" (07 §5). Clicking an entry selects the step it belongs to and reveals
 * its source range.
 *
 * The list is written for someone who has to *act* on it: a plain-language
 * headline, the engine's sentence under it, the step it belongs to, and the
 * code kept as a footnote. Nothing shouts when there is nothing wrong — the
 * empty state is a quiet "all good", not three zeroed counters.
 */

import { useMemo, type ReactNode } from "react";
import { CircleCheck, Info, OctagonAlert, TriangleAlert } from "lucide-react";
import type { Diagnostic, WorkflowNode } from "@codeflow/core";
import { useCodeFlow } from "../context/hooks.js";
import { diagnosticsByNode } from "../graph/index.js";
import { diagnosticHeadline, splitSpecRefs } from "../copy.js";
import { cn } from "../ui/cn.js";

export interface DiagnosticsPanelProps {
  className?: string;
  /** Called after an entry is clicked — used to close the popover it lives in. */
  onNavigate?: () => void;
}

interface Entry {
  diagnostic: Diagnostic;
  node: WorkflowNode | null;
}

const SEVERITY = {
  error: { Icon: OctagonAlert, dot: "text-danger", tint: "bg-danger-soft" },
  warning: { Icon: TriangleAlert, dot: "text-warn", tint: "bg-warn-soft" },
  info: { Icon: Info, dot: "text-info", tint: "bg-info-soft" },
} as const;

/** Counts by severity — exported so chrome can badge a trigger with them. */
export function useDiagnosticCounts(): { error: number; warning: number; info: number; total: number } {
  const { graph } = useCodeFlow();
  return useMemo(() => {
    const out = { error: 0, warning: 0, info: 0, total: 0 };
    for (const diagnostic of graph?.diagnostics ?? []) {
      out[diagnostic.severity]++;
      out.total++;
    }
    return out;
  }, [graph]);
}

export function DiagnosticsPanel(props: DiagnosticsPanelProps): ReactNode {
  const { graph, index, selectNode, focusRange } = useCodeFlow();

  const entries = useMemo<Entry[]>(() => {
    if (graph === null) return [];
    const byNode = diagnosticsByNode(graph);
    const owner = new Map<Diagnostic, string>();
    for (const [nodeId, list] of byNode) for (const diagnostic of list) owner.set(diagnostic, nodeId);
    return graph.diagnostics.map((diagnostic) => {
      const nodeId = owner.get(diagnostic);
      return { diagnostic, node: nodeId === undefined ? null : index.nodeById.get(nodeId) ?? null };
    });
  }, [graph, index]);

  if (entries.length === 0) {
    return (
      <div className={cn("flex items-center gap-2.5 p-4 font-sans", props.className)}>
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-ok-soft text-ok">
          <CircleCheck className="size-4" />
        </span>
        <div>
          <p className="m-0 text-[12.5px] font-semibold text-ink">Nothing to fix</p>
          <p className="m-0 text-[11.5px] text-ink-dim">Every step in this flow is understood and configured.</p>
        </div>
      </div>
    );
  }

  return (
    <ul className={cn("cf-scroll m-0 flex max-h-[min(24rem,60dvh)] list-none flex-col overflow-y-auto p-1.5 font-sans", props.className)}>
      {entries.map((entry, i) => {
        const severity = SEVERITY[entry.diagnostic.severity];
        const split = splitSpecRefs(entry.diagnostic.message);
        return (
          <li key={i}>
            <button
              type="button"
              className={cn(
                "flex w-full cursor-pointer items-start gap-2.5 rounded-lg border-0 bg-transparent p-2.5 text-left",
                "outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring/60",
              )}
              onClick={() => {
                if (entry.node !== null) selectNode(entry.node.id);
                else if (entry.diagnostic.source !== undefined) focusRange(entry.diagnostic.source);
                props.onNavigate?.();
              }}
            >
              <span className={cn("mt-px grid size-5 shrink-0 place-items-center rounded-md", severity.tint, severity.dot)}>
                <severity.Icon className="size-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="text-[12.5px] font-semibold leading-snug text-ink">
                    {diagnosticHeadline(entry.diagnostic.code)}
                  </span>
                  {entry.node === null ? null : (
                    <span className="ml-auto shrink-0 truncate text-[11px] text-ink-faint">{entry.node.label}</span>
                  )}
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-[1.5] text-ink-dim">{split.text}</span>
                <span className="mt-1 block font-mono text-[10px] leading-none text-ink-faint">
                  {[entry.diagnostic.code, ...split.refs].join(" · ")}
                  {entry.diagnostic.source === undefined
                    ? ""
                    : ` · line ${String(entry.diagnostic.source.start.line)}`}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
