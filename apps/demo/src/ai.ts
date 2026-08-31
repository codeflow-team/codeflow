/**
 * Talking to the model, from the browser.
 *
 * There are two ways the key can be held, and the panel must never be vague
 * about which one is in play:
 *
 *  - **`proxy`** — the local `pnpm dev` server. Calls go to `/api/ai`, a
 *    middleware (see `vite.config.ts`) that holds `OPENROUTER_API_KEY` in the
 *    Node process and adds the model and the token budget. Nothing about the
 *    key reaches the bundle.
 *  - **`byok`** — the public, static build. There is no server to hold a key,
 *    so the *visitor* supplies their own: it is kept in `localStorage` on their
 *    machine and sent from their browser straight to `openrouter.ai`. It is
 *    never sent to the origin serving this page, because that origin is a CDN
 *    that could not use it anyway. The alternative — one shared key in a
 *    serverless function — is a key anyone can drain, so it is not offered.
 *
 * Beyond the seam, both modes produce the same `ModelAnswer`, and this module
 * owns nothing else but the message shape and the two extractors that turn a
 * chat answer back into something typed.
 */

import { IS_PUBLIC_BUILD } from "./deployment.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ModelAnswer {
  content: string;
  finishReason: string | null;
  model: string;
  ms: number;
}

/** Which of the two key-holding arrangements this page is running under. */
export type AiMode = "proxy" | "byok";

export interface AiStatus {
  configured: boolean;
  model: string;
  /** `proxy` when a dev server holds the key, `byok` when the visitor does. */
  mode?: AiMode;
  /** The proxy forwards tokens as they are written (see `vite.config.ts`). */
  streaming?: boolean;
  /** Wall-clock ceiling the proxy enforces, in ms. */
  timeoutMs?: number;
}

/* -------------------------------------------------------------------------- */
/* bring-your-own-key                                                          */
/* -------------------------------------------------------------------------- */

const KEY_STORAGE = "codeflow.demo.openrouter-key";

/** Default for BYOK. Free on OpenRouter, and the model the evals were run on. */
/**
 * Default model for a visitor's own key.
 *
 * `openrouter/free` is a *router* across whatever free models exist right now,
 * not one model id. That matters more than it sounds: the previous default,
 * `stealth/ox-alpha`, was retired from OpenRouter and every AI feature in this
 * demo started failing against a model that no longer existed — a dead constant
 * nothing could have caught, because the id stayed perfectly valid-looking.
 * A router cannot rot the same way.
 *
 * It routes to reasoning models, so the token cap must stay generous: too small
 * a cap comes back `content: null` with the whole budget spent on reasoning,
 * and no error at all.
 */
export const BYOK_DEFAULT_MODEL = "openrouter/free";

const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
/** Same budget the dev proxy uses — too small a cap returns `content: null`. */
const BYOK_MAX_TOKENS = 32000;

/** The visitor's own OpenRouter key, or null. Never leaves this browser except to OpenRouter. */
export function getUserKey(): string | null {
  try {
    const stored = localStorage.getItem(KEY_STORAGE);
    return stored !== null && stored.length > 0 ? stored : null;
  } catch {
    // Private mode / storage disabled. BYOK is simply unavailable, not broken.
    return null;
  }
}

export function setUserKey(key: string): void {
  try {
    localStorage.setItem(KEY_STORAGE, key.trim());
  } catch {
    /* nothing sensible to do; the caller re-reads the status and sees it did not take */
  }
}

export function clearUserKey(): void {
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* see setUserKey */
  }
}

/** Status for the BYOK arrangement, read from local storage only. */
export function byokStatus(): AiStatus {
  return {
    configured: getUserKey() !== null,
    model: BYOK_DEFAULT_MODEL,
    mode: "byok",
    streaming: true,
  };
}

