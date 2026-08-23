/**
 * CodeFlow demo — source in, graph out, edits back (07 §6).
 *
 * The workflow is the product, so the canvas is the whole window and everything
 * else hangs off it: the inspector docks on the right when there is room and
 * slides over when there is not, the code is a drawer that is closed until
 * someone asks for it, and problems live behind one button instead of a
 * permanent panel.
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
  Badge,
  Button,
  CodePanel,
  CodeFlowProvider,
  DiagnosticsPanel,
  DisclosureToggle,
  Hint,
  NodeInspector,
  NodePalette,
  Notice,
  Popover,
  Select,
  Sheet,
  ThemeToggle,
  WorkflowCanvas,
  useCodeFlow,
  useDebounced,
  useDiagnosticCounts,
  useTheme,
  useToast,
} from "@codeflow/react";
import {
  ChevronDown,
  CircleCheck,
  FileCode,
  PanelBottom,
  PanelRight,
  Plus,
  RefreshCw,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { demoRegistry } from "./registry.js";
import { EXAMPLES } from "./examples.js";
import { useMediaQuery } from "./use-media-query.js";

export function App() {
  const session = useMemo(() => createCodeFlow({ registry: demoRegistry }), []);
  const toast = useToast();

  const [exampleId, setExampleId] = useState(EXAMPLES[0].id);
  const [source, setSource] = useState(EXAMPLES[0].source);
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [codeOpen, setCodeOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, setTheme] = useTheme("light");

  const wide = useMediaQuery("(min-width: 1024px)");
  const roomy = useMediaQuery("(min-width: 900px)");

  // ⌘K / Ctrl-K opens the step palette from anywhere — the one shortcut a
  // command palette is expected to answer to.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, []);

  // Below the docking breakpoint, picking a step opens the panel over the
  // canvas. Dismissing the panel keeps the step selected, so the canvas still
  // shows what is being looked at and one button brings the panel back.
  useEffect(() => {
    if (selectedNodeId !== null && !wide) setInspectorOpen(true);
  }, [selectedNodeId, wide]);

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

  const onPatched = useCallback(
    (result: PatchResult) => {
      // One commit: the new source and the graph it was re-analyzed into.
      setSource(result.source);
      setGraph(result.graph);
      setError(null);
      const added = result.changes.some((change) => change.type === "node.added");
      // A refusal is never a toast (07 §5) — this only ever fires on success.
      toast.add({
        title: added ? "Step added" : "Change saved",
        description:
          result.patches.length === 0
            ? "Nothing needed to change in the code."
            : `${String(result.patches.length)} place${result.patches.length === 1 ? "" : "s"} in the code updated.`,
      });
    },
    [toast],
  );

  const dirty = graph !== null && graph.source.content !== source;

  return (
    <CodeFlowProvider
      session={session}
      graph={graph}
      source={source}
      selectedNodeId={selectedNodeId}
      onSelectNode={setSelectedNodeId}
      onPatched={onPatched}
      onGraphSync={setGraph}
      onReanalyze={() => { void analyze(source); }}
      defaultMode="expanded"
    >
      <div className="flex h-dvh flex-col overflow-hidden bg-canvas text-ink">
        {/* ---------------------------------------------------------------- */}
        {/* top bar                                                           */}
        {/* ---------------------------------------------------------------- */}
        <header className="z-30 flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-accent text-accent-fg shadow-xs">
            <Workflow className="size-4.5" />
          </span>
          <span className="mr-1 hidden text-[14px] font-semibold tracking-[-0.015em] sm:block">CodeFlow</span>

          <div className="w-[min(18rem,45vw)]">
            <Select
              id="cf-example-flow"
              name="example-flow"
              aria-label="Example flow"
              value={exampleId}
              onValueChange={(value) => {
                const example = EXAMPLES.find((candidate) => candidate.id === value);
                if (example === undefined) return;
                setExampleId(example.id);
                setSource(example.source);
                setSelectedNodeId(null);
                void analyze(example.source);
              }}
              options={EXAMPLES.map((example) => ({ value: example.id, label: example.label }))}
            />
          </div>

          <Hint label={dirty ? "The code changed — redraw the diagram" : "Redraw the diagram from the code"}>
            <Button
              variant={dirty ? "soft" : "ghost"}
              size="icon"
              aria-label="Redraw the diagram"
              data-testid="analyze"
              onClick={() => { void analyze(source); }}
            >
              <RefreshCw />
            </Button>
          </Hint>

          <GraphSummary elapsed={elapsed} />

          <div className="ml-auto flex items-center gap-2">
            <DisclosureToggle iconOnly={!roomy} />
            <Hint label={codeOpen ? "Hide the file" : "Show the file this flow is drawn from"}>
              <Button
                variant={codeOpen ? "soft" : "ghost"}
                size="icon"
                data-testid="toggle-code"
                aria-label="Show the file this flow is drawn from"
                aria-pressed={codeOpen}
                onClick={() => { setCodeOpen((open) => !open); }}
              >
                <PanelBottom />
              </Button>
            </Hint>
            <ThemeToggle theme={theme} onChange={setTheme} />
          </div>
        </header>

        {error !== null ? (
          <div className="shrink-0 border-b border-line px-3 py-2">
            <Notice tone="danger" role="alert" title="This file could not be read as a flow">
              {error}
            </Notice>
          </div>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {/* canvas + inspector                                                */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex min-h-0 flex-1">
          <main className="relative min-w-0 flex-1">
            <WorkflowCanvas />

            <div className="pointer-events-none absolute inset-x-3 top-3 flex items-start gap-2">
              <div className="pointer-events-auto flex items-center gap-2">
                <NodePalette
                  open={paletteOpen}
                  onOpenChange={setPaletteOpen}
                  trigger={
                    <Button variant="primary" size="md" className="shadow-soft">
                      <Plus />
                      Add step
                      <span className="ml-1 hidden rounded bg-white/20 px-1 py-0.5 text-[10px] leading-none sm:inline">
                        ⌘K
                      </span>
                    </Button>
                  }
                />
                <IssuesButton />
              </div>
              {!wide && selectedNodeId !== null && !inspectorOpen ? (
                <div className="pointer-events-auto ml-auto">
                  <InspectorTrigger onOpen={() => { setInspectorOpen(true); }} />
                </div>
              ) : null}
            </div>
          </main>

          {wide ? (
            <aside className="flex w-[21.5rem] shrink-0 flex-col border-l border-line bg-surface xl:w-[23.5rem]">
              <NodeInspector theme={theme} />
            </aside>
          ) : null}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* the code, on request                                              */}
        {/* ---------------------------------------------------------------- */}
        {codeOpen ? (
          <section
            className="flex h-[42dvh] min-h-0 shrink-0 flex-col border-t border-line bg-surface"
            style={{ animation: "cf-slide-up 220ms ease-out" }}
          >
            <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
              <FileCode className="size-3.5 text-ink-faint" />
              <h2 className="m-0 text-[12px] font-semibold tracking-[-0.005em]">flow.ts</h2>
              {dirty ? (
                <Badge tone="warn" title="The diagram has not caught up with this text yet">
                  unsaved edits
                </Badge>
              ) : null}
              <label className="ml-3 inline-flex cursor-pointer select-none items-center gap-1.5 text-[11.5px] text-ink-dim">
                <input
                  type="checkbox"
                  id="cf-auto-analyze"
                  name="auto-analyze"
                  className="size-3.5 cursor-pointer accent-[color:var(--cf-accent)]"
                  checked={autoAnalyze}
                  onChange={(event) => { setAutoAnalyze(event.target.checked); }}
                />
                Redraw as I type
              </label>
              <Button
                variant="ghost"
                size="icon-sm"
                className="ml-auto"
                aria-label="Hide the code"
                onClick={() => { setCodeOpen(false); }}
              >
                <ChevronDown />
              </Button>
            </header>
            <div className="min-h-0 flex-1">
              <CodePanel value={source} onChange={setSource} theme={theme} />
            </div>
          </section>
        ) : null}
      </div>

      {/* Below the docking breakpoint the inspector is an overlay, so the
          canvas never has to share a screen that is too narrow for both. */}
      {!wide ? (
        <Sheet
          open={inspectorOpen && selectedNodeId !== null}
          onOpenChange={setInspectorOpen}
          aria-label="Step settings"
          className="w-[min(24rem,100vw)]"
        >
          <NodeInspector theme={theme} onClose={() => { setInspectorOpen(false); }} />
        </Sheet>
      ) : null}
    </CodeFlowProvider>
  );
}

