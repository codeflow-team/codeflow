/**
 * `<ChatPanel>` — write and change flows in words.
 *
 * Two things make this more than a chat box glued onto a demo:
 *
 * 1. **The prompt is the library's, not this app's.** The system message is
 *    `renderSystemPrompt(session.buildGenerationContext())` — the flow contract,
 *    the style guide and the generated `tools.d.ts` / `lib.d.ts` of *this
 *    example's registry* (10 §1, §3). The model can only call tools that exist.
 * 2. **The answer is checked before it is offered.** Every round is scored on
 *    the conformance ladder with `validateFlowSource` and, below the target
 *    level, the analyzer's own diagnostics are fed back with
 *    `renderDiagnosticsFeedback` — up to two retries, exactly the loop of
 *    10 §5. Every round is shown: level, diagnostics, time.
 *
 * Applying is always a second, explicit step: a change to a single field goes
 * through the patch engine (`previewPatch` → `<CodeDiff>` → `patchNode`) so it
 * stays a minimal, identity-preserving edit (06 §4); anything structural is a
 * whole-file rewrite, shown as a line diff, *said out loud* as one, and priced
 * in steps added/removed/changed before you can accept it.
 *
 * What the checks are is stated exactly, and no wider than it is true: syntax,
 * the flow contract, imports, tool resolution, mapping quality — plus the one
 * type check a browser can honestly make (`argument-types.ts`). There is no full
 * TypeScript type check here and the panel does not imply there is (07 §5).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  renderDiagnosticsFeedback,
  renderSystemPrompt,
  validateFlowSource,
  type ConformanceLevel,
  type Diagnostic,
  type RegistryLookup,
  type TextPatch,
  type WorkflowGraph,
} from "@codeflow/core";
import {
  Badge,
  Button,
  CodeDiff,
  Input,
  Notice,
  Segmented,
  cn,
  useCodeFlow,
} from "@codeflow/react";
import {
  Check,
  CircleStop,
  FileCode,
  LoaderCircle,
  RotateCcw,
  Send,
  Sparkles,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  callModel,
  clearUserKey,
  diffLines,
  extractJson,
  getUserKey,
  setUserKey,
  splitAnswer,
  type AiMode,
  type ChatMessage,
} from "./ai.js";
import { REPO_URL } from "./deployment.js";
import { registryFor, type ExampleRegistry, type FlowExample } from "./examples-source.js";
import { registryInstanceFor } from "./registry.js";
import { argumentTypeProblems, type ArgumentTypeProblem } from "./argument-types.js";
import { removalTone, rewriteScope, type RewriteScope } from "./rewrite-scope.js";
import { loadChat, saveChat } from "./persist.js";

const TARGET: "L1" = "L1";
const MAX_ROUNDS = 3;

/**
 * Openers that name tools the model can actually reach.
 *
 * A suggestion is a promise about what this flow's registry contains, so it is
 * keyed by registry rather than written once: offering "read every file in
 * /tmp/logs" to a flow whose only tools are GitHub and Slack sets the model up
 * to fail and teaches the reader the wrong thing about the contract. Registries
 * with nothing written for them fall back to shapes rather than tool names.
 */
const OPENERS: Record<string, string[]> = {
  sample: [
    "For every new pull request, post its title to #releases",
    "Alert #oncall when a pull request changes more than ten files",
    "Read each PR's files and skip the ones that only touch tests",
  ],
  "repo-triage": [
    "Read every file in the repository root and remember the risky ones",
    "Walk the allowed directories and write a summary file for each one",
    "Search memory for what changed last run, then re-read only those files",
  ],
  research: [
    "Search the web for a topic, read the top result, and file a brief",
    "Ask three sources in parallel and keep whichever answers first",
    "Retry the search up to three times before giving up",
  ],
  "browser-qa": [
    "Open a page, take a snapshot, and save it next to the report",
    "Click through a login form and screenshot whatever comes back",
    "Retry a failing step twice, then close the browser either way",
  ],
  pipeline: [
    "Read every CSV in the drop folder and total them by region",
    "Enrich each row from three sources at once, then write the ledger",
    "Stop the whole run if any file fails to parse",
  ],
};

const GENERIC_OPENERS = [
  "Do the first step, then loop over whatever it gives back",
  "Wrap the risky step in a try and report the failure",
  "Run the independent steps in parallel, then join the results",
];

/**
 * Asked for in front of the file, and shown above the diff.
 *
 * 10 §4's own output rule is "no explanation before or after" — right for an
 * eval harness reading the answer with a script, wrong for a person who is being
 * asked to accept a three-hundred-line rewrite. `splitAnswer` handles both
 * shapes, so relaxing it here costs nothing if the model ignores it.
 */
const SAY_WHAT_YOU_DID =
  'First write ONE short sentence in plain English: what this flow does, and anything you could not do — a step with no matching tool, an assumption you had to make. Then the complete file inside one ```ts fence.';

type Turn =
  | { kind: "user"; id: number; text: string }
  | {
      kind: "note";
      id: number;
      tone: "info" | "warn" | "danger" | "ok";
      text: string;
      /** Failed request whose prompt is still in the box — offers "Try again". */
      retry?: boolean;
    }
  | {
      kind: "round";
      id: number;
      round: number;
      level: ConformanceLevel;
      diagnostics: Diagnostic[];
      ms: number;
    };

/** `Omit` over a union has to distribute, or every member loses its own fields. */
type NewTurn = Turn extends infer T ? (T extends { id: number } ? Omit<T, "id"> : never) : never;

type Proposal =
  | {
      kind: "rewrite";
      source: string;
      level: ConformanceLevel;
      rounds: number;
      reason: string | null;
      /** The model's own sentence about what it built (BUG-13). */
      prose: string | null;
      /** Steps added/removed/changed, so the blast radius is visible (BUG-5). */
      scope: RewriteScope | null;
      removal: "none" | "expected" | "unrequested";
      /** A brand-new flow replaces everything — that is the request, not a surprise. */
      replacing: boolean;
      /** Literal arguments that contradict their schema (BUG-3). */
      typeProblems: ArgumentTypeProblem[];
      /** Kept so Apply can carry them into the transcript (BUG-6). */
      warnings: Diagnostic[];
    }
  | {
      kind: "patch";
      nodeId: string;
      nodeLabel: string;
      changes: Record<string, unknown>;
      patches: readonly TextPatch[];
      typeProblems: ArgumentTypeProblem[];
    };