export async function fetchAiStatus(): Promise<AiStatus> {
  // The public build has no `/api/ai` at all; asking for it would only produce a
  // 404 and a console error on every load.
  if (IS_PUBLIC_BUILD) return byokStatus();

  try {
    const response = await fetch("/api/ai/status");
    if (!response.ok) return byokStatus();
    const status = (await response.json()) as AiStatus;
    // A dev server that is running but has no key in `.env` is still better
    // served by BYOK than by a dead panel.
    return status.configured ? { ...status, mode: "proxy" } : byokStatus();
  } catch {
    // Built for production (no dev middleware) or the server is gone — fall
    // back to the visitor's own key rather than reporting a broken feature.
    return byokStatus();
  }
}

export interface CallModelOptions {
  signal?: AbortSignal;
  /**
   * Called with every fragment the model writes, in order.
   *
   * Progress that is actually progress: a reasoning model writing a 60-node
   * flow takes minutes, and a spinner that says the same sentence for five of
   * them is indistinguishable from a hang (QA BUG-7). The caller uses this to
   * show the answer taking shape.
   */
  onDelta?: (delta: string, whole: string) => void;
  /**
   * Called with how much *reasoning* the model has produced so far.
   *
   * A reasoning model writes nothing for minutes and then the whole file at
   * once; without this the progress line has nothing to report during the part
   * of the wait that is longest.
   */
  onThinking?: (characters: number) => void;
  /**
   * Which key-holding arrangement to use. Defaults to the one this build has:
   * `byok` in the public static build, `proxy` under `pnpm dev`.
   */
  mode?: AiMode;
  /** Model id for `byok`; ignored in `proxy` mode, where the server decides. */
  model?: string;
}

/**
 * One completion, streamed.
 *
 * The proxy answers `text/event-stream` with three frame shapes — `{start}`,
 * `{delta}`, `{done}` — or `{error}` at any point. A non-streaming JSON body is
 * still accepted, because a production build has no dev middleware behind this
 * URL and the failure should read as "not configured", not as a parse error.
 *
 * In `byok` mode there is no proxy: this talks to OpenRouter directly with the
 * visitor's own key and normalizes their SSE into the same `ModelAnswer`.
 */
export async function callModel(
  messages: ChatMessage[],
  options: CallModelOptions = {},
): Promise<ModelAnswer> {
  const mode = options.mode ?? (IS_PUBLIC_BUILD ? "byok" : "proxy");
  if (mode === "byok") return await callModelDirect(messages, options);

  const response = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, stream: true }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || response.body === null) {
    return await readWholeBody(response);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  let model = "";
  let ms = 0;
  let done = false;

  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    buffer += decoder.decode(step.value, { stream: true });

    let cut = buffer.indexOf("\n\n");
    while (cut !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      cut = buffer.indexOf("\n\n");

      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = JSON.parse(line.slice(5).trim()) as {
          start?: boolean;
          delta?: string;
          thinking?: number;
          done?: boolean;
          error?: string;
          finishReason?: string | null;
          model?: string;
          ms?: number;
        };
        if (payload.error !== undefined) throw new Error(payload.error);
        if (payload.model !== undefined) model = payload.model;
        if (payload.thinking !== undefined) options.onThinking?.(payload.thinking);
        if (payload.delta !== undefined) {
          content += payload.delta;
          options.onDelta?.(payload.delta, content);
        }
        if (payload.done === true) {
          done = true;
          finishReason = payload.finishReason ?? null;
          ms = payload.ms ?? 0;
        }
      }
    }
  }

  if (!done && content.trim().length === 0) {
    throw new Error("The connection to the model closed before it wrote anything.");
  }
  if (content.trim().length === 0) {
    throw new Error(
      `The model returned nothing (finish_reason=${String(finishReason ?? "?")}). This is what a reasoning model does when the token budget runs out.`,
    );
  }

  return { content, finishReason, model, ms };
}

/* -------------------------------------------------------------------------- */
/* byok: browser -> OpenRouter, no origin in between                           */
/* -------------------------------------------------------------------------- */

