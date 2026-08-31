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
import { createCodeFlow, traceIdentity, type PatchResult, type WorkflowGraph, type WorkflowNode } from "@codeflow/core";
import {
  Badge,
  Button,
  CodePanel,
  CodeFlowProvider,
  DataLinksToggle,
  DiagnosticsPanel,
  DisclosureToggle,
  Hint,
  Modal,
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
  type RunView,
} from "@codeflow/react";
import {
  ChevronDown,
  CircleAlert,
  CircleCheck,
  FileCode,
  LayoutGrid,
  ListTree,
  LoaderCircle,
  PanelBottom,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  ServerCog,
  Sparkles,
  Square,
  TriangleAlert,
  Workflow,
} from "lucide-react";
import { EXAMPLES, type FlowExample } from "./examples-source.js";
import { McpManager } from "./McpManager.js";
import { runSpecs } from "./mcp/model.js";
import { tokenFor } from "./mcp/storage.js";
import { useMcpServers } from "./mcp/use-mcp-servers.js";
import { RunPanel } from "./RunPanel.js";
import {
  EMPTY_RUN,
  fetchRunStatus,
  runRequestFor,
  startRun,
  traceMatchFor,
  TRACE_MATCH_HINT,
  TRACE_MATCH_LABEL,
  type RunHandle,
  type RunSnapshot,
} from "./run.js";
import { ExampleGallery } from "./ExampleGallery.js";
import { FlowAbout } from "./FlowAbout.js";
import { OutlinePanel } from "./OutlinePanel.js";
import { ChatPanel } from "./ChatPanel.js";
import { forgetStats, rememberStats, statsFromGraph } from "./example-stats.js";
import { fetchAiStatus, type AiStatus } from "./ai.js";
import {
  IS_PUBLIC_BUILD,
  REPO_URL,
  RUN_UNAVAILABLE_FIX,
  RUN_UNAVAILABLE_REASON,
} from "./deployment.js";
import { withArgumentTypes } from "./argument-types.js";
import { loadFlow, saveFlow } from "./persist.js";
import { useMediaQuery } from "./use-media-query.js";
import { useTriggerInput } from "./trigger-input.js";
import { TriggerInputDialog, TriggerInputForm } from "./TriggerInput.js";
import { NewFlowDialog } from "./NewFlowDialog.js";
import { resolveRegistry } from "./flow-registry.js";
import {
  MCP_REGISTRY,
  asExample,
  exportFlowFile,
  fileNameFor,
  isMine,
  loadMyFlows,
  newFlowId,
  saveMyFlows,
  uniqueTitle,
  type MyFlow,
} from "./my-flows.js";

const FIRST = EXAMPLES[0] as FlowExample;

/**
 * The visitor's own flows, read once at module load.
 *
 * Same reason as `RESTORED` below: the very first render has to know whether
 * the id the tab was last looking at belongs to a flow of theirs, and asking
 * later would mean one paint of the wrong file.
 */
const MY_FLOWS = loadMyFlows();

/**
 * The flow this tab was last looking at.
 *
 * Read once, at module load, before anything renders: a reload — accidental,
 * or the `full-reload` a broken Fast Refresh boundary used to cause — otherwise
 * threw away a file the user had just spent minutes generating, with no save
 * anywhere (QA BUG-1). Restoring it costs nothing and the diagram is redrawn
 * from the restored text, so what comes back is a real flow, not a snapshot.
 *
 * The id may name one of the visitor's own flows or one of the built-in
 * examples — the two id spaces were deliberately made not to overlap
 * (`my-flows.ts`), so one lookup after the other is unambiguous.
 */
const RESTORED = (() => {
  const kept = loadFlow();
  if (kept === null) return null;
  const mine = MY_FLOWS.find((candidate) => candidate.id === kept.exampleId);
  if (mine !== undefined) return { example: asExample(mine), source: kept.source };
  const example = EXAMPLES.find((candidate) => candidate.id === kept.exampleId);
  if (example === undefined) return null;
  return { example, source: kept.source };
})();