/**
 * The conversation, kept outside React — and outside the page.
 *
 * The panel docks beside the canvas on a wide window and slides over it on a
 * narrow one, which are two different places in the tree — so crossing that
 * width unmounts one and mounts the other, and component state would take the
 * whole conversation with it. Resizing a window is not "clear the chat", and
 * neither is a reload: the module-level store below survives the remount, and
 * `sessionStorage` survives the page (see `persist.ts`).
 */
interface Kept {
  turns: Turn[];
  input: string;
  proposal: Proposal | null;
  nextId: number;
}

const kept: Kept = restore();

function restore(): Kept {
  const saved = loadChat<Kept>();
  if (saved === null || !Array.isArray(saved.turns)) {
    return { turns: [], input: "", proposal: null, nextId: 1 };
  }
  return {
    turns: saved.turns,
    input: typeof saved.input === "string" ? saved.input : "",
    // Only a rewrite is worth restoring: a patch proposal is a set of byte
    // offsets into a source, and a source that came back from storage has no
    // business being patched at coordinates measured before the reload.
    proposal: saved.proposal !== null && saved.proposal?.kind === "rewrite" ? saved.proposal : null,
    nextId: typeof saved.nextId === "number" ? saved.nextId : saved.turns.length + 1,
  };
}

/** Thrown when the user moves to a different flow while an answer is in flight. */
class FlowChanged extends Error {
  constructor(public readonly from: string) {
    super("flow changed");
    this.name = "FlowChanged";
  }
}

export interface ChatPanelProps {
  example: FlowExample;
  /**
   * The registry the model is given, when it is not the example's own.
   *
   * The demo lets a visitor bring their own MCP servers (`McpManager.tsx`), and
   * the composed registry is what everything else already resolves against — so
   * it has to be what goes into `tools.d.ts` here too, or the panel would offer
   * a tool surface the analyzer does not recognise. Omitted, this falls back to
   * `registryFor(example)` and nothing changes.
   */
  registry?: ExampleRegistry;
  /** The same registry, built. Defaults to the example's. */
  registryLookup?: RegistryLookup;
  configured: boolean;
  model: string;
  /**
   * Who holds the key: `proxy` (the local dev server does) or `byok` (the
   * visitor does, in their own browser). See `ai.ts`. It changes what the panel
   * offers when there is no key, and it changes where the request goes.
   */
  aiMode: AiMode;
  /** Called after the visitor saves or clears their own key, so the host re-reads the status. */
  onKeyChange?: () => void;
  /** Replaces the whole file — the host owns the source (00 §2.1). */
  onApplySource: (source: string) => void;
  onClose?: () => void;
  className?: string;
}

/**
 * The key box for the hosted build — bring your own.
 *
 * There is no server here to hold a key, and a shared one baked into a
 * serverless function is a key anyone can drain, so the honest arrangement is
 * that the visitor supplies theirs. The copy says exactly where it goes,
 * because "paste your API key" with no explanation is a thing a reader is right
 * to refuse: it is stored in this browser's `localStorage`, and the request
 * goes from this page straight to `openrouter.ai` — the origin serving this
 * page never sees it and could not use it if it did.
 *
 * Everything else in the demo — analyze, graph, inspect, patch, diff — needs no
 * key at all, which is why this is a small box in one panel and not a wall in
 * front of the app.
 */
function ByokKeyBox(props: {
  configured: boolean;
  model: string;
  onChanged?: () => void;
}): ReactNode {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(!props.configured);

  if (props.configured && !editing) {
    const key = getUserKey() ?? "";
    return (
      <Notice tone="ok" title="Using your OpenRouter key">
        <p className="m-0">
          <code className="font-mono text-[11px]">{key.slice(0, 8)}…{key.slice(-4)}</code> — stored
          in this browser only, sent straight to openrouter.ai. Model:{" "}
          <code className="font-mono text-[11px]">{props.model}</code>.
        </p>
        <div className="mt-2 flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => { setDraft(""); setEditing(true); }}>
            Replace
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              clearUserKey();
              setEditing(true);
              props.onChanged?.();
            }}
          >
            Forget it
          </Button>
        </div>
      </Notice>
    );
  }

  return (
    <Notice tone="info" title="Ask AI needs a key — yours">
      <p className="m-0">
        This is the hosted demo: it is a static site with no server, so there is no key here to
        borrow. Paste an <a className="underline" href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">OpenRouter key</a>{" "}
        and it is kept in this browser&apos;s local storage and sent only to{" "}
        <code className="font-mono text-[11px]">openrouter.ai</code> — never to the site serving this
        page. <code className="font-mono text-[11px]">{props.model}</code> is free there.
      </p>
      <p className="m-0 mt-1.5 text-ink-faint">
        Everything else — the graph, the inspector, editing, the diff — works without any key.
      </p>
      <div className="mt-2 flex gap-2">
        <Input
          mono
          type="password"
          value={draft}
          placeholder="sk-or-v1-…"
          aria-label="Your OpenRouter API key"
          data-testid="byok-input"
          className="min-w-0 flex-1"
          onChange={(event) => { setDraft(event.target.value); }}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={draft.trim().length < 12}
          data-testid="byok-save"
          onClick={() => {
            setUserKey(draft);
            setDraft("");
            setEditing(false);
            props.onChanged?.();
          }}
        >
          Use it
        </Button>
      </div>
      <p className="m-0 mt-2 text-[11px] text-ink-faint">
        Prefer not to? Run it locally instead — <code className="font-mono text-[11px]">git clone {REPO_URL}</code>,{" "}
        <code className="font-mono text-[11px]">pnpm dev</code>, and the key stays in the dev server.
      </p>
    </Notice>
  );
}

