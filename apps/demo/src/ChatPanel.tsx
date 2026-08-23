/**
 * `<ChatPanel>` — write and change flows in words.
 *
 * Two things make this more than a chat box glued onto a demo:
 *
 * 1. **The prompt is the library's, not this app's.** The system message is
 *    `renderSystemPrompt(session.buildGenerationContext())` — the flow contract,
 *    the style guide and the generated `tools.d.ts` / `lib.d.ts` of *this
 *    example's registry* (10 §1, §3). The model can only call tools that exist.
 * 2. **The answer is validated before it is offered.** Every round is scored on
 *    the conformance ladder with `session.validate` and, below the target level,
 *    the analyzer's own diagnostics are fed back with `renderDiagnosticsFeedback`
 *    — up to two retries, exactly the loop of 10 §5. Every round is shown: level,
 *    diagnostics, time. That loop is the interesting part of the demo, so it is
 *    on screen rather than in a console.
 *
 * Applying is always a second, explicit step: a change to a single field goes
 * through the patch engine (`previewPatch` → `<CodeDiff>` → `patchNode`) so it
 * stays a minimal, identity-preserving edit (06 §4); anything structural is a
 * whole-file rewrite, shown as a line diff and *said out loud* as one.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  renderDiagnosticsFeedback,
  renderSystemPrompt,
  type ConformanceLevel,
  type Diagnostic,
  type TextPatch,
} from "@codeflow/core";
import {
  Badge,
  Button,
  CodeDiff,
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
  Send,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { callModel, diffLines, extractFlowSource, extractJson, type ChatMessage } from "./ai.js";
import { registryFor, type FlowExample } from "./examples-source.js";

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

type Turn =
  | { kind: "user"; id: number; text: string }
  | { kind: "note"; id: number; tone: "info" | "warn" | "danger" | "ok"; text: string }
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
    }
  | {
      kind: "patch";
      nodeId: string;
      nodeLabel: string;
      changes: Record<string, unknown>;
      patches: readonly TextPatch[];
    };

/**
 * The conversation, kept outside React.
 *
 * The panel docks beside the canvas on a wide window and slides over it on a
 * narrow one, which are two different places in the tree — so crossing that
 * width unmounts one and mounts the other, and component state would take the
 * whole conversation with it. Resizing a window is not "clear the chat", so the
 * few things worth keeping live here instead and are read back on mount. There
 * is exactly one chat panel in this app, which is what makes a module-level
 * store the honest shape rather than a shortcut.
 */
const kept: { turns: Turn[]; input: string; proposal: Proposal | null; nextId: number } = {
  turns: [],
  input: "",
  proposal: null,
  nextId: 1,
};

export interface ChatPanelProps {
  example: FlowExample;
  configured: boolean;
  model: string;
  /** Replaces the whole file — the host owns the source (00 §2.1). */
  onApplySource: (source: string) => void;
  onClose?: () => void;
  className?: string;
}