/**
 * The same completion, but the request leaves the visitor's browser directly.
 *
 * OpenRouter allows browser origins, so no proxy is needed once the visitor is
 * the one holding the key. The frames are OpenAI-shaped rather than the dev
 * proxy's normalized ones, so the deltas are read out of
 * `choices[0].delta.content` (and `.reasoning`, which is what a reasoning model
 * emits during the long silence before it writes any answer).
 *
 * The 429 retry the dev proxy does is deliberately *not* repeated here: this is
 * the visitor's own quota on their own key, and silently spending three times
 * as much of it is not a favour. One clear failure is better.
 */
async function callModelDirect(
  messages: ChatMessage[],
  options: CallModelOptions,
): Promise<ModelAnswer> {
  const key = getUserKey();
  if (key === null) {
    throw new Error(
      "No OpenRouter key. Paste one into the key box above — it stays in this browser and is sent only to openrouter.ai.",
    );
  }
  const model = options.model ?? BYOK_DEFAULT_MODEL;
  const started = Date.now();

  const response = await fetch(OPENROUTER_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": window.location.origin,
      "X-Title": "CodeFlow demo",
    },
    body: JSON.stringify({ model, messages, max_tokens: BYOK_MAX_TOKENS, stream: true }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `OpenRouter rejected the key (HTTP ${String(response.status)}). Check it at openrouter.ai/keys, then paste it again.`,
      );
    }
    throw new Error(`OpenRouter ${String(response.status)}: ${text.slice(0, 300)}`);
  }
  if (response.body === null) {
    throw new Error("OpenRouter answered with an empty body.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  let reasoning = 0;
  let reported = 0;

  for (;;) {
    const step = await reader.read();
    if (step.done) break;
    buffer += decoder.decode(step.value, { stream: true });

    let cut = buffer.indexOf("\n\n");
    while (cut !== -1) {
      const frame = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      cut = buffer.indexOf("\n\n");

      for (const line of frame.split("\n")) {
        // `: OPENROUTER PROCESSING` keep-alive comments are not data frames.
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]" || data.length === 0) continue;

        let parsed: {
          choices?: {
            delta?: { content?: string | null; reasoning?: string | null };
            finish_reason?: string | null;
          }[];
          error?: { message?: string };
        };
        try {
          parsed = JSON.parse(data) as typeof parsed;
        } catch {
          continue;
        }
        if (parsed.error !== undefined) throw new Error(parsed.error.message ?? "upstream error");

        const choice = parsed.choices?.[0];
        if (choice?.finish_reason != null) finishReason = choice.finish_reason;
        reasoning += (choice?.delta?.reasoning ?? "").length;
        const delta = choice?.delta?.content ?? "";
        if (delta.length > 0) {
          content += delta;
          options.onDelta?.(delta, content);
        } else if (reasoning - reported >= 400) {
          reported = reasoning;
          options.onThinking?.(reasoning);
        }
      }
    }
  }

  if (content.trim().length === 0) {
    throw new Error(
      `The model returned nothing (finish_reason=${String(finishReason ?? "?")}). This is what a reasoning model does when the token budget runs out.`,
    );
  }

  return { content, finishReason, model, ms: Date.now() - started };
}

async function readWholeBody(response: Response): Promise<ModelAnswer> {
  const text = await response.text();
  let payload: { content?: string; finishReason?: string | null; model?: string; ms?: number; error?: string };
  try {
    payload = JSON.parse(text) as typeof payload;
  } catch {
    throw new Error(`The proxy answered with something that is not JSON: ${text.slice(0, 200)}`);
  }

  if (!response.ok || payload.error !== undefined) {
    throw new Error(payload.error ?? `HTTP ${String(response.status)}`);
  }
  if ((payload.content ?? "").trim().length === 0) {
    throw new Error(
      `The model returned nothing (finish_reason=${String(payload.finishReason ?? "?")}). This is what a reasoning model does when the token budget runs out.`,
    );
  }

  return {
    content: payload.content ?? "",
    finishReason: payload.finishReason ?? null,
    model: payload.model ?? "",
    ms: payload.ms ?? 0,
  };
}

