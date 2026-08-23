/**
 * What survives a reload.
 *
 * QA BUG-1 had two halves. The first was a Fast Refresh boundary in
 * `@codeflow/react` that turned every library rebuild into `full-reload`; that
 * is fixed at the source. The second half is the product's, and no boundary fix
 * closes it: the app kept everything in React state, so one stray F5 — or a
 * crash, or a closed laptop — threw away the conversation and the flow the user
 * had just spent four minutes generating. There was no save, no history, and no
 * warning.
 *
 * `sessionStorage`, not `localStorage`, on purpose: this is a scratch pad for
 * the tab you are working in, not a document store. It dies with the tab, which
 * is the honest lifetime for something the user never asked to save.
 */

const PREFIX = "codeflow.demo.v1.";

function read<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    // Private mode, a quota error, or a payload written by an older build —
    // none of which is worth a broken app.
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* storage is full or unavailable — the app works, it just forgets */
  }
}

/**
 * The flow on screen: which flow it is, and its current text.
 *
 * `exampleId` is the id of a built-in example *or* of one of the visitor's own
 * flows (`my-flows.ts`), which is why the id space of the two was made not to
 * overlap. For a flow of their own the text is also in `localStorage`, saved as
 * a document; this copy is the tab's scratch pad and is what makes an *unsaved*
 * edit to somebody else's example survive an accidental reload without ever
 * being written back into the example.
 */
export interface KeptFlow {
  exampleId: string;
  source: string;
}

export function loadFlow(): KeptFlow | null {
  const kept = read<KeptFlow>("flow");
  if (kept === null || typeof kept.exampleId !== "string" || typeof kept.source !== "string") return null;
  return kept;
}

export function saveFlow(flow: KeptFlow): void {
  write("flow", flow);
}

export function loadChat<T>(): T | null {
  return read<T>("chat");
}

export function saveChat(chat: unknown): void {
  write("chat", chat);
}