export function ChatPanel(props: ChatPanelProps): ReactNode {
  const { session, graph, source, selectedNode, previewPatch, patchNode } = useCodeFlow();

  const [turns, setTurns] = useState<Turn[]>(kept.turns);
  const [input, setInput] = useState(kept.input);
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [busy, setBusy] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [written, setWritten] = useState<{ chars: number; tail: string; thinking: number }>({
    chars: 0,
    tail: "",
    thinking: 0,
  });
  const [proposal, setProposal] = useState<Proposal | null>(kept.proposal);
  const [applying, setApplying] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(kept.nextId);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const propRegistry = props.registry;
  const propLookup = props.registryLookup;
  const registry = useMemo(
    () => propRegistry ?? registryFor(props.example),
    [propRegistry, props.example],
  );
  const registryLookup = useMemo(
    () => propLookup ?? registryInstanceFor(props.example),
    [propLookup, props.example],
  );

  /** Which flow the in-flight request belongs to (BUG-4). */
  const inFlightFor = useRef<{ exampleId: string; title: string } | null>(null);

  kept.turns = turns;
  kept.input = input;
  kept.proposal = proposal;
  kept.nextId = nextId.current;

  // Persisting on every keystroke would serialize the transcript per character;
  // once things settle is soon enough to survive a reload.
  useEffect(() => {
    const timer = setTimeout(() => { saveChat(kept); }, 400);
    return () => { clearTimeout(timer); };
  }, [turns, input, proposal]);

  // Selecting a step is the clearest signal that the next request is about it.
  useEffect(() => {
    if (selectedNode !== null) setMode("edit");
  }, [selectedNode]);

  useEffect(() => {
    if (busy === null) return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => { setElapsed(Math.round((Date.now() - started) / 1000)); }, 250);
    return () => { clearInterval(timer); };
  }, [busy]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns, proposal, busy]);

  const push = useCallback((turn: NewTurn): void => {
    setTurns((current) => [...current, { ...turn, id: nextId.current++ } as Turn]);
  }, []);

  /* --- the conversation belongs to a flow -------------------------------- */

  const exampleId = props.example.id;
  const exampleTitle = props.example.title;
  const registryId = registry.id;
  const seen = useRef<{ exampleId: string; registryId: string } | null>({ exampleId, registryId });

  useEffect(() => {
    const previous = seen.current;
    seen.current = { exampleId, registryId };
    if (previous === null) return;
    // Either half moving is enough: the registry can now change *without* the
    // flow changing, because the visitor can add or drop an MCP server while
    // the same file stays open (`McpManager.tsx`).
    if (previous.exampleId === exampleId && previous.registryId === registryId) return;

    // A proposal is a diff against a file that is no longer open. Always drop it.
    setProposal(null);

    // An answer still being written was written *about the old flow* — its
    // source went into the prompt. Applying it here would edit a file the model
    // never saw (BUG-4), so it is cancelled and said out loud.
    if (abortRef.current !== null) abortRef.current.abort(new FlowChanged(inFlightFor.current?.title ?? "that flow"));

    // A different registry is a different set of tools, so every answer above
    // was written against a contract that no longer holds (BUG-11).
    if (previous.registryId !== registryId) {
      setTurns([]);
      nextId.current = 1;
      push({
        kind: "note",
        tone: "info",
        text:
          previous.exampleId === exampleId
            ? `The registry changed — this flow now runs on ${registry.label} (${String(registry.tools.length)} tools). The earlier conversation was written against a different tool set, so it was cleared.`
            : `Now editing “${exampleTitle}”, which runs on ${registry.label} (${String(registry.tools.length)} tools). The earlier conversation was written against a different tool set, so it was cleared.`,
      });
    }
  }, [exampleId, registryId, exampleTitle, registry, push]);

  const effectiveMode = selectedNode === null ? "create" : mode;

  /* --- progress ----------------------------------------------------------- */

  const lastFlush = useRef(0);
  const onDelta = useCallback((_delta: string, whole: string): void => {
    const now = Date.now();
    if (now - lastFlush.current < 120) return;
    lastFlush.current = now;
    setWritten((current) => ({ ...current, chars: whole.length, tail: whole.slice(-220) }));
  }, []);

  const onThinking = useCallback((characters: number): void => {
    setWritten((current) => ({ ...current, thinking: characters }));
  }, []);

  const stage = useCallback((label: string): void => {
    setBusy(label);
    setWritten({ chars: 0, tail: "", thinking: 0 });
    lastFlush.current = 0;
  }, []);

  /* --- the two loops ----------------------------------------------------- */

  const generateSource = useCallback(
    async (intent: string, existing: string | null, signal: AbortSignal): Promise<void> => {
      if (session === null) return;
      const context = await session.buildGenerationContext({
        includeExamples: true,
        ...(existing === null ? {} : { existingSource: existing }),
      });
      const system = renderSystemPrompt(context);

      const messages: ChatMessage[] = [
        { role: "system", content: system },
        {
          role: "user",
          content:
            existing === null
              ? `${intent}\n\n${SAY_WHAT_YOU_DID}`
              : `Here is the flow file as it stands:\n\n\`\`\`ts\n${existing}\`\`\`\n\nChange it so that: ${intent}\n\n${SAY_WHAT_YOU_DID} It must be the complete updated file, not a fragment.`,
        },
      ];

      let accepted:
        | { source: string; level: ConformanceLevel; rounds: number; prose: string | null; graph: WorkflowGraph | null; diagnostics: Diagnostic[] }
        | null = null;

      for (let round = 1; round <= MAX_ROUNDS; round++) {
        stage(
          round === 1
            ? existing === null
              ? "Writing the flow…"
              : "Rewriting the file…"
            : `Fixing what validation found (round ${String(round)})…`,
        );
        const answer = await callModel(messages, {
          signal,
          onDelta,
          onThinking,
          mode: props.aiMode,
          model: props.model,
        });
        stage("Checking it against the flow contract…");
        const { source: candidate, prose } = splitAnswer(answer.content);
        const result = validateFlowSource(candidate, registryLookup);

        const typed =
          result.graph === null ? [] : argumentTypeProblems(result.graph, registryLookup);
        const diagnostics: Diagnostic[] = [
          ...result.diagnostics,
          ...typed.map((problem) => ({
            severity: "error" as const,
            code: "argument-type-mismatch",
            message: problem.message,
          })),
        ];

        push({ kind: "round", round, level: result.level, diagnostics, ms: answer.ms });

        accepted = {
          source: candidate,
          level: result.level,
          rounds: round,
          prose,
          graph: result.graph,
          diagnostics,
        };
        if (result.level === "L1" || result.level === "L2") break;

        const feedback = renderDiagnosticsFeedback(result, { target: TARGET });
        if (feedback === null) break;
        if (round === MAX_ROUNDS) {
          push({
            kind: "note",
            tone: "warn",
            text: `Still below ${TARGET} after ${String(MAX_ROUNDS)} rounds — the file below is the best answer; look at what the checks found before applying it.`,
          });
          break;
        }
        messages.push({ role: "assistant", content: answer.content }, { role: "user", content: feedback });
      }

      if (accepted === null) return;

      const scope =
        accepted.graph !== null && graph !== null ? rewriteScope(graph, accepted.graph) : null;
      const typeProblems =
        accepted.graph === null ? [] : argumentTypeProblems(accepted.graph, registryLookup);

      setProposal({
        kind: "rewrite",
        source: accepted.source,
        level: accepted.level,
        rounds: accepted.rounds,
        reason: existing === null ? null : "This edit rewrites the whole file.",
        prose: accepted.prose,
        scope,
        // Asking for a new flow *is* asking for the old steps to go, so the
        // removal warning only applies when an existing file is being edited.
        removal: scope === null || existing === null ? "none" : removalTone(scope, intent),
        replacing: existing === null,
        typeProblems,
        warnings: accepted.diagnostics.filter(
          (diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning",
        ),
      });
    },
    [session, push, graph, registryLookup, onDelta, onThinking, stage],
  );

  const editSelected = useCallback(
    async (intent: string, signal: AbortSignal): Promise<void> => {
      if (session === null || graph === null || selectedNode === null) return;
      const node = selectedNode;
      const region = graph.source.content.slice(node.source.start.offset, node.source.end.offset);

      const context = await session.buildGenerationContext({ includeExamples: false });
      const system = renderSystemPrompt(context, { title: "CodeFlow — editing one step" });

      const ask = [
        `The user has selected one step of this flow and asked for a change.`,
        "",
        `Step: "${node.label}" (type: ${node.type}${
          typeof node.data["toolName"] === "string" ? `, tool: ${node.data["toolName"]}` : ""
        })`,
        "Its source, exactly as written in the file:",
        "```ts",
        region,
        "```",
        "",
        `The request: ${intent}`,
        "",
        "Answer with ONE JSON object and nothing else.",
        "",
        "If the request is only about the values of this step, answer with a minimal patch:",
        '  {"mode":"patch","changes":{ <field>: <value>, … },"why":"one sentence"}',
        "  where <value> is:",
        '    "plain text"                      — same form as the current value',
        "    42 / true                         — a number or boolean literal",
        '    {"kind":"expression","text":"x.y"} — a bare expression',
        '    {"kind":"template","text":"a ${b}"} — a template literal body',
        '    {"kind":"remove"}                 — remove the property',
        "  Whole-step operations, one at a time, instead of fields:",
        '    {"$condition":{"kind":"expression","text":"…"}}  (condition / while)',
        '    {"$iterable":{"kind":"expression","text":"…"}}   (for…of)',
        '    {"$tool":"namespace.name"}                       (swap to a compatible tool)',
        '    {"$delete":true}                                 (delete this step)',
        "",
        "If the request needs new steps, moved steps, or any change outside this one",
        'statement, answer instead with: {"mode":"rewrite","why":"one sentence"}.',
      ].join("\n");

      stage(`Working out the smallest change to “${node.label}”…`);
      const answer = await callModel(
        [
          { role: "system", content: system },
          { role: "user", content: ask },
        ],
        { signal, onDelta, onThinking, mode: props.aiMode, model: props.model },
      );

      const parsed = extractJson(answer.content) as
        | { mode?: string; changes?: Record<string, unknown>; why?: string }
        | null;

      if (parsed === null) {
        push({
          kind: "note",
          tone: "warn",
          text: "The answer did not come back in a form this panel can turn into a single-field change, so it is rewriting the whole file instead.",
        });
        await generateSource(intent, source, signal);
        return;
      }

      if (parsed.mode === "rewrite" || parsed.changes === undefined) {
        // The model's own sentence already says it needs more than one
        // statement; appending a second, near-identical clause made the note
        // read as two half-sentences glued together (BUG-10).
        push({
          kind: "note",
          tone: "info",
          text: parsed.why ?? "This needs more than one statement, so the whole file is being rewritten.",
        });
        await generateSource(intent, source, signal);
        return;
      }

      const preview = previewPatch(node.id, parsed.changes);
      if (!preview.ok) {
        push({
          kind: "note",
          tone: "warn",
          text: `The patch engine refused that edit (${preview.code}): ${preview.message} Falling back to a whole-file rewrite.`,
        });
        await generateSource(intent, source, signal);
        return;
      }

      if (parsed.why !== undefined) push({ kind: "note", tone: "ok", text: parsed.why });
      setProposal({
        kind: "patch",
        nodeId: node.id,
        nodeLabel: node.label,
        changes: parsed.changes,
        patches: preview.patches,
        typeProblems: patchTypeProblems(node.label, parsed.changes, node, registryLookup),
      });
    },
    [session, graph, selectedNode, previewPatch, push, generateSource, source, registryLookup, onDelta, onThinking, stage],
  );

  const run = useCallback(
    (intent: string): void => {
      if (intent.length === 0 || busy !== null || session === null) return;
      setInput("");
      setProposal(null);
      push({ kind: "user", text: intent });

      const controller = new AbortController();
      abortRef.current = controller;
      inFlightFor.current = { exampleId: props.example.id, title: props.example.title };

      void (async () => {
        try {
          if (effectiveMode === "edit" && selectedNode !== null) {
            await editSelected(intent, controller.signal);
          } else {
            await generateSource(intent, null, controller.signal);
          }
        } catch (cause) {
          const reason = controller.signal.reason as unknown;
          const swapped = reason instanceof FlowChanged;
          const aborted = cause instanceof DOMException && cause.name === "AbortError";

          if (swapped) {
            push({
              kind: "note",
              tone: "warn",
              text: `You switched flows while that was still being written. It was an answer about “${reason.from}”, so it was dropped rather than applied to a different file — ask again here if you still want it.`,
            });
            setInput(intent);
          } else if (aborted) {
            push({ kind: "note", tone: "info", text: "Stopped." });
            setInput(intent);
          } else {
            // The prompt goes back in the box and the failure offers a retry:
            // QA called re-typing a ten-line prompt after a four-minute wait
            // the single most likely place for a real user to give up.
            push({
              kind: "note",
              tone: "danger",
              retry: true,
              text: cause instanceof Error ? cause.message : String(cause),
            });
            setInput(intent);
          }
        } finally {
          abortRef.current = null;
          inFlightFor.current = null;
          setBusy(null);
        }
      })();
    },
    [busy, session, effectiveMode, selectedNode, editSelected, generateSource, push, props.example],
  );

  const send = useCallback((): void => { run(input.trim()); }, [run, input]);

  const applyProposal = useCallback((): void => {
    if (proposal === null) return;
    if (proposal.kind === "rewrite") {
      props.onApplySource(proposal.source);
      setProposal(null);
      push({ kind: "note", tone: "ok", text: "Applied — the diagram was redrawn from the new file." });
      // The right-hand issues button reports what the *analyzer* found; these
      // came from the generation checks and used to vanish the moment the file
      // was applied (BUG-6). They stay in the transcript instead.
      if (proposal.warnings.length > 0) {
        push({
          kind: "note",
          tone: "warn",
          text: `Still open after applying: ${summarize(proposal.warnings)}. The issues button on the canvas lists what the analyzer sees; these came from the generation checks and are kept here.`,
        });
      }
      return;
    }
    setApplying(true);
    void (async () => {
      const outcome = await patchNode(proposal.nodeId, proposal.changes);
      setApplying(false);
      if (outcome.ok) {
        setProposal(null);
        push({
          kind: "note",
          tone: "ok",
          text: `Applied — ${String(outcome.result.patches.length)} place${outcome.result.patches.length === 1 ? "" : "s"} in the file changed.`,
        });
      } else {
        push({ kind: "note", tone: "danger", text: `${outcome.code}: ${outcome.message}` });
      }
    })();
  }, [proposal, patchNode, props, push]);

  /* --- render ------------------------------------------------------------ */

  // What this example's registry actually offers, said out loud — the model is
  // given exactly these tools and nothing else (10 §1), so the reader should
  // not have to guess why a request about files went nowhere. It used to appear
  // only in the empty state, which meant that once you had a conversation there
  // was no way left to see which tools you were talking about (BUG-11).
  const toolSurface = `${registry.label} — ${String(registry.tools.length)} tools`;
  const openers = OPENERS[registry.id] ?? GENERIC_OPENERS;

  const placeholder = useMemo(() => {
    if (effectiveMode === "edit" && selectedNode !== null) {
      return `Change “${selectedNode.label}” — e.g. “post to #ops instead”`;
    }
    return `Describe a flow — e.g. “${openers[0] ?? "what should happen, step by step"}”`;
  }, [effectiveMode, selectedNode, openers]);

  const lastRetry = turns.at(-1);
  const retryText = lastRetry?.kind === "note" && lastRetry.retry === true ? input.trim() : null;

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-surface font-sans", props.className)} data-testid="chat">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <Sparkles className="size-3.5 text-accent" />
        <h2 className="m-0 text-[12px] font-semibold tracking-[-0.005em] text-ink">Ask AI</h2>
        {props.configured ? (
          <Badge
            tone="neutral"
            title={
              props.aiMode === "byok"
                ? `${props.model} — called from this browser with your own OpenRouter key`
                : "Model used for this panel"
            }
          >
            {props.model}
          </Badge>
        ) : (
          <Badge tone="warn">{props.aiMode === "byok" ? "needs your key" : "not configured"}</Badge>
        )}
        {turns.length === 0 ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            aria-label="Clear the conversation"
            title="Clear the conversation"
            onClick={() => { setTurns([]); setProposal(null); nextId.current = 1; }}
          >
            <Trash2 />
            Clear
          </Button>
        )}
        {props.onClose === undefined ? null : (
          <Button
            variant="ghost"
            size="icon-sm"
            className={turns.length === 0 ? "ml-auto" : ""}
            aria-label="Hide the chat"
            title="Hide the chat"
            onClick={props.onClose}
          >
            <X />
          </Button>
        )}
      </header>

      {/* Which flow and which tools, always visible — not only when empty. */}
      <p
        className="m-0 shrink-0 truncate border-b border-line bg-surface-2 px-3 py-1.5 text-[10.5px] text-ink-faint"
        title={`${props.example.title} · ${toolSurface}`}
        data-testid="chat-context"
      >
        <span className="text-ink-dim">{props.example.title}</span> · {toolSurface}
      </p>

      {props.aiMode === "byok" ? (
        <div className="p-3">
          <ByokKeyBox
            configured={props.configured}
            model={props.model}
            onChanged={props.onKeyChange}
          />
        </div>
      ) : !props.configured ? (
        <div className="p-3">
          <Notice tone="info" title="No API key">
            Put <code className="font-mono text-[11px]">OPENROUTER_API_KEY=…</code> in the repo-root{" "}
            <code className="font-mono text-[11px]">.env</code> and restart <code className="font-mono text-[11px]">pnpm dev</code> — the
            key stays in the dev server and never reaches the browser.
          </Notice>
        </div>
      ) : null}

      <div ref={scrollRef} className="cf-scroll min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {turns.length === 0 ? (
          <div className="flex flex-col gap-2 pt-2">
            <p className="m-0 text-[12px] leading-relaxed text-ink-dim">
              Ask for a whole flow, or select a step and ask for a change to it. You always see the
              diff before anything is written.
            </p>
            {/* Exactly what "checked" means. The old copy said answers were
                "checked against the flow contract", which a reader reasonably
                heard as "type-checked" — and they were not (BUG-3). */}
            <p className="m-0 text-[11px] leading-relaxed text-ink-faint">
              Every answer is parsed, scored against the flow contract (10 §5), and checked for
              imports, tools that exist in this registry, and arguments whose written value
              contradicts the tool&apos;s schema. There is no full TypeScript type check here, so a
              value computed by an expression is taken on trust.
            </p>
            <div className="flex flex-col gap-1.5 pt-1">
              {openers.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  disabled={!props.configured}
                  onClick={() => { setInput(suggestion); }}
                  className="cursor-pointer rounded-lg border border-line bg-surface-2/60 px-2.5 py-2 text-left text-[11.5px] text-ink-dim transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {turns.map((turn) => (
              <TurnView
                key={turn.id}
                turn={turn}
                onRetry={
                  turn === lastRetry && retryText !== null && retryText.length > 0 && busy === null
                    ? () => { run(retryText); }
                    : undefined
                }
              />
            ))}
          </div>
        )}

        {busy === null ? null : <Progress label={busy} elapsed={elapsed} written={written} onStop={() => { abortRef.current?.abort(); }} />}

        {proposal === null ? null : (
          <ProposalCard
            proposal={proposal}
            currentSource={source}
            applying={applying}
            onApply={applyProposal}
            onDiscard={() => { setProposal(null); }}
          />
        )}
      </div>

      <footer className="shrink-0 border-t border-line p-2.5">
        <div className="pb-2">
          {selectedNode === null ? (
            <p className="m-0 text-[11px] text-ink-faint">
              Writing a new flow — it will replace the whole file, and you see the diff first. Select
              a step in the diagram to change just that step instead.
            </p>
          ) : (
            <Segmented
              aria-label="What the request is about"
              value={effectiveMode}
              onValueChange={(value) => { setMode(value); }}
              items={[
                { value: "create", label: "New flow" },
                { value: "edit", label: `Edit “${trim(selectedNode.label)}”` },
              ]}
            />
          )}
        </div>
        <div className="flex items-end gap-2">
          <textarea
            id="cf-chat-input"
            name="chat-input"
            aria-label="Ask the AI"
            data-testid="chat-input"
            rows={2}
            value={input}
            disabled={!props.configured || busy !== null}
            placeholder={placeholder}
            onChange={(event) => { setInput(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                send();
              }
            }}
            className="cf-scroll min-h-[3.25rem] flex-1 resize-none rounded-lg border border-line bg-surface-2 px-2.5 py-2 font-sans text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong disabled:opacity-60"
          />
          <Button
            variant="primary"
            size="icon"
            aria-label="Send"
            title="Send"
            data-testid="chat-send"
            disabled={!props.configured || busy !== null || input.trim().length === 0}
            onClick={send}
          >
            <Send />
          </Button>
        </div>
      </footer>
    </div>
  );
}