export function ChatPanel(props: ChatPanelProps): ReactNode {
  const { session, graph, source, selectedNode, previewPatch, patchNode } = useCodeFlow();

  const [turns, setTurns] = useState<Turn[]>(kept.turns);
  const [input, setInput] = useState(kept.input);
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [busy, setBusy] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [proposal, setProposal] = useState<Proposal | null>(kept.proposal);
  const [applying, setApplying] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const nextId = useRef(kept.nextId);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  kept.turns = turns;
  kept.input = input;
  kept.proposal = proposal;
  kept.nextId = nextId.current;

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

  const effectiveMode = selectedNode === null ? "create" : mode;

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
              ? intent
              : `Here is the flow file as it stands:\n\n\`\`\`ts\n${existing}\`\`\`\n\nChange it so that: ${intent}\n\nAnswer with the complete updated file — the whole file, no fences, no commentary.`,
        },
      ];

      let accepted: { source: string; level: ConformanceLevel; rounds: number } | null = null;

      for (let round = 1; round <= MAX_ROUNDS; round++) {
        setBusy(round === 1 ? "Writing the flow…" : `Fixing what validation found (round ${String(round)})…`);
        const answer = await callModel(messages, signal);
        const candidate = extractFlowSource(answer.content);
        const result = await session.validate(candidate);

        push({
          kind: "round",
          round,
          level: result.level,
          diagnostics: result.diagnostics,
          ms: answer.ms,
        });

        accepted = { source: candidate, level: result.level, rounds: round };
        if (result.level === "L1" || result.level === "L2") break;

        const feedback = renderDiagnosticsFeedback(result, { target: TARGET });
        if (feedback === null) break;
        if (round === MAX_ROUNDS) {
          push({
            kind: "note",
            tone: "warn",
            text: `Still below ${TARGET} after ${String(MAX_ROUNDS)} rounds — the file below is the best answer; look at the diagnostics before applying it.`,
          });
          break;
        }
        messages.push({ role: "assistant", content: answer.content }, { role: "user", content: feedback });
      }

      if (accepted !== null) {
        setProposal({
          kind: "rewrite",
          source: accepted.source,
          level: accepted.level,
          rounds: accepted.rounds,
          reason: existing === null ? null : "This edit rewrites the whole file.",
        });
      }
    },
    [session, push],
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

      setBusy("Working out the smallest change…");
      const answer = await callModel(
        [
          { role: "system", content: system },
          { role: "user", content: ask },
        ],
        signal,
      );

      const parsed = extractJson(answer.content) as
        | { mode?: string; changes?: Record<string, unknown>; why?: string }
        | null;

      if (parsed === null) {
        push({ kind: "note", tone: "warn", text: "The model did not answer with JSON — rewriting the file instead." });
        await generateSource(intent, source, signal);
        return;
      }

      if (parsed.mode === "rewrite" || parsed.changes === undefined) {
        push({
          kind: "note",
          tone: "info",
          text: `${parsed.why ?? "This needs more than one statement"} — so this is a whole-file rewrite, not a single-field patch.`,
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
      });
    },
    [session, graph, selectedNode, previewPatch, push, generateSource, source],
  );

  const send = useCallback((): void => {
    const intent = input.trim();
    if (intent.length === 0 || busy !== null || session === null) return;
    setInput("");
    setProposal(null);
    push({ kind: "user", text: intent });

    const controller = new AbortController();
    abortRef.current = controller;

    void (async () => {
      try {
        if (effectiveMode === "edit" && selectedNode !== null) {
          await editSelected(intent, controller.signal);
        } else {
          await generateSource(intent, null, controller.signal);
        }
      } catch (cause) {
        const aborted = cause instanceof DOMException && cause.name === "AbortError";
        push({
          kind: "note",
          tone: aborted ? "info" : "danger",
          text: aborted
            ? "Stopped."
            : cause instanceof Error
              ? cause.message
              : String(cause),
        });
      } finally {
        abortRef.current = null;
        setBusy(null);
      }
    })();
  }, [input, busy, session, effectiveMode, selectedNode, editSelected, generateSource, push]);

  const applyProposal = useCallback((): void => {
    if (proposal === null) return;
    if (proposal.kind === "rewrite") {
      props.onApplySource(proposal.source);
      setProposal(null);
      push({ kind: "note", tone: "ok", text: "Applied — the diagram was redrawn from the new file." });
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
  // not have to guess why a request about files went nowhere.
  const { toolSurface, openers } = useMemo(() => {
    try {
      const registry = registryFor(props.example);
      return {
        toolSurface: `${registry.label} — ${String(registry.tools.length)} tools`,
        openers: OPENERS[registry.id] ?? GENERIC_OPENERS,
      };
    } catch {
      return { toolSurface: "the tools this flow was written against", openers: GENERIC_OPENERS };
    }
  }, [props.example]);

  const placeholder = useMemo(() => {
    if (effectiveMode === "edit" && selectedNode !== null) {
      return `Change “${selectedNode.label}” — e.g. “post to #ops instead”`;
    }
    return `Describe a flow — e.g. “${openers[0] ?? "what should happen, step by step"}”`;
  }, [effectiveMode, selectedNode, openers]);

  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-surface font-sans", props.className)} data-testid="chat">
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <Sparkles className="size-3.5 text-accent" />
        <h2 className="m-0 text-[12px] font-semibold tracking-[-0.005em] text-ink">Ask AI</h2>
        {props.configured ? (
          <Badge tone="neutral" title="Model used for this panel">{props.model}</Badge>
        ) : (
          <Badge tone="warn">not configured</Badge>
        )}
        {turns.length === 0 ? null : (
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto"
            aria-label="Clear the conversation"
            onClick={() => { setTurns([]); setProposal(null); }}
          >
            <Trash2 />
          </Button>
        )}
        {props.onClose === undefined ? null : (
          <Button
            variant="ghost"
            size="icon-sm"
            className={turns.length === 0 ? "ml-auto" : ""}
            aria-label="Hide the chat"
            onClick={props.onClose}
          >
            <X />
          </Button>
        )}
      </header>

      {!props.configured ? (
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
              Ask for a whole flow, or select a step and ask for a change to it. Answers are checked
              against the flow contract before you are offered them — you always see the diff first.
            </p>
            <p className="m-0 text-[11px] leading-relaxed text-ink-faint">
              Tools it can call here: {toolSurface}.
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
              <TurnView key={turn.id} turn={turn} />
            ))}
          </div>
        )}

        {busy === null ? null : (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-[11.5px] text-ink-dim">
            <LoaderCircle className="size-3.5 animate-spin text-accent" />
            <span className="min-w-0 flex-1 truncate">{busy}</span>
            <span className="tabular-nums text-ink-faint">{elapsed}s</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Stop"
              onClick={() => { abortRef.current?.abort(); }}
            >
              <CircleStop />
            </Button>
          </div>
        )}

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
              Select a step in the diagram to change just that step.
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

