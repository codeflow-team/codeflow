/**
 * `<NewFlowDialog>` — start from nothing.
 *
 * The demo used to have thirteen examples and no front door: a newcomer could open
 * somebody else's flow and ask the AI to rewrite it, which is a different and
 * much less interesting sentence than *describe what you want and watch it get
 * written*. This is that front door, and it is AI-first on purpose — the prompt
 * box is the first thing under the name, and "start blank" sits beside it for
 * whoever would rather build by hand.
 *
 * Three things it refuses to hide:
 *
 * 1. **The cost, before the model sees it.** Picking a registry with sixty tools
 *    is picking a system prompt with sixty tool schemas in it. The card says how
 *    many tools, how many namespaces and roughly how many tokens of context that
 *    is, measured from the real `renderSystemPrompt` output rather than guessed.
 * 2. **The loop.** Generation runs through `generate-flow.ts` — the same
 *    pipeline the chat panel uses, not a second one — and every round is drawn
 *    as it lands: level, diagnostics, seconds. A flow that needed a retry shows
 *    the retry.
 * 3. **What did not work.** A flow that only reached L0 or L1 still opens,
 *    carrying the sentence that says what is unresolved (07 §5). It is never
 *    presented as finished.
 *
 * Without a key the dialog still works: "start blank" and import need no model,
 * and the box says exactly what a key would add and where it would live.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createCodeFlow, createRegistry, renderSystemPrompt, type RegistryLookup } from "@codeflow-team/core";
import { Badge, Button, Input, Modal, Notice, cn } from "@codeflow-team/react";
import { CircleStop, FileUp, LoaderCircle, Plus, ServerCog, Sparkles, Wand2 } from "lucide-react";
import type { AiMode } from "./ai.js";
import { ByokKeyBox } from "./ByokKeyBox.js";
import { REGISTRIES, type ExampleRegistry } from "./examples-source.js";
import { generateFlowSource, unresolvedSummary, type GenerationRound } from "./generate-flow.js";
import type { ComposedRegistry } from "./mcp/model.js";
import {
  MCP_REGISTRY,
  blankFlowSource,
  newFlowId,
  parseFlowFile,
  suggestTitle,
  uniqueTitle,
  type MyFlow,
} from "./my-flows.js";
import { openersForRegistry } from "./openers.js";
import { registryInstance } from "./registry.js";
import { RoundCard } from "./RoundCard.js";

export interface NewFlowDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Used for a name that does not collide with one you already have. */
  existing: readonly MyFlow[];
  /** The visitor's own servers, composed. Offered as a registry when it has tools. */
  composed: ComposedRegistry;
  configured: boolean;
  model: string;
  aiMode: AiMode;
  onKeyChange?: () => void;
  /** Save it and open it. The host owns both (00 §2.1). */
  onCreate: (flow: MyFlow) => void;
}

/* -------------------------------------------------------------------------- */
/* what a registry costs                                                       */
/* -------------------------------------------------------------------------- */

interface RegistryOption {
  choice: string;
  label: string;
  registry: ExampleRegistry;
  lookup: RegistryLookup;
  fromMcp: boolean;
}

/**
 * Roughly how much context this registry becomes.
 *
 * Measured, not estimated from tool count: the system prompt is the contract,
 * the style guide and the generated `tools.d.ts` for *these* tools, so the only
 * honest number comes from building it. Four characters to a token is the usual
 * English-plus-code approximation and the UI says "≈" rather than pretending to
 * a tokenizer it does not ship.
 */
const contextCache = new Map<string, number>();

async function measureContext(option: RegistryOption): Promise<number> {
  const cached = contextCache.get(option.choice);
  if (cached !== undefined) return cached;
  const session = createCodeFlow({ registry: option.lookup });
  const context = await session.buildGenerationContext({ includeExamples: true });
  const tokens = Math.round(renderSystemPrompt(context).length / 4);
  contextCache.set(option.choice, tokens);
  return tokens;
}

/* -------------------------------------------------------------------------- */
/* the dialog                                                                  */
/* -------------------------------------------------------------------------- */

type Phase = "form" | "working";

