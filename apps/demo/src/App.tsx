/**
 * CodeFlow demo — source in, graph out, edits back (07 §6).
 *
 * The workflow is the product, so the canvas is the whole window and everything
 * else hangs off it: the outline docks on the left when a flow is long enough to
 * need one, the inspector docks on the right when there is room and slides over
 * when there is not, the code is a drawer that is closed until someone asks for
 * it, and problems live behind one button instead of a permanent panel.
 *
 * The host owns the source and the graph, which is the whole point of "code is
 * the source of truth" (00 §2.1): the provider hands back the result of every
 * patch and this component moves both forward together. Typing in Monaco is a
 * source change *without* patch provenance (03 §5.2), so it goes through a
 * debounced re-analyze instead — the same path an AI or an editor outside
 * CodeFlow would take. So does anything the chat panel writes.
 *
 * Examples come from `examples-source.ts`, which is the `@codeflow/examples`
 * contract (or the local stand-in for it); each one names the registry it is
 * analyzed against, so switching flows switches sessions.
 *
 * This app doubles as the target for the agent-driven UI e2e layer (11 §3.5).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  LayoutGrid,
  ListTree,
  LoaderCircle,
  PanelBottom,
  PanelRight,
  Plus,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { registryInstanceFor } from "./registry.js";
import { EXAMPLES, type FlowExample } from "./examples-source.js";
import { ExampleGallery } from "./ExampleGallery.js";
import { FlowAbout } from "./FlowAbout.js";
import { OutlinePanel } from "./OutlinePanel.js";
import { ChatPanel } from "./ChatPanel.js";
import { rememberStats, statsFromGraph } from "./example-stats.js";
import { fetchAiStatus, type AiStatus } from "./ai.js";
import { useMediaQuery } from "./use-media-query.js";

const FIRST = EXAMPLES[0] as FlowExample;

export function App() {
  const toast = useToast();

  const [example, setExample] = useState<FlowExample>(FIRST);
  const [source, setSource] = useState(FIRST.source);
  const [graph, setGraph] = useState<WorkflowGraph | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [showLoading, setShowLoading] = useState(false);
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [codeOpen, setCodeOpen] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [ai, setAi] = useState<AiStatus>({ configured: false, model: "" });
  const [theme, setTheme] = useTheme("light");

  const wide = useMediaQuery("(min-width: 1024px)");
  const roomy = useMediaQuery("(min-width: 900px)");
  const huge = useMediaQuery("(min-width: 1560px)");

  /**
   * One session per example: a session's identity continuity is scoped to the
   * flow it is editing (03 §5.0), and two examples are two files — resolving
   * one against the other would be nonsense. The registry comes from the
   * example, so switching also switches which tools exist.
   */
  const session = useMemo(() => createCodeFlow({ registry: registryInstanceFor(example) }), [example]);

  useEffect(() => {
    void fetchAiStatus().then(setAi);
  }, []);

  // ⌘K palette · ⌘O examples · ⌘J chat · ⌘B outline — the four things this demo
  // is for, each one key away.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      } else if (key === "o") {
        event.preventDefault();
        setGalleryOpen((open) => !open);
      } else if (key === "j") {
        event.preventDefault();
        setChatOpen((open) => !open);
      } else if (key === "b") {
        event.preventDefault();
        setOutlineOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => { window.removeEventListener("keydown", onKeyDown); };
  }, []);

  // Below the docking breakpoint, picking a step opens the panel over the
  // canvas. Dismissing the panel keeps the step selected, so the canvas still
  // shows what is being looked at and one button brings the panel back.
  //
  // Not while the chat is open, though: down here both are overlays, and
  // selecting a step is how you tell the chat *which* step to change — throwing
  // a second sheet over the conversation would bury the thing being used. The
  // step stays selected and the trigger over the canvas brings the inspector
  // back on purpose.
  useEffect(() => {
    if (selectedNodeId !== null && !wide && !chatOpen) setInspectorOpen(true);
  }, [selectedNodeId, wide, chatOpen]);

  // Read inside `analyze`, which must not be rebuilt on every resize.
  const wideRef = useRef(wide);
  wideRef.current = wide;

  const analyze = useCallback(
    async (text: string, exampleId?: string) => {
      const started = performance.now();
      setAnalyzing(true);
      try {
        const next = await session.analyze(text, { trigger: { kind: "webhook", label: "Trigger" } });
        const ms = Math.round(performance.now() - started);
        setGraph(next);
        setError(null);
        setElapsed(ms);
        if (exampleId !== undefined) rememberStats(exampleId, statsFromGraph(next, ms));
        // A long flow is unreadable without a table of contents, so it arrives
        // with one; a short one keeps the whole window for the diagram. Only
        // where the outline can dock, though — below that width it is an
        // overlay, and nothing should cover the canvas uninvited.
        if (exampleId !== undefined) setOutlineOpen(next.nodes.length > 12 && wideRef.current);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setAnalyzing(false);
      }
    },
    [session],
  );

  // Only show the loading state if the wait is long enough to be one: a small
  // flow analyzes in tens of milliseconds and a flashed skeleton reads as jank.
  useEffect(() => {
    if (!analyzing) { setShowLoading(false); return; }
    const timer = setTimeout(() => { setShowLoading(true); }, 120);
    return () => { clearTimeout(timer); };
  }, [analyzing]);

  // Load whichever example is current — including the first one, so the app is
  // useful on first paint.
  const loadedRef = useRef<string | null>(null);
  useEffect(() => {
    if (loadedRef.current === example.id) return;
    loadedRef.current = example.id;
    setSource(example.source);
    setSelectedNodeId(null);
    setGraph(null);
    setElapsed(null);
    void analyze(example.source, example.id);
  }, [example, analyze]);

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

  const applyGeneratedSource = useCallback(
    (next: string) => {
      setSource(next);
      void analyze(next);
    },
    [analyze],
  );

  const dirty = graph !== null && graph.source.content !== source;
  const chatDocked = huge && chatOpen;

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

          <ExampleGallery
            open={galleryOpen}
            onOpenChange={setGalleryOpen}
            currentId={example.id}
            onPick={setExample}
            trigger={
              <Button variant="secondary" size="md" data-testid="open-gallery" className="max-w-[16rem]">
                <LayoutGrid />
                <span className="truncate">{example.title}</span>
                <span className="ml-1 hidden rounded bg-surface-3 px-1 py-0.5 text-[10px] leading-none text-ink-faint lg:inline">
                  ⌘O
                </span>
              </Button>
            }
          />

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
            <Hint label={outlineOpen ? "Hide the step list" : "Show the step list"}>
              <Button
                variant={outlineOpen ? "soft" : "ghost"}
                size="icon"
                data-testid="toggle-outline"
                aria-label="Show the step list"
                aria-pressed={outlineOpen}
                onClick={() => { setOutlineOpen((open) => !open); }}
              >
                <ListTree />
              </Button>
            </Hint>
            <DisclosureToggle iconOnly={!roomy} />
            <Hint label={chatOpen ? "Hide the AI panel" : "Build or change this flow with AI"}>
              <Button
                variant={chatOpen ? "soft" : "ghost"}
                size="icon"
                data-testid="toggle-chat"
                aria-label="Build or change this flow with AI"
                aria-pressed={chatOpen}
                onClick={() => { setChatOpen((open) => !open); }}
              >
                <Sparkles />
              </Button>
            </Hint>
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
        {/* outline + canvas + inspector                                      */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex min-h-0 flex-1">
          {wide && outlineOpen ? (
            <aside className="w-[15rem] shrink-0 border-r border-line xl:w-[17rem]">
              <OutlinePanel onClose={() => { setOutlineOpen(false); }} />
            </aside>
          ) : null}

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

            {showLoading ? <AnalyzingOverlay example={example} /> : null}
          </main>

          {chatDocked ? (
            <aside className="flex w-[24rem] shrink-0 flex-col border-l border-line bg-surface">
              <ChatPanel
                example={example}
                configured={ai.configured}
                model={ai.model}
                onApplySource={applyGeneratedSource}
                onClose={() => { setChatOpen(false); }}
              />
            </aside>
          ) : null}

          {wide ? (
            <aside className="flex w-[21.5rem] shrink-0 flex-col border-l border-line bg-surface xl:w-[23.5rem]">
              {selectedNodeId === null ? (
                <FlowAbout
                  example={example}
                  elapsed={elapsed}
                  onBrowse={() => { setGalleryOpen(true); }}
                />
              ) : (
                <NodeInspector theme={theme} />
              )}
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

      {/* The outline and the chat dock when there is room and slide over when
          there is not — same rule as the inspector. */}
      {!wide ? (
        <Sheet
          open={outlineOpen}
          onOpenChange={setOutlineOpen}
          side="left"
          aria-label="Steps in this flow"
        >
          <OutlinePanel onClose={() => { setOutlineOpen(false); }} />
        </Sheet>
      ) : null}

      {!chatDocked ? (
        <Sheet
          open={chatOpen}
          onOpenChange={setChatOpen}
          aria-label="Ask AI"
          className="w-[min(30rem,100vw)]"
        >
          <ChatPanel
            example={example}
            configured={ai.configured}
            model={ai.model}
            onApplySource={applyGeneratedSource}
            onClose={() => { setChatOpen(false); }}
          />
        </Sheet>
      ) : null}
    </CodeFlowProvider>
  );
}

/* -------------------------------------------------------------------------- */
/* chrome that needs the provider's state                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a long analyze looks like.
 *
 * A 300-line flow takes long enough that a blank canvas would read as a broken
 * app, so the wait says which file it is reading and roughly what is coming —
 * skeleton rows shaped like the nodes that are about to replace them.
 */
function AnalyzingOverlay({ example }: { example: FlowExample }): React.ReactNode {
  return (
    <div
      className="absolute inset-0 z-20 grid place-items-center bg-canvas/80 backdrop-blur-[1px]"
      data-testid="analyzing"
    >
      <div className="flex w-[min(22rem,80vw)] flex-col items-center gap-4">
        <div className="flex items-center gap-2 text-[12.5px] font-medium text-ink">
          <LoaderCircle className="size-4 animate-spin text-accent" />
          Reading {example.title}
        </div>
        <div className="flex w-full flex-col items-center gap-2" aria-hidden="true">
          {[0.72, 0.9, 0.62, 0.84].map((width, index) => (
            <span
              key={index}
              className="h-9 rounded-node border border-line bg-surface-2"
              style={{ width: `${String(width * 100)}%`, opacity: 1 - index * 0.18 }}
            />
          ))}
        </div>
        <p className="m-0 text-center text-[11.5px] text-ink-faint">
          {example.lines} lines · parse and scope analysis only, no type check (07 §7)
        </p>
      </div>
    </div>
  );
}

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
