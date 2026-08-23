/**
 * Talking to the model, from the browser, without a key in the browser.
 *
 * Every call goes to `/api/ai`, a dev-server middleware (see `vite.config.ts`)
 * that holds `OPENROUTER_API_KEY` in the Node process and adds the model and the
 * token budget. This module owns nothing but the message shape, the fetch, and
 * the two extractors that turn a chat answer back into something typed.
 */

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

export interface AiStatus {
  configured: boolean;
  model: string;
  /** The proxy forwards tokens as they are written (see `vite.config.ts`). */
  streaming?: boolean;
  /** Wall-clock ceiling the proxy enforces, in ms. */
  timeoutMs?: number;
}

export async function fetchAiStatus(): Promise<AiStatus> {
  try {
    const response = await fetch("/api/ai/status");
    if (!response.ok) return { configured: false, model: "" };
    return (await response.json()) as AiStatus;
  } catch {
    // Built for production (no dev middleware) or the server is gone — either
    // way the panel says "not configured" rather than throwing.
    return { configured: false, model: "" };
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
}

/**
 * One completion, streamed.
 *
 * The proxy answers `text/event-stream` with three frame shapes — `{start}`,
 * `{delta}`, `{done}` — or `{error}` at any point. A non-streaming JSON body is
 * still accepted, because a production build has no dev middleware behind this
 * URL and the failure should read as "not configured", not as a parse error.
 */
export async function callModel(
  messages: ChatMessage[],
  options: CallModelOptions = {},
): Promise<ModelAnswer> {
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