function trim(label: string): string {
  return label.length > 14 ? `${label.slice(0, 13)}…` : label;
}

function summarize(diagnostics: readonly Diagnostic[]): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  const warnings = diagnostics.length - errors;
  const parts: string[] = [];
  if (errors > 0) parts.push(`${String(errors)} error${errors === 1 ? "" : "s"}`);
  if (warnings > 0) parts.push(`${String(warnings)} warning${warnings === 1 ? "" : "s"}`);
  const codes = [...new Set(diagnostics.map((diagnostic) => diagnostic.code))].slice(0, 3);
  return `${parts.join(" and ")} (${codes.join(", ")})`;
}

/**
 * Type problems a *patch* would introduce.
 *
 * The rewrite path can analyze the whole proposed file; a patch has not been
 * applied yet, so the same check runs against the values the model is asking to
 * write. Only literals are judged — an `{"kind":"expression"}` value is exactly
 * the case this module refuses to guess about.
 */
function patchTypeProblems(
  label: string,
  changes: Record<string, unknown>,
  node: { data: Record<string, unknown> },
  registry: ReturnType<typeof registryInstanceFor>,
): ArgumentTypeProblem[] {
  const toolName = node.data["toolName"];
  const schema =
    typeof toolName === "string" ? registry.getTool(toolName)?.inputSchema : undefined;
  if (schema === undefined || typeof schema === "string") return [];

  const graph = {
    nodes: [
      {
        id: "candidate",
        type: "tool",
        label,
        data: {
          toolName,
          arguments: Object.fromEntries(
            Object.entries(changes)
              .filter(([name]) => !name.startsWith("$"))
              .map(([name, value]) => [name, literalSource(value)])
              .filter((entry): entry is [string, string] => entry[1] !== null),
          ),
        },
      },
    ],
  } as unknown as WorkflowGraph;

  return argumentTypeProblems(graph, registry);
}

