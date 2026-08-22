/**
 * CodeFlow demo — source in, graph out, edits back (07 §6).
 *
 * Left: the flow source (Monaco) over the palette. Middle: the canvas and the
 * diagnostics. Right: the inspector, where edits are made.
 *
 * The host owns the source and the graph, which is the whole point of "code is
 * the source of truth" (00 §2.1): the provider hands back the result of every
 * patch and this component moves both forward together. Typing in Monaco is a
 * source change *without* patch provenance (03 §5.2), so it goes through a
 * debounced re-analyze instead — the same path an AI or an editor outside
 * CodeFlow would take.
 *
 * This app doubles as the target for the agent-driven UI e2e layer (11 §3.5).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createCodeFlow, type PatchResult, type WorkflowGraph } from "@codeflow/core";
import {
  CodeFlowProvider,
  CodePanel,
  DiagnosticsPanel,
  DisclosureToggle,
  NodeInspector,
  NodePalette,
  ThemeToggle,
  WorkflowCanvas,
  useDebounced,
  useTheme,
} from "@codeflow/react";
import { demoRegistry } from "./registry.js";
import { EXAMPLES } from "./examples.js";

export function App() {
  const session = useMemo(() => createCodeFlow({ registry: demoRegistry }), []);

  const [exampleId, setExampleId] = useState(EXAMPLES[0].id);
  const [source, setSource] = useState(EXAMPLES[0].source);
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [lastPatch, setLastPatch] = useState<string | null>(null);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [theme, setTheme] = useTheme("light");

  const analyze = useCallback(
    async (text: string) => {
      const started = performance.now();
      try {
        const next = await session.analyze(text, { trigger: { kind: "webhook", label: "New PR webhook" } });
        setGraph(next);
        setError(null);
        setElapsed(Math.round(performance.now() - started));
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [session],
  );

  // Preload the canonical example so the app is useful on first paint.
  useEffect(() => {
    void analyze(EXAMPLES[0].source);
  }, [analyze]);

  // Monaco edits: re-analyze once typing settles. No provenance on this path —
  // identity is resolved heuristically, exactly like an edit made outside the UI.
  const settled = useDebounced(source, 600);
  useEffect(() => {
    if (!autoAnalyze || graph === null) return;
    // Only when typing has settled *on the current text*: a patch replaces the
    // source too, and re-analyzing the debounced older value would undo it.
    if (settled !== source) return;
    if (settled === graph.source.content) return;
    void analyze(settled);
  }, [settled, source, autoAnalyze, graph, analyze]);

  const onPatched = useCallback((result: PatchResult) => {
    // One commit: the new source and the graph it was re-analyzed into.
    setSource(result.source);
    setGraph(result.graph);
    setError(null);
    setLastPatch(
      result.patches.length === 0
        ? "no change (empty edit)"
        : `${String(result.patches.length)} range(s) · line ${String(result.patches[0].range.start.line)}`,
    );
  }, []);

  const dirty = graph !== null && graph.source.content !== source;

  return (
    <CodeFlowProvider
      session={session}
      graph={graph}
      source={source}
      onPatched={onPatched}
      onGraphSync={setGraph}
      onReanalyze={() => { void analyze(source); }}
      defaultMode="expanded"
    >
      <div className="app">
        <header className="app__bar">
          <strong className="app__brand">CodeFlow</strong>
          <select
            className="app__select"
            value={exampleId}
            onChange={(event) => {
              const example = EXAMPLES.find((e) => e.id === event.target.value);
              if (example === undefined) return;
              setExampleId(example.id);
              setSource(example.source);
              setLastPatch(null);
              void analyze(example.source);
            }}
          >
            {EXAMPLES.map((example) => (
              <option key={example.id} value={example.id}>
                {example.label}
              </option>
            ))}
          </select>
          <button type="button" className="app__button" onClick={() => void analyze(source)} data-testid="analyze">
            Analyze{dirty ? " •" : ""}
          </button>
          <label className="app__check">
            <input
              type="checkbox"
              checked={autoAnalyze}
              onChange={(event) => { setAutoAnalyze(event.target.checked); }}
            />
            auto
          </label>
          <DisclosureToggle />
          <span className="app__meta">
            {lastPatch === null ? "" : `patched: ${lastPatch} · `}
            {graph === null
              ? "not analyzed"
              : `v${String(graph.version)} · ${String(graph.nodes.length)} nodes · ${String(graph.edges.length)} edges${elapsed === null ? "" : ` · ${String(elapsed)} ms`}`}
          </span>
          <ThemeToggle theme={theme} onChange={setTheme} className="app__theme" />
        </header>

        {error !== null ? <p className="app__error">Analyze failed: {error}</p> : null}

        <main className="app__grid">
          <section className="app__pane app__pane--code">
            <h2 className="app__pane-title">Source</h2>
            <CodePanel value={source} onChange={setSource} theme={theme} />
          </section>

          <section className="app__pane app__pane--canvas">
            <WorkflowCanvas />
          </section>

          <section className="app__pane app__pane--inspector">
            <NodeInspector theme={theme} />
          </section>

          <section className="app__pane app__pane--palette">
            <NodePalette />
          </section>

          <section className="app__pane app__pane--diagnostics">
            <DiagnosticsPanel />
          </section>
        </main>
      </div>
    </CodeFlowProvider>
  );
}