/** Where a flow file starts, when the model did not fence it. */
const FILE_STARTS = /^\s*(?:import\b|export\b|\/\*\*|\/\/|type\b|interface\b|const\b|let\b|async\b|function\b|@)/;

/**
 * The file, and whatever the model wrote around it.
 *
 * QA BUG-13: the node-edit path returns a `why` sentence and the panel shows
 * it, but the whole-flow path showed nothing except a level badge and a diff.
 * When the model *refused* to invent a Jira tool and left a `// TODO` instead —
 * exactly the behaviour worth seeing — the only way to find out was to read a
 * three-hundred-line diff. So the panel now asks for one sentence in front of
 * the file and shows it, and this function separates the two.
 *
 * Both shapes are handled, because the core prompt (10 §4) asks for a bare file
 * and the panel asks for a fenced one: a fenced answer splits on the fence, an
 * unfenced answer splits at the first line that can begin a TypeScript file.
 * Anything before it is prose, never code, so nothing that belongs in the file
 * can be lost this way.
 */
export function splitAnswer(content: string): { source: string; prose: string | null } {
  const fence = /```(?:ts|typescript|javascript|js)?\s*\n([\s\S]*?)```/.exec(content);
  if (fence !== null) {
    const before = content.slice(0, fence.index).trim();
    const after = content.slice(fence.index + fence[0].length).trim();
    return { source: `${(fence[1] ?? "").trim()}\n`, prose: tidyProse(`${before}\n\n${after}`) };
  }

  const lines = content.split("\n");
  const start = lines.findIndex((line) => FILE_STARTS.test(line));
  if (start > 0) {
    return {
      source: `${lines.slice(start).join("\n").trim()}\n`,
      prose: tidyProse(lines.slice(0, start).join("\n")),
    };
  }
  return { source: `${content.trim()}\n`, prose: null };
}

function tidyProse(text: string): string | null {
  const prose = text
    .replace(/^(?:here(?:'s| is)[^\n]*|the (?:complete|updated|full) file[^\n]*)$/gim, "")
    .trim();
  // A stray "Here is the file:" is noise; a real explanation is a sentence.
  return prose.length < 12 ? null : prose.slice(0, 1200);
}

/** First JSON object in an answer, or null when there is none. */
export function extractJson(content: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)```/.exec(content);
  const candidate = fenced === null ? content : (fenced[1] ?? "");
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* a line diff, for previewing a whole-file proposal                           */
/* -------------------------------------------------------------------------- */

export interface DiffHunk {
  /** 1-based line number in the current file where this hunk starts. */
  line: number;
  removed: string[];
  added: string[];
}

/**
 * Line-level diff of two files, collapsed into hunks.
 *
 * A patch-engine edit is previewed with `<CodeDiff>` over the real `TextPatch[]`
 * — that is the honest thing to show, because those *are* the ranges that will
 * be written. A whole-file proposal from the model has no patches yet, so it
 * gets this instead: a plain LCS diff, clearly labelled as a rewrite.
 */
export function diffLines(before: string, after: string): DiffHunk[] {
  const a = before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");

  // Standard LCS table; files here are hundreds of lines, not megabytes.
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? (table[i + 1]![j + 1] ?? 0) + 1 : Math.max(table[i + 1]![j] ?? 0, table[i]![j + 1] ?? 0);
    }
  }

  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let i = 0;
  let j = 0;

  const open = (): DiffHunk => {
    if (current === null) {
      current = { line: i + 1, removed: [], added: [] };
      hunks.push(current);
    }
    return current;
  };

  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      current = null;
      i++;
      j++;
    } else if ((table[i + 1]![j] ?? 0) >= (table[i]![j + 1] ?? 0)) {
      open().removed.push(a[i] ?? "");
      i++;
    } else {
      open().added.push(b[j] ?? "");
      j++;
    }
  }
  while (i < a.length) { open().removed.push(a[i] ?? ""); i++; }
  while (j < b.length) { open().added.push(b[j] ?? ""); j++; }

  return hunks;
}