/* -------------------------------------------------------------------------- */
/* chrome that needs the provider's state                                      */
/* -------------------------------------------------------------------------- */

function GraphSummary({ elapsed }: { elapsed: number | null }): React.ReactNode {
  const { graph } = useCodeFlow();
  if (graph === null) return null;
  return (
    <span className="ml-1 hidden items-center gap-1.5 text-[11.5px] text-ink-faint md:flex">
      <span className="font-medium text-ink-dim">{graph.nodes.length} steps</span>
      {elapsed === null ? null : <span>· read in {elapsed} ms</span>}
    </span>
  );
}

function IssuesButton(): React.ReactNode {
  const counts = useDiagnosticCounts();
  const [open, setOpen] = useState(false);
  const bad = counts.error + counts.warning;

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="start"
      trigger={
        <Button variant="secondary" size="md" data-testid="issues" className="shadow-soft">
          {bad > 0 ? (
            <>
              <TriangleAlert className={counts.error > 0 ? "text-danger" : "text-warn"} />
              {bad} {bad === 1 ? "issue" : "issues"}
            </>
          ) : (
            <>
              <CircleCheck className="text-ok" />
              No issues
            </>
          )}
        </Button>
      }
    >
      <div className="border-b border-line px-4 py-2.5">
        <p className="m-0 text-[12.5px] font-semibold">What needs attention</p>
        <p className="m-0 text-[11.5px] text-ink-dim">Select one to jump to the step it belongs to.</p>
      </div>
      <DiagnosticsPanel onNavigate={() => { setOpen(false); }} />
    </Popover>
  );
}

/** Opens the overlay inspector; only rendered below the docking breakpoint. */
function InspectorTrigger({ onOpen }: { onOpen: () => void }): React.ReactNode {
  const { selectedNode } = useCodeFlow();
  if (selectedNode === null) return null;
  return (
    <Button variant="secondary" size="md" className="shadow-soft" onClick={onOpen} data-testid="open-inspector">
      <PanelRight />
      <span className="max-w-32 truncate">{selectedNode.label}</span>
    </Button>
  );
}

