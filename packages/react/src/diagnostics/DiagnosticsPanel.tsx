/**
 * `<DiagnosticsPanel>` — the aggregate half of "diagnostics on the node + a
 * panel" (07 §5). Clicking an entry selects the node it belongs to and reveals
 * its source range.
 */

import { useMemo, type ReactNode } from "react";
import type { Diagnostic, WorkflowNode } from "@codeflow/core";
import { useCodeFlow } from "../context/hooks.js";
import { diagnosticsByNode } from "../graph/index.js";

export interface DiagnosticsPanelProps {
  className?: string;
}

interface Entry {
  diagnostic: Diagnostic;
  node: WorkflowNode | null;
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

  const counts = useMemo(() => {
    const out = { error: 0, warning: 0, info: 0 };
    for (const entry of entries) out[entry.diagnostic.severity]++;
    return out;
  }, [entries]);

  return (
    <section className={`cf-diagnostics ${props.className ?? ""}`}>
      <header className="cf-diagnostics__header">
        <h2>Diagnostics</h2>
        <span className="cf-diagnostics__counts">
          <span className="cf-chip cf-chip--error">{counts.error} errors</span>
          <span className="cf-chip cf-chip--warning">{counts.warning} warnings</span>
          <span className="cf-chip cf-chip--info">{counts.info} info</span>
        </span>
      </header>
      {entries.length === 0 ? (
        <p className="cf-empty">No diagnostics.</p>
      ) : (
        <ul className="cf-diagnostics__list">
          {entries.map((entry, i) => (
            <li key={i}>
              <button
                type="button"
                className={`cf-diagnostic cf-diagnostic--${entry.diagnostic.severity}`}
                onClick={() => {
                  if (entry.node !== null) selectNode(entry.node.id);
                  else if (entry.diagnostic.source !== undefined) focusRange(entry.diagnostic.source);
                }}
              >
                <code className="cf-diagnostic__code">{entry.diagnostic.code}</code>
                <span className="cf-diagnostic__message">{entry.diagnostic.message}</span>
                {entry.diagnostic.source !== undefined ? (
                  <span className="cf-diagnostic__where">
                    {entry.node?.label ?? "source"}
                    {` · line ${String(entry.diagnostic.source.start.line)}`}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
