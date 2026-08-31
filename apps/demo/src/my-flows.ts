/**
 * The visitor's own flows.
 *
 * Until this file existed, the demo had thirteen read-only examples and nowhere
 * to put anything you made: asking the AI for a new flow overwrote whichever
 * example happened to be open, and the only copy of it lived in a
 * `sessionStorage` scratch slot that died with the tab. "Describe what you want,
 * the AI writes it, you keep it" was missing its last word.
 *
 * ## Where they live
 *
 * `localStorage`, not the `sessionStorage` `persist.ts` uses, and the argument
 * there is the argument for the difference here: a scratch edit to somebody
 * else's example should die with the tab, but a flow you *named* is a document.
 * It survives the tab, the reload and the closed laptop. There is no server in
 * the public build to put it anywhere else, and saying "your flows are on this
 * machine, in this browser" is honest in a way that a silent sync would not be.
 *
 * Every write reports whether it took (`StorageOutcome`). A browser in private
 * mode, or one whose quota is full, refuses — and the UI says so out loud rather
 * than showing a saved flow that is not saved (07 §5).
 *
 * ## Why a `FlowExample`
 *
 * The whole app is written against `FlowExample`: the canvas, the chat panel,
 * the about panel, the trigger-input store and the gallery all take one. A
 * visitor's flow *is* one of those — a title, a summary, a registry and a
 * source — so it is adapted into that shape rather than threaded through the
 * app as a second kind of thing. `isMine` recovers the record when a caller
 * needs the parts a `FlowExample` has no field for.
 */

import type { ConformanceLevel } from "@codeflow/core";
import { REGISTRIES, type FlowExample } from "./examples-source.js";

/** `registryChoice` when the flow was written against the visitor's MCP servers. */
export const MCP_REGISTRY = "__mcp__";

export interface MyFlowGeneration {
  /** What the generation loop reached — L0/L1/L2, or `invalid`. */
  level: ConformanceLevel;
  rounds: number;
  /** What is still unresolved, in one sentence. `null` when nothing is. */
  unresolved: string | null;
}

export interface MyFlow {
  /** Stable, and prefixed so it can never collide with a built-in example id. */
  id: string;
  title: string;
  source: string;
  /** A key in `REGISTRIES`, or `MCP_REGISTRY`. */
  registryChoice: string;
  createdAt: number;
  updatedAt: number;
  /** The example this was saved out of, when it started as somebody else's. */
  origin: { exampleId: string; exampleTitle: string } | null;
  /** What the visitor asked for, kept so the card can say where it came from. */
  prompt: string | null;
  /** How the generation went. `null` for a blank or imported flow. */
  generation: MyFlowGeneration | null;
}

/** A `MyFlow` wearing the shape the rest of the app already reads. */
export interface MineFlowExample extends FlowExample {
  mine: MyFlow;
}

export function isMine(example: FlowExample): example is MineFlowExample {
  return "mine" in example;
}

const PREFIX = "mine-";
const STORAGE_KEY = "codeflow.demo.my-flows.v1";