export function App() {
  const toast = useToast();

  const [example, setExample] = useState<FlowExample>(RESTORED?.example ?? FIRST);
  const [source, setSource] = useState(RESTORED?.source ?? FIRST.source);
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
  const [runnerAvailable, setRunnerAvailable] = useState(false);
  const [run, setRun] = useState<RunSnapshot>(EMPTY_RUN);
  const [runOpen, setRunOpen] = useState(false);
  const [runUnavailableOpen, setRunUnavailableOpen] = useState(false);
  /** Set only while the registry has genuinely moved under the open flow (06 §5). */
  const [registryNote, setRegistryNote] = useState<string | null>(null);
  /** The "start the flow from *this*" panel, between Run and the run itself. */
  const [triggerOpen, setTriggerOpen] = useState(false);
  const runHandle = useRef<RunHandle | null>(null);
  const [theme, setTheme] = useTheme("light");

  /* --- the visitor's own flows ------------------------------------------- */

  const [myFlows, setMyFlows] = useState<MyFlow[]>(MY_FLOWS);
  /** Set when this browser refused to keep them — said out loud, never hidden. */
  const [flowStorageError, setFlowStorageError] = useState<string | null>(null);
  const [newFlowOpen, setNewFlowOpen] = useState(false);
  /** What the generation loop reached, carried onto the canvas after Create. */
  const [creationNote, setCreationNote] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  /** Dismissed once per example, so the offer to save is not nagging. */
  const [saveOfferHidden, setSaveOfferHidden] = useState(false);

  const firstSave = useRef(true);
  useEffect(() => {
    // Nothing to write on the very first render — that value came *from*
    // storage, and writing it back would only risk a spurious quota error.
    if (firstSave.current) {
      firstSave.current = false;
      return;
    }
    const outcome = saveMyFlows(myFlows);
    setFlowStorageError(outcome.ok ? null : outcome.error);
  }, [myFlows]);

  const wide = useMediaQuery("(min-width: 1024px)");
  const roomy = useMediaQuery("(min-width: 900px)");
  const huge = useMediaQuery("(min-width: 1560px)");

  /**
   * Where the tools come from.
   *
   * By default, the example's own registry. As soon as the visitor configures
   * an MCP server of their own (`McpManager.tsx`), the composed registry takes
   * over and *is* the registry — for the palette, for `session.analyze`, for the
   * AI's `tools.d.ts` and for the Run bindings. That is the whole architectural
   * claim made visible: core knows no tool, everything arrives through the
   * registry at runtime (00 §6.6b, 05 §3).
   */
  const mcp = useMcpServers();
  const [mcpOpen, setMcpOpen] = useState(false);
  /**
   * One flow, one registry. `resolveRegistry` is `activeRegistry` for a built-in
   * example — unchanged — and honours the choice recorded on the flow when the
   * flow is one the visitor made, because that choice is part of the document.
   */
  const active = useMemo(
    () => resolveRegistry(example, { composed: mcp.composed, active: mcp.active }),
    [example, mcp.composed, mcp.active],
  );

  /**
   * One session per registry+example: a session's identity continuity is scoped
   * to the flow it is editing (03 §5.0), and two examples are two files —
   * resolving one against the other would be nonsense.
   */
  const registry = active.lookup;
  const session = useMemo(() => createCodeFlow({ registry }), [registry]);

  /**
   * Every graph this app renders, plus the checks the browser can make.
   *
   * The analyzer parses and scopes; it does not type-check, and 07 §7 says so.
   * That left one honest-looking lie on screen: a flow with `width: "extra-wide"`
   * against a `number` schema drew fine, applied fine, and the issues button
   * said **No issues** (QA BUG-3). A host that can check something the engine
   * cannot is the right place to check it, so the finding is folded in here —
   * once, on the single path every graph goes through.
   */
  const decorate = useCallback(
    (next: WorkflowGraph): WorkflowGraph => withArgumentTypes(next, registry),
    [registry],
  );

  useEffect(() => {
    void fetchAiStatus().then(setAi);
    // The public build is a static bundle: there is no `/api/run` to ask, and
    // asking anyway only buys a 404 in everyone's console.
    if (IS_PUBLIC_BUILD) {
      setRunnerAvailable(false);
      return;
    }
    void fetchRunStatus().then((status) => { setRunnerAvailable(status.available); });
  }, []);

  /*
   * Running the flow — 09 §1.
   *
   * The library does not execute anything and must not (00 §5, I7). What it
   * hands over is the projection: `nodeRanges(graph)` says which node owns which
   * piece of the file. The dev server takes that plus the source, runs it in a
   * worker thread, and reports back a `RunEvent` per step; everything the canvas
   * shows is a fold of those events.
   */
  const stopRun = useCallback(() => {
    runHandle.current?.stop();
    runHandle.current = null;
  }, []);

  /*
   * The trigger's payload — one state, two surfaces.
   *
   * The runner has always taken an `input`; the browser never sent one, so every
   * run in this demo started from values a machine guessed and nobody could see.
   * This is the state behind both places that now show them: the panel Run
   * opens, and the trigger node's inspector. 01 §1 says the first parameter type
   * *is* the trigger, so they are one thing seen twice, never two.
   */
  const triggerInput = useTriggerInput({
    exampleId: example.id,
    registryId: active.source.id,
    source: graph?.source.content ?? source,
    enabled: !IS_PUBLIC_BUILD && runnerAvailable,
  });

  const launchRun = useCallback(() => {
    if (graph === null) return;
    setTriggerOpen(false);
    runHandle.current?.stop();
    // Stamped from the first frame on, not from the first *event*: a run that
    // is still starting is already about a particular version of the flow, and
    // an unstamped snapshot in between would read as "version not recorded".
    setRun({ ...EMPTY_RUN, status: "starting", ...traceIdentity(graph) });
    setRunOpen(true);
    // The graph the ranges come from must be the graph on screen, or a step
    // would light up next to code it does not own.
    runHandle.current = startRun(
      runRequestFor(graph, graph.source.content, active.source, {
        // `undefined` means "you decide" — the endpoint synthesizes its own
        // default, which is what happens when the shape could not be read at
        // all. Anything else is the user's, verbatim.
        input: triggerInput.payload(),
        // The visitor's own servers, with the method→tool-name map discovery
        // produced. Without it the runner would have nothing to bind a tool it
        // has never heard of to, and every call would stub.
        servers: runSpecs(mcp.servers, tokenFor),
      }),
      setRun,
      // Which version of the flow this run is about. Copied off the graph, not
      // recomputed: a second hashing scheme would answer a subtly different
      // question than the one the comparison looks like it is asking.
      traceIdentity(graph),
    );
  }, [graph, active.source, triggerInput, mcp.servers]);

  /**
   * Run opens the panel first.
   *
   * "Just press Run" still works — the form is prefilled with the synthesized
   * default — but the values stop being invisible on the way past.
   */
  const beginRun = useCallback(() => {
    if (graph === null) return;
    if (triggerInput.status === "ready" && triggerInput.spec?.kind !== "none") {
      setTriggerOpen(true);
      return;
    }
    launchRun();
  }, [graph, triggerInput.status, triggerInput.spec, launchRun]);

  /**
   * The trigger node, in the inspector, is the input.
   *
   * Same controller as the pre-run panel — edit it here and the panel Run opens
   * is already showing what you typed, because there is only ever one of them.
   */
  const renderTriggerExtra = useCallback(
    (node: WorkflowNode): React.ReactNode =>
      node.type !== "trigger" ? null : (
        <section className="border-b border-line px-4 pb-4 pt-1" data-testid="inspector-trigger-input">
          <h3 className="m-0 mb-2 text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
            Starts the flow with
          </h3>
          <TriggerInputForm input={triggerInput} compact />
        </section>
      ),
    [triggerInput],
  );

  /*
   * Switching flow retires the run. Editing one does not.
   *
   * These are different questions and this effect only ever answered the first:
   * its dependency is `example.id`, so a re-analysis into a different graph of
   * the *same* flow left the run exactly where it was. The comment here used to
   * claim otherwise, which is worse than the gap it described — node ids are
   * stable across patches by design (I5), so the old values re-attach to the
   * very nodes whose code just changed, and nothing said so.
   *
   * Clearing on every edit is not the fix: last run's values are useful while
   * you edit, which is why n8n keeps them too. The fix is to say which version
   * they came from — `traceMatch` below — and let the panel caption it.
   */
  useEffect(() => {
    stopRun();
    setRun(EMPTY_RUN);
    setRunOpen(false);
  }, [example.id, stopRun]);

  /**
   * Whether the run on screen still describes the flow on screen.
   *
   * `stale` after any edit that moved the source or the registry; `unknown`
   * when the run carries no identity to compare (a run from an older build of
   * this page, restored state). `unknown` is uncertainty and is rendered as
   * uncertainty — never as `current`.
   */
  const traceMatch = useMemo(
    () => traceMatchFor(run, graph),
    [run, graph],
  );

  useEffect(() => () => { runHandle.current?.stop(); }, []);

  const runView = useMemo<RunView | null>(() => {
    if (run.status === "idle") return null;
    return {
      status:
        run.status === "starting" || run.status === "running"
          ? "running"
          : run.status === "ok"
            ? "ok"
            : run.status === "cancelled"
              ? "cancelled"
              : "failed",
      nodes: run.nodes,
      activeNodeId: run.activeNodeId,
      untraced: run.untraced,
      tracked: run.tracked,
      // Without this the library has no way to tell a current run from one that
      // predates an edit, so it has to hedge on every value it shows. The
      // comparison is already made here for the toolbar; the picture gets the
      // same answer rather than a second, weaker one.
      match: traceMatch,
    };
  }, [run, traceMatch]);

  const running = run.status === "starting" || run.status === "running";

  /*
   * A run that ended on an error selects the step it ended on.
   *
   * On an 87-node canvas the red border is findable only if you already know
   * where to look; selecting the step pans the canvas to it and opens the
   * inspector on the value and the message, which is the whole question a
   * failed run raises.
   */
  const failureShownRef = useRef<string | null>(null);
  useEffect(() => {
    if (run.status !== "failed" && run.status !== "timeout") return;
    // Earliest failure, not latest: the step that threw fails first and its
    // enclosing `try`/loop fail after it, so the newest failed node is an
    // ancestor and the oldest one is the culprit.
    const failed = [...run.nodes.values()]
      .filter((state) => state.status === "failed")
      .sort((a, b) => a.lastAt - b.lastAt)[0];
    if (failed === undefined) return;
    const key = `${run.plan?.runId ?? ""}:${failed.nodeId}`;
    if (failureShownRef.current === key) return;
    failureShownRef.current = key;
    setSelectedNodeId(failed.nodeId);
  }, [run.status, run.nodes, run.plan]);

  // ⌥⌘N new flow · ⌘K palette · ⌘O examples · ⌘J chat · ⌘B outline — the five
  // things this demo is for, each one key away.
  //
  // ⌥⌘N rather than the ⌘N a desktop app would use: ⌘N and ⇧⌘N are handled by
  // the browser itself before any page sees them, so binding either would
  // advertise a shortcut that opens a new window instead of a new flow. Read
  // through `event.code`, because Option changes `event.key` to a dead key.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.altKey) {
        if (event.code === "KeyN") {
          event.preventDefault();
          setNewFlowOpen(true);
        }
        return;
      }
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

  /**
   * What the graph on screen actually is — which flow, and which registry.
   *
   * `WorkflowGraph.registryHash` is the registry the graph was analyzed against
   * (06 §5), and comparing it to the live one is the only honest definition of
   * "the registry moved under this flow". The example id rides along because a
   * graph belonging to the *previous* flow is not stale, it is about to be
   * replaced — and the two facts have to be read together, in the same tick, or
   * switching flows looks exactly like a registry change.
   */
  const graphOrigin = useRef<{ exampleId: string; registryHash: string } | null>(null);
  const exampleIdRef = useRef(example.id);
  exampleIdRef.current = example.id;

  const analyze = useCallback(
    async (text: string, exampleId?: string) => {
      const started = performance.now();
      setAnalyzing(true);
      try {
        const next = decorate(await session.analyze(text, { trigger: { kind: "webhook", label: "Trigger" } }));
        const ms = Math.round(performance.now() - started);
        graphOrigin.current = { exampleId: exampleIdRef.current, registryHash: next.registryHash };
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
    [session, decorate],
  );

  // Only show the loading state if the wait is long enough to be one: a small
  // flow analyzes in tens of milliseconds and a flashed skeleton reads as jank.
  useEffect(() => {
    if (!analyzing) { setShowLoading(false); return; }
    const timer = setTimeout(() => { setShowLoading(true); }, 120);
    return () => { clearTimeout(timer); };
  }, [analyzing]);

  // Load whichever example is current — including the first one, so the app is
  // useful on first paint. On the very first pass this may be the restored text
  // rather than the example's own; `rememberStats` is then skipped on purpose,
  // so a gallery card keeps describing the example that shipped.
  const loadedRef = useRef<string | null>(null);
  const bootRef = useRef(RESTORED);
  useEffect(() => {
    if (loadedRef.current === example.id) return;
    loadedRef.current = example.id;
    const boot = bootRef.current;
    bootRef.current = null;
    const restored = boot !== null && boot.example.id === example.id;
    const text = restored ? boot.source : example.source;
    setSource(text);
    setSelectedNodeId(null);
    setGraph(null);
    graphOrigin.current = null;
    // Whatever the banner was saying, it was saying it about the flow that just
    // left the screen.
    setRegistryNote(null);
    setSaveOfferHidden(false);
    setElapsed(null);
    void analyze(text, restored ? undefined : example.id);
  }, [example, analyze]);

  /*
   * The registry moved under the open flow — 06 §5.
   *
   * A graph is a function of (source, registry), so changing which tools exist
   * makes the graph on screen stale no matter what the text says; core's own
   * check is `graph.registryHash !== session.registryHash()`, and the provider
   * already refuses to patch while that holds. Nothing new is invented here:
   * the flow is re-analyzed on the ordinary path, which is what turns a call to
   * a tool that no longer exists into an `unknown` node with a diagnostic
   * (04 §1.2) instead of a lie, and a banner says why the diagram just changed.
   */
  const registryHash = registry.registryHash();
  const sourceRef = useRef(source);
  sourceRef.current = source;
  useEffect(() => {
    /*
     * Deliberately *not* "the hash differs from the one I saw last render".
     * Every example names its own registry, so that test is true of every
     * example switch, and it cannot be rescued by also comparing the example
     * id: the effect above runs first and only *queues* `setGraph(null)`, so
     * in the one commit where `example.id` has already changed this effect is
     * still looking at the previous flow's graph. Which is how a banner ends
     * up interrupting the ordinary act of opening another flow.
     *
     * The question core asks is `graph.registryHash !== registry.registryHash()`
     * (06 §5, `session.applyPatch`), and `graphOrigin` is that pair plus the
     * flow it belongs to — all three written in one go, by whoever produced the
     * graph, so there is no window in which they disagree.
     */
    const origin = graphOrigin.current;
    // Nothing analyzed yet, or the graph on screen belongs to a flow that is
    // already being replaced. Neither is a registry that moved.
    if (origin === null || origin.exampleId !== example.id) return;
    if (origin.registryHash === registryHash) return;

    setRegistryNote(
      `The registry changed — this flow was redrawn against ${String(registry.listTools().length)} tools in ${String(registry.listToolNamespaces().length)} namespace${registry.listToolNamespaces().length === 1 ? "" : "s"}. Any call to a tool that is no longer there is now an unknown step.`,
    );
    // One tick later, and cancelled if the registry moves again first: ticking
    // five tool checkboxes in a row is five registry hashes, and re-analyzing a
    // 300-line flow five times to show the last result is four wasted passes.
    const handle = setTimeout(() => { void analyze(sourceRef.current); }, 0);
    return () => { clearTimeout(handle); };
    // `graph` is a dependency because `graphOrigin` is written beside it: the
    // re-analyze this effect schedules is what makes the two agree again, and
    // the effect has to run once more to see that it did.
  }, [registryHash, registry, example.id, graph, analyze]);

  /*
   * Keep the tab's own copy current, and — for a flow of the visitor's own —
   * the document too.
   *
   * Debounced: this fires on every keystroke in Monaco, and serializing a
   * 300-line file per character is not free.
   *
   * The asymmetry is the point. Editing *your* flow saves it, because it is
   * yours. Editing a built-in example writes only to the tab's scratch pad, so
   * the example itself is never mutated and the gallery stays trustworthy; the
   * bar over the canvas offers to make it yours the first time you change one.
   */
  useEffect(() => {
    const timer = setTimeout(() => {
      saveFlow({ exampleId: example.id, source });
      if (!isMine(example)) return;
      setMyFlows((current) => {
        const found = current.find((flow) => flow.id === example.id);
        // Returning the same array is how React is told nothing changed — the
        // save effect above must not fire on every keystroke.
        if (found === undefined || found.source === source) return current;
        forgetStats(example.id);
        return current.map((flow) =>
          flow.id === example.id ? { ...flow, source, updatedAt: Date.now() } : flow,
        );
      });
    }, 400);
    return () => { clearTimeout(timer); };
  }, [example, source]);

  /* --- creating, renaming, deleting, exporting ---------------------------- */

  /** Save it and open it — one commit, so the canvas never lags the list. */
  const createFlow = useCallback(
    (flow: MyFlow) => {
      setMyFlows((current) => [flow, ...current]);
      setNewFlowOpen(false);
      setSaveOfferHidden(false);
      setExample(asExample(flow));
      const generated = flow.generation;
      setCreationNote(
        generated === null
          ? null
          : generated.unresolved === null
            ? {
                tone: "ok",
                text: `“${flow.title}” reached ${generated.level} in ${String(generated.rounds)} round${generated.rounds === 1 ? "" : "s"} — every call resolves against ${active.source.label}.`,
              }
            : {
                tone: "warn",
                text: `“${flow.title}” is open, but it is not finished: ${generated.unresolved} The issues button on the canvas lists what the analyzer sees.`,
              },
      );
    },
    [active.source.label],
  );

  const renameFlow = useCallback((id: string, title: string) => {
    setMyFlows((current) =>
      current.map((flow) => (flow.id === id ? { ...flow, title, updatedAt: Date.now() } : flow)),
    );
    setExample((current) =>
      isMine(current) && current.id === id
        ? asExample({ ...current.mine, title, updatedAt: Date.now() })
        : current,
    );
  }, []);

  const deleteFlow = useCallback(
    (id: string) => {
      setMyFlows((current) => current.filter((flow) => flow.id !== id));
      forgetStats(id);
      // Deleting the flow on screen has to leave something on screen.
      setExample((current) => (current.id === id ? FIRST : current));
      toast.add({
        title: "Flow deleted",
        description: "It was only in this browser, so there is no other copy.",
      });
    },
    [toast],
  );

  /**
   * A real file, downloaded.
   *
   * The artifact people want to take to a repository is a `.flow.ts`, so that is
   * what comes out: the source verbatim, with one comment line carrying the name
   * and the registry so re-importing it here restores both instead of guessing.
   */
  const exportFlow = useCallback(
    (flow: Pick<MyFlow, "title" | "registryChoice" | "source">) => {
      try {
        const blob = new Blob([exportFlowFile(flow)], { type: "text/plain;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileNameFor(flow);
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => { URL.revokeObjectURL(url); }, 2000);
        toast.add({ title: "Exported", description: `${fileNameFor(flow)} — drop it in a repo next to a generated tools.d.ts.` });
      } catch (cause) {
        toast.add({
          title: "Could not export",
          description: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [toast],
  );

  /**
   * "This is somebody else's example and you have changed it."
   *
   * Editing a built-in flow must not quietly become an edit *to* the built-in
   * flow — the gallery is only worth anything if what it promises is what opens.
   * So the change lives in the tab until it is made into a flow of the visitor's
   * own, and this is that one action.
   */
  const saveAsMine = useCallback(() => {
    const now = Date.now();
    const flow: MyFlow = {
      id: newFlowId(),
      title: uniqueTitle(example.title, myFlows),
      source,
      registryChoice: active.fromMcp ? MCP_REGISTRY : active.source.id,
      createdAt: now,
      updatedAt: now,
      origin: { exampleId: example.id, exampleTitle: example.title },
      prompt: null,
      generation: null,
    };
    setMyFlows((current) => [flow, ...current]);
    setExample(asExample(flow));
    setSaveOfferHidden(false);
    setCreationNote(null);
    toast.add({
      title: "Saved as your flow",
      description: `“${flow.title}” is yours now; “${example.title}” is back to how it shipped.`,
    });
  }, [example, source, myFlows, active, toast]);

  const dirtyExample =
    !isMine(example) && graph !== null && source.trim() !== example.source.trim();

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
      graphOrigin.current = { exampleId: exampleIdRef.current, registryHash: result.graph.registryHash };
      setGraph(decorate(result.graph));
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
    [toast, decorate],
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
      onGraphSync={(next) => {
        graphOrigin.current = { exampleId: exampleIdRef.current, registryHash: next.registryHash };
        setGraph(decorate(next));
      }}
      onReanalyze={() => { void analyze(source); }}
      run={runView}
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
            onPick={(next) => { setCreationNote(null); setExample(next); }}
            mine={myFlows}
            onNew={() => { setNewFlowOpen(true); }}
            onRename={renameFlow}
            onDelete={deleteFlow}
            onExport={exportFlow}
            lookupFor={(candidate) =>
              isMine(candidate)
                ? resolveRegistry(candidate, { composed: mcp.composed, active: mcp.active }).lookup
                : undefined
            }
            storageError={flowStorageError}
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

          {/* The way in for someone with nothing open yet — next to the picker,
              not hidden behind it. */}
          <Hint label="Start a new flow — describe it and the AI writes it, or start blank">
            <Button
              variant="primary"
              size="md"
              data-testid="new-flow"
              aria-label="New flow"
              onClick={() => { setNewFlowOpen(true); }}
            >
              <Plus />
              <span className="hidden sm:inline">New</span>
              <span className="ml-1 hidden rounded bg-white/20 px-1 py-0.5 text-[10px] leading-none lg:inline">
                ⌥⌘N
              </span>
            </Button>
          </Hint>

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

          {runnerAvailable ? (
            <Hint
              label={
                running
                  ? "Stop the run"
                  : graph === null
                    ? "Draw the diagram first"
                    : "Run this flow for real and watch each step light up"
              }
            >
              <Button
                variant={running ? "soft" : "primary"}
                size="md"
                data-testid="run"
                disabled={graph === null}
                aria-label={running ? "Stop the run" : "Run this flow"}
                onClick={() => { running ? stopRun() : beginRun(); }}
              >
                {running ? <Square /> : <Play />}
                {running ? "Stop" : "Run"}
              </Button>
            </Hint>
          ) : (
            /*
             * Run without a runner behind it.
             *
             * This used to render nothing at all, which is the quiet kind of
             * dishonesty 07 §5 rules out: a reader of the hosted demo would
             * simply never learn the feature exists, and a reader who had seen
             * it locally would think it broke. So the control stays, says it is
             * unavailable, and says why when asked — the same rule the editor
             * follows for an operation the patch engine cannot do.
             */
            <Hint label={`${RUN_UNAVAILABLE_REASON} Click for how to run it locally.`}>
              <Button
                variant="ghost"
                size="md"
                data-testid="run-unavailable"
                aria-label="Why Run is unavailable here"
                onClick={() => { setRunUnavailableOpen(true); }}
              >
                <Play />
                Run
                <span className="text-[10.5px] text-ink-faint">local only</span>
              </Button>
            </Hint>
          )}

          {running ? (
            <span className="hidden items-center gap-1.5 text-[11.5px] text-ink-dim sm:flex" data-testid="run-inline-progress">
              <LoaderCircle className="size-3 animate-spin text-accent" />
              {run.nodes.size} step{run.nodes.size === 1 ? "" : "s"} · {run.elapsedMs}ms
            </span>
          ) : run.status !== "idle" && traceMatch !== "current" ? (
            /* The values on the canvas are still there, and they are no longer
               about this code. Saying so is the whole point — 07 §5. */
            <Hint label={TRACE_MATCH_HINT[traceMatch]}>
              <span
                className="hidden items-center gap-1.5 text-[11.5px] text-warn sm:flex"
                data-testid="run-trace-match"
              >
                <CircleAlert className="size-3" />
                {TRACE_MATCH_LABEL[traceMatch]}
              </span>
            </Hint>
          ) : null}

          <GraphSummary elapsed={elapsed} />

          <div className="ml-auto flex items-center gap-2">
            {run.status === "idle" ? null : (
              <Hint label={runOpen ? "Hide the run log" : "Show the run log"}>
                <Button
                  variant={runOpen ? "soft" : "ghost"}
                  size="icon"
                  data-testid="toggle-run-log"
                  aria-label="Show the run log"
                  aria-pressed={runOpen}
                  onClick={() => { setRunOpen((open) => !open); }}
                >
                  <Play />
                </Button>
              </Hint>
            )}
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
            <Hint
              label={
                active.fromMcp
                  ? `Your MCP servers are the registry — ${String(active.source.tools.length)} tools`
                  : "Bring your own MCP servers — their tools become nodes"
              }
            >
              <Button
                variant={active.fromMcp ? "soft" : "ghost"}
                size="icon"
                data-testid="toggle-mcp"
                aria-label="MCP servers"
                aria-pressed={mcpOpen}
                onClick={() => { setMcpOpen(true); }}
              >
                <ServerCog />
              </Button>
            </Hint>
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

        {registryNote === null ? null : (
          <div className="shrink-0 border-b border-line px-3 py-2">
            <Notice
              tone="info"
              role="status"
              title="The registry changed"
              data-testid="registry-changed"
              onDismiss={() => { setRegistryNote(null); }}
            >
              {registryNote}
            </Notice>
          </div>
        )}

        {/*
          A generated flow that is not finished says so — 07 §5. It still opens,
          because the most instructive thing this demo does is show what the
          model could not resolve and why; it is never dressed up as complete.
        */}
        {creationNote === null ? null : (
          <div className="shrink-0 border-b border-line px-3 py-2">
            <Notice
              tone={creationNote.tone}
              role="status"
              title={creationNote.tone === "ok" ? "Your flow is open" : "Your flow is open, but unfinished"}
              data-testid="creation-note"
              onDismiss={() => { setCreationNote(null); }}
            >
              {creationNote.text}
            </Notice>
          </div>
        )}

        {/* The flow asked for a registry that is not here — said out loud
            rather than resolved against something else. */}
        {active.note === null ? null : (
          <div className="shrink-0 border-b border-line px-3 py-2">
            <Notice tone="warn" role="status" title="These tools are not connected" data-testid="registry-missing">
              {active.note}
            </Notice>
          </div>
        )}

        {/*
          Editing somebody else's example.

          The gallery is worth something only if what it promises is what opens,
          so an edit to a built-in flow stays in this tab until it is made into a
          flow of the visitor's own. This is the offer, once, dismissible.
        */}
        {dirtyExample && !saveOfferHidden ? (
          <div className="shrink-0 border-b border-line px-3 py-2">
            <Notice
              tone="info"
              role="status"
              title={`You have changed “${example.title}”`}
              data-testid="save-as-mine"
              onDismiss={() => { setSaveOfferHidden(true); }}
              actions={
                <>
                  <Button variant="primary" size="sm" data-testid="save-as-mine-go" onClick={saveAsMine}>
                    Save as my flow
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    data-testid="save-as-mine-revert"
                    onClick={() => { setSource(example.source); void analyze(example.source); }}
                  >
                    Put the example back
                  </Button>
                </>
              }
            >
              The built-in example is unchanged — this edit lives in this tab only, and a reload of a
              different flow will lose it. Save it as your own and it becomes a document in this
              browser, with its own name, registry and trigger input.
            </Notice>
          </div>
        ) : null}

        {flowStorageError === null ? null : (
          <div className="shrink-0 border-b border-line px-3 py-2">
            <Notice tone="warn" role="alert" title="Your flows are not being saved" data-testid="flow-storage-error">
              {flowStorageError}
            </Notice>
          </div>
        )}

        {/* ---------------------------------------------------------------- */}
        {/* outline + canvas + inspector                                      */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex min-h-0 flex-1">
          {wide && runOpen ? (
            <aside className="w-[20rem] shrink-0 border-r border-line xl:w-[22rem]">
              <RunPanel
                run={run}
                match={traceMatch}
                onStart={beginRun}
                onStop={stopRun}
                onClose={() => { setRunOpen(false); }}
              />
            </aside>
          ) : null}
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
                {/* Next to the canvas, not up in the top bar: it changes what
                    is drawn a few pixels away, and a view switch belongs beside
                    the view it switches. */}
                <DataLinksToggle iconOnly={!roomy} className="bg-surface/85 shadow-xs backdrop-blur" />
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
                registry={active.source}
                registryLookup={active.lookup}
                configured={ai.configured}
                model={ai.model}
                aiMode={ai.mode ?? "proxy"}
                onKeyChange={() => { void fetchAiStatus().then(setAi); }}
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
                <NodeInspector theme={theme} renderExtra={renderTriggerExtra} />
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
          <NodeInspector theme={theme} renderExtra={renderTriggerExtra} onClose={() => { setInspectorOpen(false); }} />
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
            registry={active.source}
            registryLookup={active.lookup}
            configured={ai.configured}
            model={ai.model}
            aiMode={ai.mode ?? "proxy"}
            onKeyChange={() => { void fetchAiStatus().then(setAi); }}
            onApplySource={applyGeneratedSource}
            onClose={() => { setChatOpen(false); }}
          />
        </Sheet>
      ) : null}

      {/*
        Bring your own tools. Everything else on this page reads whatever this
        panel composes — the palette, the analyzer, the AI context and the Run
        bindings — which is the demonstration, not a side feature.
      */}
      <McpManager
        open={mcpOpen}
        onOpenChange={setMcpOpen}
        state={mcp}
        lookup={active.lookup}
        fromMcp={active.fromMcp}
        fallbackLabel={active.source.label}
      />

      {/*
        Start from nothing.

        Generation runs through the same `generate-flow.ts` pipeline the chat
        panel uses — one loop, one place it can drift from — and the rounds are
        drawn as they land rather than hidden behind a spinner.
      */}
      <NewFlowDialog
        open={newFlowOpen}
        onOpenChange={setNewFlowOpen}
        existing={myFlows}
        composed={mcp.composed}
        configured={ai.configured}
        model={ai.model}
        aiMode={ai.mode ?? "proxy"}
        onKeyChange={() => { void fetchAiStatus().then(setAi); }}
        onCreate={createFlow}
      />

      {/*
        Why Run is not here. 07 §5: a feature the build cannot do says so, in
        words, with what to do instead — never a button that silently does
        nothing, and never a button that quietly disappears.
      */}
      {/* ------------------------------------------------------------------ */}
      {/* what the run starts from — between Run and the run                  */}
      {/* ------------------------------------------------------------------ */}
      <TriggerInputDialog
        open={triggerOpen}
        onOpenChange={setTriggerOpen}
        input={triggerInput}
        onRun={launchRun}
        flowName={example.title}
      />

      <Modal
        open={runUnavailableOpen}
        onOpenChange={setRunUnavailableOpen}
        title="Run needs a local checkout"
        description="Everything else on this page already ran in your browser."
      >
        <div className="cf-scroll flex min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3.5 text-[12.5px] leading-relaxed text-ink-dim">
          <Notice tone="info" title="Why">
            {RUN_UNAVAILABLE_REASON}
          </Notice>
          <div>
            <p className="m-0 font-medium text-ink">{RUN_UNAVAILABLE_FIX}</p>
            <pre className="mt-1.5 overflow-x-auto rounded-lg border border-line bg-surface-2 p-2.5 font-mono text-[11.5px] text-ink">
{`git clone ${REPO_URL}
cd codeflow && pnpm install
pnpm dev`}
            </pre>
          </div>
          <p className="m-0 text-ink-faint">
            What you are looking at is not a mock-up of the product with the interesting part
            missing: analyze, the graph, the inspector, editing and the byte-for-byte diff are all{" "}
            <code className="font-mono text-[11px]">@codeflow/core</code>, which is browser-safe by
            design and is running here. Only executing a flow against real MCP servers needs a
            machine.
          </p>
        </div>
      </Modal>
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
