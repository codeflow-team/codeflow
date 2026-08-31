/**
 * `<FlowAbout>` — "what is this flow showing me?"
 *
 * The gallery card sells an example in two lines; this panel is the long answer,
 * and it lives where the eye already goes when nothing is selected. Half of it
 * is the example's own words (description + the hard cases it highlights) and
 * half is measured from the graph in front of the user: nodes by type, control
 * versus data edges, diagnostics by severity, and how long the analyzer took.
 *
 * Nothing here is decorative — a claim like "three levels of nesting" is next to
 * the container count that proves it.
 */

import { useMemo, type ReactNode } from "react";
import { Badge, Button, useCodeFlow } from "@codeflow-team/react";
import { LayoutGrid, Sparkles } from "lucide-react";
import type { FlowExample } from "./examples-source.js";

const CATEGORY_LABEL: Record<FlowExample["category"], string> = {
  basics: "Basics",
  "control-flow": "Control flow",
  "real-mcp": "Real MCP tools",
  stress: "Stress",
  degradation: "Degradation",
};

const TYPE_LABEL: Record<string, string> = {
  trigger: "trigger",
  tool: "tool calls",
  function: "functions",
  condition: "decisions",
  loop: "loops",
  try: "try blocks",
  parallel: "parallel",
  merge: "merges",
  jump: "jumps",
  output: "ends",
  code: "code nodes",
  unknown: "unknown",
};

export interface FlowAboutProps {
  example: FlowExample;
  /** Milliseconds the last analyze took, or `null` before the first one. */
  elapsed: number | null;
  onBrowse: () => void;
}

export function FlowAbout(props: FlowAboutProps): ReactNode {
  const { graph } = useCodeFlow();

  const stats = useMemo(() => {
    if (graph === null) return null;
    const byType = new Map<string, number>();
    for (const node of graph.nodes) byType.set(node.type, (byType.get(node.type) ?? 0) + 1);
    const control = graph.edges.filter((edge) => edge.kind === "control").length;
    const data = graph.edges.filter((edge) => edge.kind === "data").length;
    const errors = graph.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const warnings = graph.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
    const infos = graph.diagnostics.filter((diagnostic) => diagnostic.severity === "info").length;
    return {
      byType: [...byType.entries()].sort((a, b) => b[1] - a[1]),
      nodes: graph.nodes.length,
      control,
      data,
      errors,
      warnings,
      infos,
      lines: graph.source.content.replace(/\n$/, "").split("\n").length,
    };
  }, [graph]);

  // Once the AI (or Monaco) has rewritten the file, the example's own metadata
  // describes a flow that is no longer on screen — QA found the header still
  // claiming "17 lines" over a 60-line file, under a "what this one shows off"
  // list about steps that had been replaced (BUG-14). The measured numbers are
  // always right; the shipped prose is labelled for what it is.
  const edited = useMemo(
    () => graph !== null && graph.source.content.trim() !== props.example.source.trim(),
    [graph, props.example.source],
  );

  return (
    <aside className="cf-scroll flex h-full min-h-0 flex-col overflow-y-auto bg-surface font-sans" data-testid="flow-about">
      <header className="flex flex-col gap-2 px-4 pb-3 pt-4">
        <div className="flex items-center gap-2">
          <Badge tone="accent">{CATEGORY_LABEL[props.example.category]}</Badge>
          <span className="text-[11px] text-ink-faint">{stats?.lines ?? props.example.lines} lines</span>
          {edited ? (
            <Badge tone="warn" title="The file on screen is no longer the example that shipped">
              edited
            </Badge>
          ) : null}
          {props.elapsed === null ? null : (
            <span className="text-[11px] text-ink-faint">· read in {props.elapsed} ms</span>
          )}
        </div>
        <h2 className="m-0 text-[15px] font-semibold leading-tight tracking-[-0.01em] text-ink">
          {props.example.title}
        </h2>
        <p className="m-0 text-[12.5px] leading-relaxed text-ink-dim">{props.example.description}</p>
      </header>

      {props.example.highlights.length === 0 ? null : (
        <section className="border-t border-line px-4 py-3">
          <h3 className="m-0 flex items-center gap-1.5 pb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
            <Sparkles className="size-3" />
            {edited ? "What the original showed off" : "What this one shows off"}
          </h3>
          {edited ? (
            <p className="m-0 pb-2 text-[11px] leading-snug text-ink-faint">
              The file has been changed since it was opened, so this list describes the example as it
              shipped — not what is on the canvas now.
            </p>
          ) : null}
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {props.example.highlights.map((highlight) => (
              <li key={highlight} className="flex items-start gap-2 text-[12px] leading-snug text-ink">
                <span className="mt-[6px] size-1.5 shrink-0 rounded-full bg-accent" />
                {highlight}
              </li>
            ))}
          </ul>
        </section>
      )}

      {stats === null ? null : (
        <section className="border-t border-line px-4 py-3">
          <h3 className="m-0 pb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
            In this diagram
          </h3>

          <div className="flex flex-wrap gap-1.5 pb-3">
            {stats.byType.map(([type, count]) => (
              <span
                key={type}
                className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-1.5 py-1 text-[11px] text-ink-dim ring-1 ring-inset ring-line"
                title={`${count} ${type} node${count === 1 ? "" : "s"}`}
              >
                <span
                  className="size-2 shrink-0 rounded-[3px]"
                  style={{ background: `var(--cf-${type}, var(--cf-merge))` }}
                />
                <span className="font-medium text-ink">{count}</span>
                {TYPE_LABEL[type] ?? type}
              </span>
            ))}
          </div>

          <dl className="m-0 grid grid-cols-2 gap-x-3 gap-y-2">
            <Stat label="Nodes" value={String(stats.nodes)} />
            <Stat label="Source lines" value={String(stats.lines)} />
            <Stat label="Control edges" value={String(stats.control)} />
            <Stat label="Data edges" value={String(stats.data)} />
            <Stat
              label="Errors"
              value={String(stats.errors)}
              tone={stats.errors > 0 ? "danger" : "muted"}
            />
            <Stat
              label="Warnings"
              value={String(stats.warnings)}
              tone={stats.warnings > 0 ? "warn" : "muted"}
            />
            {stats.infos === 0 ? null : <Stat label="Notes" value={String(stats.infos)} />}
            {props.elapsed === null ? null : <Stat label="Analyze" value={`${props.elapsed} ms`} />}
          </dl>
        </section>
      )}

      <div className="mt-auto border-t border-line p-3">
        <Button variant="secondary" size="md" className="w-full" onClick={props.onBrowse}>
          <LayoutGrid />
          Browse all examples
        </Button>
        <p className="m-0 pt-2 text-center text-[11px] text-ink-faint">
          Pick a step in the diagram to edit it.
        </p>
      </div>
    </aside>
  );
}

function Stat(props: { label: string; value: string; tone?: "muted" | "warn" | "danger" }): ReactNode {
  const tone =
    props.tone === "danger" ? "text-danger" : props.tone === "warn" ? "text-warn" : "text-ink";
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-line/60 pb-1.5">
      <dt className="m-0 text-[11.5px] text-ink-faint">{props.label}</dt>
      <dd className={`m-0 text-[12.5px] font-medium tabular-nums ${tone}`}>{props.value}</dd>
    </div>
  );
}