export function newFlowId(): string {
  return `${PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/* -------------------------------------------------------------------------- */
/* the blank flow                                                              */
/* -------------------------------------------------------------------------- */

/**
 * A flow with nothing in it that is still a flow.
 *
 * "Start blank" has to produce something the analyzer accepts on the first pass:
 * a default-exported async function with the two contract parameters (01 §1) and
 * an empty body. It draws as a trigger and an end, the palette can insert
 * between them and the inspector can edit what it inserts — which is the whole
 * point of offering it. It is deliberately not a stub with a fake tool call in
 * it: a made-up step would have to be deleted before anything real could happen,
 * and it would name a tool the chosen registry might not have.
 *
 * The `input` type is not empty either, and that is not decoration: 01 §1 says
 * the first parameter's type *is* the trigger, so an empty one would give the
 * trigger-input form nothing to show and the newcomer nothing to fill in.
 */
export function blankFlowSource(): string {
  return `import type { Tools } from "../generated/tools";

/**
 * A new flow.
 *
 * The first parameter is the trigger payload (01 §1) — whatever starts this
 * flow arrives here, and the run panel builds its form from this type. The
 * second is the only way to reach a tool.
 *
 * Add a step with the palette (⌘K), or describe what you want in the AI panel
 * (⌘J) and it will write the whole file.
 */
export default async function flow(
  input: { message: string },
  tools: Tools,
) {
  // No steps yet.
}
`;
}

/* -------------------------------------------------------------------------- */
/* storage                                                                     */
/* -------------------------------------------------------------------------- */

export type StorageOutcome = { ok: true } | { ok: false; error: string };

function describeStorageFailure(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (cause instanceof DOMException && (cause.name === "QuotaExceededError" || cause.code === 22)) {
    return "This browser's local storage is full, so the flow was not saved. Delete a flow you no longer need, or export this one to a file before you leave the page.";
  }
  return `This browser refused to save to local storage (${message}), so the flow exists only until you leave the page. Private-browsing windows do this. Export it to a file to keep it.`;
}

function isMyFlow(value: unknown): value is MyFlow {
  if (typeof value !== "object" || value === null) return false;
  const flow = value as Partial<MyFlow>;
  return (
    typeof flow.id === "string" &&
    typeof flow.title === "string" &&
    typeof flow.source === "string" &&
    typeof flow.registryChoice === "string"
  );
}

/** Everything saved, newest first. Never throws — a broken payload reads as none. */
export function loadMyFlows(): MyFlow[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isMyFlow)
      .map((flow) => ({
        ...flow,
        createdAt: typeof flow.createdAt === "number" ? flow.createdAt : 0,
        updatedAt: typeof flow.updatedAt === "number" ? flow.updatedAt : 0,
        origin: flow.origin ?? null,
        prompt: flow.prompt ?? null,
        generation: flow.generation ?? null,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    // A payload written by a future build, or storage that is simply not there.
    // Neither is worth a blank app.
    return [];
  }
}

export function saveMyFlows(flows: readonly MyFlow[]): StorageOutcome {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(flows));
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: describeStorageFailure(cause) };
  }
}

/* -------------------------------------------------------------------------- */
/* the shape the app already reads                                             */
/* -------------------------------------------------------------------------- */

/** A trailing newline is not a line — the same rule `@codeflow/examples` uses. */
export function countLines(source: string): number {
  return source.replace(/\n$/, "").split("\n").length;
}

export function registryLabelFor(choice: string): string {
  if (choice === MCP_REGISTRY) return "Your MCP servers";
  return REGISTRIES[choice]?.label ?? choice;
}

/**
 * `MyFlow` → `FlowExample`, plus the record itself under `mine`.
 *
 * `registryId` is only ever a real key: an MCP-backed flow borrows the first
 * built-in id so that nothing which reaches for `registryFor` can throw, and
 * `flow-registry.ts` — which is what the app actually resolves through — reads
 * `mine.registryChoice` instead and never consults this field.
 */
export function asExample(flow: MyFlow): MineFlowExample {
  const fallback = Object.keys(REGISTRIES)[0] ?? "sample";
  const registryId = flow.registryChoice === MCP_REGISTRY ? fallback : flow.registryChoice;
  const highlights: string[] = [];
  if (flow.generation !== null) highlights.push(`generated · ${flow.generation.level}`);
  if (flow.origin !== null) highlights.push(`from “${flow.origin.exampleTitle}”`);
  if (flow.prompt !== null && flow.prompt.length > 0) highlights.push(`“${flow.prompt.slice(0, 60)}”`);

  return {
    id: flow.id,
    title: flow.title,
    category: "basics",
    summary:
      flow.prompt !== null && flow.prompt.length > 0
        ? flow.prompt.slice(0, 160)
        : flow.origin !== null
          ? `Saved from the “${flow.origin.exampleTitle}” example.`
          : "A flow you made. It is stored in this browser only.",
    description:
      flow.prompt !== null && flow.prompt.length > 0
        ? `You asked for: “${flow.prompt}”. It runs against ${registryLabelFor(flow.registryChoice)}, and it is stored in this browser's local storage — nothing was uploaded anywhere.`
        : `One of your own flows, running against ${registryLabelFor(flow.registryChoice)}. It is stored in this browser's local storage — nothing was uploaded anywhere.`,
    lines: countLines(flow.source),
    highlights,
    registryId,
    source: flow.source,
    mine: flow,
  };
}

