/**
 * CodeFlow demo — source in, graph out (07 §6).
 *
 * Left: the flow source (Monaco) + the registry the analyzer resolves against.
 * Middle: the canvas. Right: the inspector. Bottom: diagnostics.
 *
 * This app doubles as the target for the agent-driven UI e2e layer (11 §3.5).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { createCodeFlow, type WorkflowGraph } from "@codeflow/core";
import {
  CodeFlowProvider,
  CodePanel,
  DiagnosticsPanel,
  DisclosureToggle,
  NodeInspector,
  ThemeToggle,
  WorkflowCanvas,
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

  const dirty = graph !== null && graph.source.content !== source;

  return (
    <CodeFlowProvider session={session} graph={graph} defaultMode="expanded">
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
          <DisclosureToggle />
          <span className="app__meta">
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
            <NodeInspector />
          </section>

          <section className="app__pane app__pane--diagnostics">
            <DiagnosticsPanel />
          </section>
        </main>
      </div>
    </CodeFlowProvider>
  );
}