export function NewFlowDialog(props: NewFlowDialogProps): ReactNode {
  const [title, setTitle] = useState("");
  const [titleTouched, setTitleTouched] = useState(false);
  const [choice, setChoice] = useState<string>(() => Object.keys(REGISTRIES)[0] ?? "sample");
  const [prompt, setPrompt] = useState("");
  const [phase, setPhase] = useState<Phase>("form");
  const [stage, setStage] = useState("");
  const [rounds, setRounds] = useState<GenerationRound[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [written, setWritten] = useState<{ chars: number; thinking: number }>({ chars: 0, thinking: 0 });
  const [error, setError] = useState<string | null>(null);
  /*
   * The error notice sits at the bottom of a dialog taller than the viewport —
   * a registry picker, a prompt box and a round log above it. A tester driving
   * this dialog reported it as a *silent* failure: the request 404'd, the
   * message was rendered, and nothing about the screen they were looking at
   * changed. An error you have to go and find is one nobody reads (07 §5), so
   * it brings itself into view.
   */
  const errorRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (error === null) return;
    errorRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [error]);
  const [importNote, setImportNote] = useState<string | null>(null);
  /** Measured context size per registry choice — see the effect below. */
  const [tokens, setTokens] = useState<Record<string, number>>({});
  const abortRef = useRef<AbortController | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const composed = props.composed;

  const options = useMemo<RegistryOption[]>(() => {
    const built = Object.entries(REGISTRIES).map(([id, registry]) => ({
      choice: id,
      label: registry.label,
      registry,
      lookup: registryInstance(registry),
      fromMcp: false,
    }));
    if (composed.toolCount === 0) return built;
    return [
      {
        choice: MCP_REGISTRY,
        label: `Your MCP servers — ${String(composed.contributing.length)} connected`,
        registry: composed.registry,
        lookup: createRegistry({ tools: composed.registry.tools, functions: composed.registry.functions }),
        fromMcp: true,
      },
      ...built,
    ];
  }, [composed]);

  const selected = useMemo(
    () => options.find((option) => option.choice === choice) ?? (options[0] as RegistryOption),
    [options, choice],
  );

  // The visitor's own servers are the more interesting answer when they have
  // any, so they are preselected the first time the dialog opens with tools on
  // the list — never afterwards, which would fight whatever was picked.
  const preselected = useRef(false);
  useEffect(() => {
    if (!props.open || preselected.current) return;
    preselected.current = true;
    if (composed.toolCount > 0) setChoice(MCP_REGISTRY);
  }, [props.open, composed.toolCount]);

  /*
   * Every card is priced, not only the selected one.
   *
   * The point of the number is to be seen *before* the choice: "38 tools" and
   * "≈14,000 tokens a round" are the same fact, but only one of them is a cost.
   * Measured one registry at a time with a yield in between, so opening the
   * dialog never blocks the frame — the same shape `example-stats.ts` uses for
   * the gallery cards.
   */
  useEffect(() => {
    if (!props.open) return;
    let alive = true;
    void (async () => {
      for (const option of options) {
        const value = await measureContext(option).catch(() => null);
        if (!alive) return;
        if (value !== null) setTokens((current) => ({ ...current, [option.choice]: value }));
        await new Promise((resolve) => { setTimeout(resolve, 0); });
      }
    })();
    return () => { alive = false; };
  }, [props.open, options]);

  useEffect(() => {
    if (phase !== "working") return;
    setElapsed(0);
    const started = Date.now();
    const timer = setInterval(() => { setElapsed(Math.round((Date.now() - started) / 1000)); }, 250);
    return () => { clearInterval(timer); };
  }, [phase]);

  // A dialog that reopens holding the last failure is a dialog that looks
  // broken. Everything the visitor typed is kept; the machinery is not.
  useEffect(() => {
    if (props.open) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("form");
    setRounds([]);
    setStage("");
    setError(null);
  }, [props.open]);

  const openers = useMemo(
    () => openersForRegistry(selected.registry.id, selected.lookup.listToolNamespaces()),
    [selected],
  );

  const finalTitle = useCallback(
    (fallbackFrom: string): string =>
      title.trim().length > 0
        ? uniqueTitle(title.trim(), props.existing)
        : suggestTitle(fallbackFrom, props.existing),
    [title, props.existing],
  );

  /* --- start blank ------------------------------------------------------- */

  const startBlank = useCallback(() => {
    const now = Date.now();
    props.onCreate({
      id: newFlowId(),
      title: title.trim().length > 0 ? uniqueTitle(title.trim(), props.existing) : uniqueTitle("Blank flow", props.existing),
      source: blankFlowSource(),
      registryChoice: selected.choice,
      createdAt: now,
      updatedAt: now,
      origin: null,
      prompt: null,
      generation: null,
    });
    setPrompt("");
    setTitle("");
    setTitleTouched(false);
  }, [props, title, selected.choice]);

  /* --- import ------------------------------------------------------------ */

  const importFile = useCallback(
    (file: File) => {
      void file.text().then(
        (text) => {
          const parsed = parseFlowFile(text, file.name);
          const now = Date.now();
          const known = parsed.registryChoice !== null &&
            (parsed.registryChoice === MCP_REGISTRY || parsed.registryChoice in REGISTRIES);
          props.onCreate({
            id: newFlowId(),
            title: uniqueTitle(parsed.title ?? "Imported flow", props.existing),
            source: parsed.source,
            registryChoice: known ? (parsed.registryChoice as string) : selected.choice,
            createdAt: now,
            updatedAt: now,
            origin: null,
            prompt: null,
            generation: null,
          });
          setImportNote(null);
        },
        (cause: unknown) => {
          setImportNote(`That file could not be read — ${cause instanceof Error ? cause.message : String(cause)}`);
        },
      );
    },
    [props, selected.choice],
  );

  /* --- generate ---------------------------------------------------------- */

  const generate = useCallback(() => {
    const intent = prompt.trim();
    if (intent.length === 0 || phase === "working") return;
    setError(null);
    setRounds([]);
    setWritten({ chars: 0, thinking: 0 });
    setPhase("working");

    const controller = new AbortController();
    abortRef.current = controller;
    const session = createCodeFlow({ registry: selected.lookup });

    void (async () => {
      try {
        const result = await generateFlowSource({
          session,
          registryLookup: selected.lookup,
          intent,
          existing: null,
          signal: controller.signal,
          aiMode: props.aiMode,
          model: props.model,
          onStage: setStage,
          onRound: (round) => { setRounds((current) => [...current, round]); },
          onDelta: (_delta, whole) => {
            setWritten((current) => ({ ...current, chars: whole.length }));
          },
          onThinking: (characters) => {
            setWritten((current) => ({ ...current, thinking: characters }));
          },
        });
        if (result === null) {
          setError("The model wrote nothing at all. Try again, or start blank and add the steps yourself.");
          setPhase("form");
          return;
        }
        const now = Date.now();
        props.onCreate({
          id: newFlowId(),
          title: finalTitle(intent),
          source: result.source,
          registryChoice: selected.choice,
          createdAt: now,
          updatedAt: now,
          origin: null,
          prompt: intent,
          generation: {
            level: result.level,
            rounds: result.rounds,
            unresolved: unresolvedSummary(result),
          },
        });
        setPrompt("");
        setTitle("");
        setTitleTouched(false);
        setPhase("form");
      } catch (cause) {
        const aborted = cause instanceof DOMException && cause.name === "AbortError";
        setError(
          aborted
            ? "Stopped. Your prompt is still in the box."
            : cause instanceof Error
              ? cause.message
              : String(cause),
        );
        setPhase("form");
      } finally {
        abortRef.current = null;
      }
    })();
  }, [prompt, phase, selected, props, finalTitle]);

  const working = phase === "working";
  const namespaces = selected.lookup.listToolNamespaces().length;
  const selectedTokens = tokens[selected.choice] ?? null;

  return (
    <Modal
      open={props.open}
      onOpenChange={props.onOpenChange}
      title="New flow"
      description="Describe what should happen and the AI writes the file — or start from an empty one and build it by hand."
      className="w-[min(52rem,calc(100vw-2rem))]"
      footer={
        <>
          <span className="mr-auto text-[11px] text-ink-faint">
            Saved in this browser only. Nothing is uploaded.
          </span>
          <input
            ref={fileRef}
            type="file"
            accept=".ts,.txt,text/plain"
            className="hidden"
            aria-label="Import a flow file"
            data-testid="new-flow-import-input"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file !== undefined) importFile(file);
            }}
          />
          <Button
            variant="ghost"
            size="md"
            disabled={working}
            data-testid="new-flow-import"
            onClick={() => { fileRef.current?.click(); }}
          >
            <FileUp />
            Import a .flow.ts
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={working}
            data-testid="new-flow-blank"
            onClick={startBlank}
          >
            <Plus />
            Start blank
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={working || !props.configured || prompt.trim().length === 0}
            data-testid="new-flow-generate"
            title={props.configured ? undefined : "Writing a flow needs a model — see the box above"}
            onClick={generate}
          >
            {working ? <LoaderCircle className="animate-spin" /> : <Wand2 />}
            Write it for me
          </Button>
        </>
      }
    >
      <div className="cf-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4" data-testid="new-flow-body">
        {/* ---------------------------------------------------------------- */}
        {/* name                                                              */}
        {/* ---------------------------------------------------------------- */}
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">Name</span>
          <Input
            value={title}
            data-testid="new-flow-name"
            placeholder={
              prompt.trim().length > 0 && !titleTouched
                ? suggestTitle(prompt, props.existing)
                : "Untitled flow — you can rename it later"
            }
            aria-label="Name for this flow"
            onChange={(event) => { setTitle(event.target.value); setTitleTouched(true); }}
          />
        </label>

        {/* ---------------------------------------------------------------- */}
        {/* which tools                                                       */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
            Which tools it may use
          </span>
          <p className="m-0 text-[11.5px] leading-snug text-ink-dim">
            The model is given exactly this registry and nothing else (10 §1), so a step it has no
            tool for comes back as a gap it tells you about rather than an invented call.
          </p>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Which tools this flow may use">
            {options.map((option) => (
              <RegistryChoiceCard
                key={option.choice}
                option={option}
                selected={option.choice === selected.choice}
                tokens={tokens[option.choice] ?? null}
                disabled={working}
                onPick={() => { setChoice(option.choice); }}
              />
            ))}
          </div>
          <p className="m-0 text-[11px] text-ink-faint" data-testid="new-flow-cost">
            {selected.registry.tools.length} tools in {namespaces} namespace{namespaces === 1 ? "" : "s"} ·{" "}
            {selectedTokens === null
              ? "measuring the context…"
              : `≈${selectedTokens.toLocaleString()} tokens of context per round`}
            {selected.registry.functions.length > 0
              ? ` · ${String(selected.registry.functions.length)} library function${selected.registry.functions.length === 1 ? "" : "s"}`
              : ""}
          </p>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* the key, when the visitor is the one holding it                   */}
        {/* ---------------------------------------------------------------- */}
        {props.aiMode === "byok" ? (
          <ByokKeyBox configured={props.configured} model={props.model} {...(props.onKeyChange === undefined ? {} : { onChanged: props.onKeyChange })} />
        ) : !props.configured ? (
          <Notice tone="info" title="No API key — “Start blank” still works">
            Writing a flow needs a model. Put <code className="font-mono text-[11px]">OPENROUTER_API_KEY=…</code> in
            the repo-root <code className="font-mono text-[11px]">.env</code> and restart{" "}
            <code className="font-mono text-[11px]">pnpm dev</code>; the key stays in the dev server and never
            reaches the browser. Everything else here — the empty flow, the palette, the inspector,
            import — needs no key at all.
          </Notice>
        ) : null}

        {/* ---------------------------------------------------------------- */}
        {/* describe it                                                       */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
            Describe what it should do
          </span>
          <textarea
            id="cf-new-flow-prompt"
            name="new-flow-prompt"
            rows={3}
            value={prompt}
            disabled={working || !props.configured}
            data-testid="new-flow-prompt"
            aria-label="Describe the flow you want"
            placeholder={`e.g. “${openers[0] ?? "what should happen, step by step"}”`}
            onChange={(event) => { setPrompt(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                generate();
              }
            }}
            className="cf-scroll min-h-[4.5rem] resize-none rounded-lg border border-line bg-surface-2 px-2.5 py-2 font-sans text-[12.5px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong disabled:opacity-60"
          />
          <div className="flex flex-wrap gap-1.5">
            {openers.map((opener) => (
              <button
                key={opener}
                type="button"
                disabled={working || !props.configured}
                data-testid="new-flow-opener"
                onClick={() => { setPrompt(opener); }}
                className="cursor-pointer rounded-lg border border-line bg-surface-2/60 px-2.5 py-1.5 text-left text-[11.5px] text-ink-dim transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {opener}
              </button>
            ))}
          </div>
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* the loop, in the open                                             */}
        {/* ---------------------------------------------------------------- */}
        {rounds.length === 0 && !working ? null : (
          <div className="flex flex-col gap-2" data-testid="new-flow-rounds">
            <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-ink-faint">
              What the checks found
            </span>
            {rounds.map((round) => (
              <RoundCard key={round.round} round={round} compact />
            ))}
            {working ? (
              <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-2 px-3 py-2">
                <div className="flex items-center gap-2 text-[11.5px] text-ink-dim">
                  <LoaderCircle className="size-3.5 animate-spin text-accent" />
                  <span className="min-w-0 flex-1 truncate">{stage}</span>
                  <span className="tabular-nums text-ink-faint">{elapsed}s</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Stop"
                    title="Stop"
                    onClick={() => { abortRef.current?.abort(); }}
                  >
                    <CircleStop />
                  </Button>
                </div>
                <p className="m-0 text-[10.5px] text-ink-faint">
                  {written.chars === 0
                    ? written.thinking > 0
                      ? `Thinking — ${written.thinking.toLocaleString()} characters of reasoning so far, no answer written yet.`
                      : "Waiting for the first words — a reasoning model thinks before it writes."
                    : `${written.chars.toLocaleString()} characters written${written.thinking > 0 ? ` · ${written.thinking.toLocaleString()} of reasoning first` : ""}`}
                </p>
              </div>
            ) : null}
          </div>
        )}

        {error === null ? null : (
          <div ref={errorRef}>
            <Notice tone="danger" title="That did not work" data-testid="new-flow-error">
              {error}
            </Notice>
          </div>
        )}
        {importNote === null ? null : (
          <Notice tone="warn" title="Import">{importNote}</Notice>
        )}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* one registry, priced                                                        */