/* -------------------------------------------------------------------------- */
/* naming                                                                      */
/* -------------------------------------------------------------------------- */

const STOP_WORDS = new Set([
  "a", "an", "and", "the", "to", "for", "of", "in", "on", "at", "with", "then",
  "every", "each", "that", "it", "its", "into", "from", "when", "whenever",
]);

/**
 * A default name derived from what the visitor asked for.
 *
 * Not "Untitled flow (3)": a newcomer who types "post every new pull request to
 * #releases" and gets back a flow called `Untitled 3` has been given a filing
 * problem for free. The first few meaningful words are a better guess than any
 * counter, and the field is editable before and after.
 */
export function suggestTitle(prompt: string, existing: readonly MyFlow[] = []): string {
  const words = prompt
    .replace(/[`"'*_#]/g, " ")
    .split(/\s+/)
    .map((word) => word.replace(/[^A-Za-z0-9#.-]/g, ""))
    .filter((word) => word.length > 0);
  const meaningful = words.filter((word) => !STOP_WORDS.has(word.toLowerCase())).slice(0, 5);
  const base =
    meaningful.length === 0
      ? "Untitled flow"
      : `${(meaningful[0] as string).charAt(0).toUpperCase()}${(meaningful[0] as string).slice(1)}${meaningful.length > 1 ? ` ${meaningful.slice(1).join(" ")}` : ""}`;
  return uniqueTitle(base, existing);
}

export function uniqueTitle(base: string, existing: readonly MyFlow[]): string {
  const taken = new Set(existing.map((flow) => flow.title.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; n < 500; n++) {
    const candidate = `${base} ${String(n)}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${String(Date.now())}`;
}

/* -------------------------------------------------------------------------- */
/* export / import — a real file, on disk                                      */
/* -------------------------------------------------------------------------- */

/**
 * The header a `.flow.ts` export carries.
 *
 * It is a comment, so the file is still exactly the TypeScript it claims to be:
 * drop it in a real repository next to a generated `tools.d.ts` and it compiles.
 * The header only exists so that re-importing it here can restore the *name* and
 * the *registry* the flow was written against — two facts the source itself does
 * not carry, and guessing either of them would be a lie.
 */
const HEADER = /^\/\* codeflow:flow (\{[\s\S]*?\}) \*\/\n?/;

export function fileNameFor(flow: Pick<MyFlow, "title">): string {
  const slug = flow.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug.length === 0 ? "flow" : slug}.flow.ts`;
}

export function exportFlowFile(flow: Pick<MyFlow, "title" | "registryChoice" | "source">): string {
  const meta = JSON.stringify({
    name: flow.title,
    registry: flow.registryChoice,
    exportedAt: new Date().toISOString(),
  });
  return `/* codeflow:flow ${meta} */\n${flow.source.replace(HEADER, "")}`;
}

export interface ImportedFlow {
  title: string | null;
  registryChoice: string | null;
  source: string;
}

/**
 * Read a `.flow.ts` back.
 *
 * A file with no header is still imported — it is a flow file somebody wrote by
 * hand, or exported from a repository, and refusing it would make export/import
 * useful only for round-tripping our own files. The name then comes from the
 * file name and the registry from whatever the visitor has chosen, and the
 * dialog says so rather than pretending it knew.
 */
export function parseFlowFile(text: string, fileName: string): ImportedFlow {
  const match = HEADER.exec(text);
  if (match === null) {
    return {
      title: fileName.replace(/\.flow\.ts$|\.ts$/, "").replace(/[-_]+/g, " ").trim() || null,
      registryChoice: null,
      source: text,
    };
  }
  let title: string | null = null;
  let registryChoice: string | null = null;
  try {
    const meta = JSON.parse(match[1] as string) as { name?: unknown; registry?: unknown };
    if (typeof meta.name === "string" && meta.name.length > 0) title = meta.name;
    if (typeof meta.registry === "string" && meta.registry.length > 0) registryChoice = meta.registry;
  } catch {
    // A header we cannot read is a header we ignore; the file is still a file.
  }
  return { title, registryChoice, source: text.slice(match[0].length) };
}
