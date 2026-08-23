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

export async function callModel(messages: ChatMessage[], signal?: AbortSignal): Promise<ModelAnswer> {
  const response = await fetch("/api/ai", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
    ...(signal === undefined ? {} : { signal }),
  });

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

/**
 * Models wrap code in fences however they were asked not to; that is a prompt
 * artefact, not a conformance defect, so it is stripped before validation.
 * (Same rule as the conformance eval — 11 §3.6.)
 */
export function extractFlowSource(content: string): string {
  const fenced = /```(?:ts|typescript|javascript|js)?\s*\n([\s\S]*?)```/.exec(content);
  const source = fenced === null ? content : (fenced[1] ?? "");
  return `${source.trim()}\n`;
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