/* -------------------------------------------------------------------------- */

function RegistryChoiceCard(props: {
  option: RegistryOption;
  selected: boolean;
  tokens: number | null;
  disabled: boolean;
  onPick: () => void;
}): ReactNode {
  const { option } = props;
  const namespaces = option.lookup.listToolNamespaces();
  return (
    <button
      type="button"
      role="radio"
      aria-checked={props.selected}
      disabled={props.disabled}
      data-testid={`new-flow-registry-${option.choice}`}
      onClick={props.onPick}
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-xl border p-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
        props.selected
          ? "border-accent bg-accent-soft ring-1 ring-accent"
          : "border-line bg-surface hover:bg-surface-2/60",
      )}
    >
      <span className="flex items-start gap-1.5">
        {option.fromMcp ? (
          <ServerCog className="mt-0.5 size-3.5 shrink-0 text-accent" />
        ) : (
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-ink-faint" />
        )}
        <span className="min-w-0 flex-1 text-[12.5px] font-semibold leading-snug text-ink">
          {option.label}
        </span>
      </span>
      <span className="flex flex-wrap items-center gap-1">
        <Badge tone="neutral">{option.registry.tools.length} tools</Badge>
        <Badge tone="neutral">
          {namespaces.length} namespace{namespaces.length === 1 ? "" : "s"}
        </Badge>
        {props.tokens === null ? null : (
          <Badge
            tone={props.tokens > 24000 ? "warn" : "neutral"}
            title="Measured from the real system prompt this registry produces — the contract, the style guide and its generated tools.d.ts, at roughly four characters to a token"
          >
            ≈{props.tokens.toLocaleString()} tokens
          </Badge>
        )}
      </span>
      <span className="truncate text-[10.5px] text-ink-faint">
        {namespaces.length === 0 ? "no tools" : namespaces.slice(0, 5).map((name) => `tools.${name}`).join(" · ")}
        {namespaces.length > 5 ? ` +${String(namespaces.length - 5)}` : ""}
      </span>
    </button>
  );
}