/**
 * The source text a JSON patch value will become, or null when it is not a
 * literal this check may judge.
 *
 * Deliberately narrower than the encoding: a bare string in a patch means
 * "same form as the current value" (06 §3), so `"extra-wide"` against a field
 * currently written as `input.viewportWidth` becomes an *expression*, not a
 * string. Judging it as text would be a guess, and this module does not guess.
 * Numbers, booleans and an explicit `literal` are unambiguous; everything else
 * is caught after Apply, when there is a real file to analyze.
 */
function literalSource(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && value !== null) {
    const kind = (value as { kind?: string }).kind;
    // `expression` and `template` are code, and code is out of scope here.
    if (kind === "literal") return JSON.stringify((value as { text?: string }).text ?? "");
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* progress                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Progress that is actually progress.
 *
 * QA watched one label — "Working out the smallest change…" — sit unchanged for
 * 295 seconds through two entirely different phases and then fail (BUG-7). A
 * spinner that says the same thing for five minutes is indistinguishable from a
 * hang, which is why the stage changes, the clock runs, and the model's output
 * is shown as it arrives.
 */
function Progress({
  label,
  elapsed,
  written,
  onStop,
}: {
  label: string;
  elapsed: number;
  written: { chars: number; tail: string; thinking: number };
  onStop: () => void;
}): ReactNode {
  const quiet = written.chars === 0;
  return (
    <div className="mt-2 flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2" data-testid="chat-progress">
      <div className="flex items-center gap-2 text-[11.5px] text-ink-dim">
        <LoaderCircle className="size-3.5 animate-spin text-accent" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="tabular-nums text-ink-faint">{elapsed}s</span>
        <Button variant="ghost" size="icon-sm" aria-label="Stop" title="Stop" onClick={onStop}>
          <CircleStop />
        </Button>
      </div>
      <p className="m-0 text-[10.5px] text-ink-faint">
        {quiet
          ? written.thinking > 0
            ? `Thinking — ${written.thinking.toLocaleString()} characters of reasoning so far, no answer written yet. A long flow takes minutes.`
            : elapsed < 20
              ? "Waiting for the first words — a reasoning model thinks before it writes."
              : `Still thinking after ${String(elapsed)}s. Long flows take minutes; nothing has stalled while this clock moves.`
          : `${written.chars.toLocaleString()} characters written${written.thinking > 0 ? ` · ${written.thinking.toLocaleString()} of reasoning first` : ""}`}
      </p>
      {quiet ? null : (
        <pre className="m-0 max-h-14 overflow-hidden whitespace-pre-wrap break-all font-mono text-[10px] leading-[1.45] text-ink-faint">
          {written.tail}
        </pre>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* transcript                                                                  */
/* -------------------------------------------------------------------------- */

function TurnView({ turn, onRetry }: { turn: Turn; onRetry?: () => void }): ReactNode {
  if (turn.kind === "user") {
    return (
      <p className="m-0 self-end rounded-xl rounded-br-sm bg-accent px-3 py-2 text-[12px] leading-relaxed text-accent-fg">
        {turn.text}
      </p>
    );
  }

  if (turn.kind === "note") {
    const tone =
      turn.tone === "danger"
        ? "border-danger/40 bg-danger-soft text-danger"
        : turn.tone === "warn"
          ? "border-warn/40 bg-warn-soft text-warn"
          : turn.tone === "ok"
            ? "border-ok/40 bg-ok-soft text-ok"
            : "border-line bg-surface-2 text-ink-dim";
    return (
      <div className={cn("rounded-lg border px-2.5 py-1.5", tone)}>
        <p className="m-0 text-[11.5px] leading-relaxed">{turn.text}</p>
        {onRetry === undefined ? null : (
          <div className="pt-1.5">
            <Button variant="secondary" size="xs" onClick={onRetry} data-testid="chat-retry">
              <RotateCcw />
              Try again
            </Button>
          </div>
        )}
      </div>
    );
  }

  return <RoundView turn={turn} />;
}

/**
 * One validation round.
 *
 * The list is deduplicated with a count and carries line numbers, because the
 * previous one repeated an identical sentence six times, then said "+25 more",
 * and headed the whole thing "10 warnings" (BUG-12). Numbers that do not add up
 * teach a reader to ignore the panel.
 */
function RoundView({ turn }: { turn: Extract<Turn, { kind: "round" }> }): ReactNode {
  const grouped = useMemo(() => {
    const byMessage = new Map<string, { diagnostic: Diagnostic; count: number; lines: number[] }>();
    for (const diagnostic of turn.diagnostics) {
      const key = `${diagnostic.code} ${diagnostic.message}`;
      const line = diagnostic.source?.start.line;
      const entry = byMessage.get(key);
      if (entry === undefined) {
        byMessage.set(key, { diagnostic, count: 1, lines: line === undefined ? [] : [line] });
      } else {
        entry.count += 1;
        if (line !== undefined) entry.lines.push(line);
      }
    }
    return [...byMessage.values()].sort((a, b) => severityRank(a.diagnostic) - severityRank(b.diagnostic));
  }, [turn.diagnostics]);

  const counts = { error: 0, warning: 0, info: 0 };
  for (const diagnostic of turn.diagnostics) counts[diagnostic.severity] += 1;
  const good = turn.level === "L1" || turn.level === "L2";

  return (
    <div className="rounded-lg border border-line bg-surface-2 px-2.5 py-2" data-testid="chat-round">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-medium text-ink-dim">Round {turn.round}</span>
        <Badge tone={good ? "ok" : turn.level === "L0" ? "warn" : "danger"} title="Conformance level (10 §5)">
          {turn.level}
        </Badge>
        {counts.error > 0 ? <Badge tone="danger">{counts.error} error{counts.error === 1 ? "" : "s"}</Badge> : null}
        {counts.warning > 0 ? <Badge tone="warn">{counts.warning} warning{counts.warning === 1 ? "" : "s"}</Badge> : null}
        {counts.info > 0 ? <Badge tone="neutral">{counts.info} note{counts.info === 1 ? "" : "s"}</Badge> : null}
        <span className="ml-auto text-[10.5px] tabular-nums text-ink-faint">
          {(turn.ms / 1000).toFixed(1)}s
        </span>
      </div>
      {grouped.length === 0 ? null : (
        <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
          {grouped.slice(0, 8).map((entry, i) => (
            <li key={i} className="flex gap-1.5 text-[10.5px] leading-snug text-ink-dim">
              <span
                className={cn(
                  "mt-[5px] size-1.5 shrink-0 rounded-full",
                  entry.diagnostic.severity === "error"
                    ? "bg-danger"
                    : entry.diagnostic.severity === "warning"
                      ? "bg-warn"
                      : "bg-info",
                )}
              />
              <span className="min-w-0">
                <span className="font-mono">{entry.diagnostic.code}</span>
                {entry.lines.length === 0 ? null : (
                  <span className="font-mono text-ink-faint"> · {formatLines(entry.lines)}</span>
                )}
                {entry.count === 1 ? null : (
                  <span className="text-ink-faint"> · ×{entry.count}</span>
                )}{" "}
                — {entry.diagnostic.message}
              </span>
            </li>
          ))}
          {grouped.length > 8 ? (
            <li className="text-[10.5px] text-ink-faint">
              +{grouped.length - 8} more kind{grouped.length - 8 === 1 ? "" : "s"} of issue
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

function severityRank(diagnostic: Diagnostic): number {
  return diagnostic.severity === "error" ? 0 : diagnostic.severity === "warning" ? 1 : 2;
}

function formatLines(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b);
  const shown = sorted.slice(0, 4).map((line) => String(line)).join(", ");
  return sorted.length > 4 ? `lines ${shown}, …` : sorted.length === 1 ? `line ${shown}` : `lines ${shown}`;
}

/* -------------------------------------------------------------------------- */
/* the proposal                                                                */
/* -------------------------------------------------------------------------- */

function ProposalCard(props: {
  proposal: Proposal;
  currentSource: string;
  applying: boolean;
  onApply: () => void;
  onDiscard: () => void;
}): ReactNode {
  const { proposal } = props;
  const [acknowledged, setAcknowledged] = useState(false);
  const hunks = useMemo(
    () => (proposal.kind === "rewrite" ? diffLines(props.currentSource, proposal.source) : []),
    [proposal, props.currentSource],
  );

  const blocked = proposal.typeProblems.length > 0 && !acknowledged;

  return (
    <div className="mt-2 rounded-xl border border-accent/40 bg-surface" data-testid="chat-proposal">
      <header className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
        <FileCode className="size-3.5 text-accent" />
        <h3 className="m-0 text-[12px] font-semibold text-ink">
          {proposal.kind === "patch" ? `Change to “${proposal.nodeLabel}”` : "Proposed file"}
        </h3>
        {proposal.kind === "patch" ? (
          <Badge tone="ok" title="Goes through the patch engine — minimal, identity-preserving">
            minimal patch
          </Badge>
        ) : (
          <>
            <Badge tone={proposal.level === "L1" || proposal.level === "L2" ? "ok" : "warn"}>{proposal.level}</Badge>
            <Badge tone="neutral">
              {proposal.rounds} round{proposal.rounds === 1 ? "" : "s"}
            </Badge>
          </>
        )}
      </header>

      {proposal.kind === "rewrite" && proposal.prose !== null ? (
        <p className="m-0 whitespace-pre-wrap border-b border-line px-3 py-2 text-[11.5px] leading-relaxed text-ink-dim">
          {proposal.prose}
        </p>
      ) : null}

      {proposal.kind === "rewrite" && proposal.reason !== null ? (
        <p className="m-0 border-b border-line px-3 py-1.5 text-[11px] text-ink-dim">{proposal.reason}</p>
      ) : null}

      {proposal.kind === "rewrite" && proposal.scope !== null ? (
        <ScopeSummary scope={proposal.scope} removal={proposal.removal} replacing={proposal.replacing} />
      ) : null}

      {proposal.typeProblems.length === 0 ? null : (
        <div className="border-b border-line px-3 py-2">
          <Notice
            tone="danger"
            title={`${String(proposal.typeProblems.length)} value${proposal.typeProblems.length === 1 ? " does" : "s do"} not match the tool's schema`}
          >
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {proposal.typeProblems.slice(0, 4).map((problem, i) => (
                <li key={i} className="text-[11px] leading-snug">{problem.message}</li>
              ))}
            </ul>
            <label className="mt-1.5 inline-flex cursor-pointer select-none items-center gap-1.5 text-[11px]">
              <input
                type="checkbox"
                id="cf-chat-accept-type-mismatch"
                name="accept-type-mismatch"
                className="size-3.5 cursor-pointer accent-[color:var(--cf-danger)]"
                checked={acknowledged}
                onChange={(event) => { setAcknowledged(event.target.checked); }}
              />
              Apply it anyway — I know this will not run
            </label>
          </Notice>
        </div>
      )}

      <div className="cf-scroll max-h-64 overflow-auto p-2.5">
        {proposal.kind === "patch" ? (
          <CodeDiff patches={proposal.patches} />
        ) : hunks.length === 0 ? (
          <p className="m-0 text-[11.5px] italic text-ink-faint">
            The model came back with the file exactly as it is.
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {hunks.slice(0, 12).map((hunk, i) => (
              <div className="overflow-hidden rounded-lg border border-line" key={i}>
                <div className="border-b border-line bg-surface-2 px-2.5 py-1 font-mono text-[10.5px] text-ink-faint">
                  line {hunk.line}
                </div>
                <pre className="cf-scroll m-0 flex flex-col overflow-x-auto py-1 font-mono text-[11px] leading-[1.55]">
                  {hunk.removed.map((line, j) => (
                    <span className="whitespace-pre bg-danger-soft px-2.5 text-danger" key={`o${String(j)}`}>
                      {`- ${line}`}
                    </span>
                  ))}
                  {hunk.added.map((line, j) => (
                    <span className="whitespace-pre bg-ok-soft px-2.5 text-ok" key={`n${String(j)}`}>
                      {`+ ${line}`}
                    </span>
                  ))}
                </pre>
              </div>
            ))}
            {hunks.length > 12 ? (
              <p className="m-0 text-[11px] text-ink-faint">+{hunks.length - 12} more changed places</p>
            ) : null}
          </div>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-line bg-surface-2 px-3 py-2">
        <Button
          variant="primary"
          size="sm"
          data-testid="chat-apply"
          disabled={props.applying || blocked}
          title={blocked ? "A value contradicts the tool's schema — tick the box above to apply it anyway" : undefined}
          onClick={props.onApply}
        >
          {props.applying ? <LoaderCircle className="animate-spin" /> : <Check />}
          Apply
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onDiscard} disabled={props.applying}>
          Discard
        </Button>
        {proposal.kind === "rewrite" && proposal.scope !== null ? (
          <span className="ml-auto text-[10.5px] tabular-nums text-ink-faint">
            {proposal.scope.before} → {proposal.scope.after} steps
          </span>
        ) : null}
      </footer>
    </div>
  );
}

/** Steps added, removed and changed — the blast radius, before Apply (BUG-5). */
function ScopeSummary({
  scope,
  removal,
  replacing,
}: {
  scope: RewriteScope;
  removal: "none" | "expected" | "unrequested";
  replacing: boolean;
}): ReactNode {
  const parts: string[] = [];
  if (scope.added.length > 0) parts.push(`${String(scope.added.length)} added`);
  if (scope.removed.length > 0) parts.push(`${String(scope.removed.length)} removed`);
  if (scope.changed > 0) parts.push(`${String(scope.changed)} changed`);

  if (replacing) {
    return (
      <div className="border-b border-line px-3 py-2" data-testid="chat-scope">
        <p className="m-0 text-[11px] text-ink-dim">
          A new flow replaces the file on screen: {scope.before} step
          {scope.before === 1 ? "" : "s"} out, {scope.after} in.
        </p>
      </div>
    );
  }

  return (
    <div className="border-b border-line px-3 py-2" data-testid="chat-scope">
      <p className="m-0 text-[11px] text-ink-dim">
        {parts.length === 0
          ? "No step is added, removed or changed — only formatting differs."
          : `Steps: ${parts.join(" · ")}.`}
      </p>
      {scope.removed.length === 0 ? null : (
        <p
          className={cn(
            "m-0 mt-1 flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[11px] leading-snug",
            removal === "unrequested" ? "bg-warn-soft text-warn" : "bg-surface-2 text-ink-dim",
          )}
        >
          {removal === "unrequested" ? <TriangleAlert className="mt-px size-3 shrink-0" /> : null}
          <span>
            {removal === "unrequested"
              ? `This rewrite also removes ${String(scope.removed.length)} step${scope.removed.length === 1 ? "" : "s"} you did not ask about: `
              : `Removes: `}
            <span className="font-medium">{scope.removed.slice(0, 5).join(", ")}</span>
            {scope.removed.length > 5 ? ` and ${String(scope.removed.length - 5)} more` : ""}.
          </span>
        </p>
      )}
      {scope.added.length === 0 ? null : (
        <p className="m-0 mt-1 text-[11px] leading-snug text-ink-faint">
          Adds: <span className="text-ink-dim">{scope.added.slice(0, 5).join(", ")}</span>
          {scope.added.length > 5 ? ` and ${String(scope.added.length - 5)} more` : ""}.
        </p>
      )}
    </div>
  );
}