function TurnView({ turn }: { turn: Turn }): ReactNode {
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
    return <p className={cn("m-0 rounded-lg border px-2.5 py-1.5 text-[11.5px] leading-relaxed", tone)}>{turn.text}</p>;
  }

  const errors = turn.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = turn.diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  const good = turn.level === "L1" || turn.level === "L2";

  return (
    <div className="rounded-lg border border-line bg-surface-2 px-2.5 py-2" data-testid="chat-round">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-medium text-ink-dim">Round {turn.round}</span>
        <Badge tone={good ? "ok" : turn.level === "L0" ? "warn" : "danger"} title="Conformance level (10 §5)">
          {turn.level}
        </Badge>
        {errors.length > 0 ? <Badge tone="danger">{errors.length} errors</Badge> : null}
        {warnings.length > 0 ? <Badge tone="warn">{warnings.length} warnings</Badge> : null}
        <span className="ml-auto text-[10.5px] tabular-nums text-ink-faint">
          {(turn.ms / 1000).toFixed(1)}s
        </span>
      </div>
      {turn.diagnostics.length === 0 ? null : (
        <ul className="m-0 mt-1.5 flex list-none flex-col gap-1 p-0">
          {turn.diagnostics.slice(0, 6).map((diagnostic, i) => (
            <li key={i} className="flex gap-1.5 text-[10.5px] leading-snug text-ink-dim">
              <span
                className={cn(
                  "mt-[5px] size-1.5 shrink-0 rounded-full",
                  diagnostic.severity === "error" ? "bg-danger" : diagnostic.severity === "warning" ? "bg-warn" : "bg-info",
                )}
              />
              <span className="min-w-0">
                <span className="font-mono">{diagnostic.code}</span> — {diagnostic.message}
              </span>
            </li>
          ))}
          {turn.diagnostics.length > 6 ? (
            <li className="text-[10.5px] text-ink-faint">+{turn.diagnostics.length - 6} more</li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

function ProposalCard(props: {
  proposal: Proposal;
  currentSource: string;
  applying: boolean;
  onApply: () => void;
  onDiscard: () => void;
}): ReactNode {
  const { proposal } = props;
  const hunks = useMemo(
    () => (proposal.kind === "rewrite" ? diffLines(props.currentSource, proposal.source) : []),
    [proposal, props.currentSource],
  );

  return (
    <div className="mt-2 rounded-xl border border-accent/40 bg-surface" data-testid="chat-proposal">
      <header className="flex items-center gap-2 border-b border-line px-3 py-2">
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

      {proposal.kind === "rewrite" && proposal.reason !== null ? (
        <p className="m-0 border-b border-line px-3 py-1.5 text-[11px] text-ink-dim">{proposal.reason}</p>
      ) : null}

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
          disabled={props.applying}
          onClick={props.onApply}
        >
          {props.applying ? <LoaderCircle className="animate-spin" /> : <Check />}
          Apply
        </Button>
        <Button variant="ghost" size="sm" onClick={props.onDiscard} disabled={props.applying}>
          Discard
        </Button>
      </footer>
    </div>
  );
}
