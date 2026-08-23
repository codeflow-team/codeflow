/**
 * The input a run starts from — the browser's half.
 *
 * ## Why this exists
 *
 * The runner has always accepted an `input` and always synthesized one when the
 * caller sent none. The browser sent none, and showed none. So every run in this
 * demo started from values a machine guessed, which the visitor could not see,
 * could not judge and could not change — and 01 §1 says the flow's first
 * parameter *is* the trigger, so "there is nowhere to fill the trigger in" was a
 * hole straight through the middle of the thing being demonstrated.
 *
 * ## The shape comes from the server, on purpose
 *
 * `POST /api/run/input` returns both the type's shape and the synthesized
 * default, because both are `server/input.ts`'s rules and one copy of a rule is
 * the only number of copies that stays true. When there is no dev server — the
 * public build is a static bundle — the shape is simply unavailable, and this
 * says so rather than inventing a form (07 §5).
 *
 * ## One state, two surfaces
 *
 * `useTriggerInput` is called **once**, in `App`, and handed to both the
 * pre-run panel and the trigger node's inspector. They are the same input seen
 * from two places, not two inputs that need reconciling.
 *
 * ## Paths
 *
 * A field is addressed by a dotted path — `repository`, `limits.maxFiles`,
 * `roots.0`. The empty string addresses the whole input, which is what the
 * JSON-editor fallback edits.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeExpectedType, describeValue } from "./argument-types.js";

/* -------------------------------------------------------------------------- */
/* the shape, as the server describes it                                       */
/* -------------------------------------------------------------------------- */

export type FieldKind = "string" | "number" | "boolean" | "enum" | "array" | "object" | "json";

export interface EnumOption {
  value: string | number;
  label: string;
}

export interface FieldSpec {
  name: string;
  path: string;
  kind: FieldKind;
  typeText: string;
  optional: boolean;
  options?: EnumOption[];
  item?: { kind: "string" | "number" | "boolean" | "enum"; typeText: string; options?: EnumOption[] };
  fields?: FieldSpec[];
  /** `kind: "json"` — why the form has no control for this. Always present. */
  reason?: string;
  /** Why the suggested value is what it is. Absent when no rule produced it. */
  why?: string;
}

export type TriggerInputSpec =
  | { kind: "none"; paramName: null; typeText: null; fields: []; suggested: Record<string, never>; workspaceToken: string }
  | { kind: "object"; paramName: string; typeText: string; fields: FieldSpec[]; suggested: Record<string, unknown>; workspaceToken: string }
  | { kind: "json"; paramName: string; typeText: string | null; reason: string; fields: []; suggested: Record<string, unknown>; workspaceToken: string };

export const WORKSPACE_TOKEN = "{{workspace}}";

/**
 * What `{{workspace}}` means, in one sentence the panel prints next to any
 * field containing it.
 *
 * The scratch directory is created per run and deleted after it, so a real
 * `/var/folders/…` shown before a run would name a folder that does not exist
 * yet and, once remembered across a reload, one that never will again. The token
 * is expanded by the runner at the moment the folder is made.
 */
export const WORKSPACE_TOKEN_NOTE =
  "{{workspace}} is replaced, when the run starts, with that run's scratch folder — a fresh temporary directory seeded with a small source tree. The filesystem MCP server is rooted there and refuses every path outside it.";

/* -------------------------------------------------------------------------- */
/* fetching it                                                                 */
/* -------------------------------------------------------------------------- */

const specCache = new Map<string, TriggerInputSpec>();

export async function fetchTriggerInputSpec(source: string): Promise<TriggerInputSpec> {
  const cached = specCache.get(source);
  if (cached !== undefined) return cached;
  const response = await fetch("/api/run/input", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source }),
  });
  if (!response.ok) throw new Error(`The dev server answered ${String(response.status)}.`);
  const spec = (await response.json()) as TriggerInputSpec;
  if (typeof spec.kind !== "string") throw new Error("The dev server answered with something that is not an input shape.");
  specCache.set(source, spec);
  return spec;
}

/* -------------------------------------------------------------------------- */
/* paths                                                                       */
/* -------------------------------------------------------------------------- */

function readPath(root: unknown, path: string): unknown {
  if (path === "") return root;
  let cursor = root;
  for (const step of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = Array.isArray(cursor)
      ? (cursor as unknown[])[Number(step)]
      : (cursor as Record<string, unknown>)[step];
  }
  return cursor;
}

/** `root` with `path` set to `value`, structurally shared everywhere else. */
function writePath(root: unknown, path: string, value: unknown): unknown {
  if (path === "") return value;
  const [head, ...rest] = path.split(".");
  if (head === undefined) return value;
  const tail = rest.join(".");
  const index = Number(head);
  if (Array.isArray(root) && Number.isInteger(index)) {
    const next = root.slice();
    next[index] = tail === "" ? value : writePath(next[index], tail, value);
    return next;
  }
  const base = typeof root === "object" && root !== null ? (root as Record<string, unknown>) : {};
  return { ...base, [head]: tail === "" ? value : writePath(base[head], tail, value) };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== "object") return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/* -------------------------------------------------------------------------- */
/* validating against the type                                                 */
/* -------------------------------------------------------------------------- */

export interface InputProblem {
  path: string;
  message: string;
}

const NUMBER_TEXT = /^[+-]?(?:\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)$/;

/**
 * Everything about `value` that contradicts `spec`, in the words the inspector
 * already uses for the same mistake (`argument-types.ts`).
 *
 * The same asymmetry that module is built on holds here: this only reports what
 * it is certain about. A field the form cannot express is checked for *being
 * JSON at all* and nothing more, because the shape behind it was never read.
 */
export function validateInput(
  spec: TriggerInputSpec,
  value: unknown,
  drafts: Record<string, string>,
): InputProblem[] {
  const problems: InputProblem[] = [];

  if (spec.kind === "json") {
    const text = drafts[""] ?? "";
    if (text.trim().length === 0) {
      problems.push({ path: "", message: "The input is empty. Write a JSON object, or press Reset for the suggested one." });
      return problems;
    }
    const parsed = parseJson(text);
    if (parsed.ok) {
      if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
        problems.push({ path: "", message: `The trigger takes an object, but this is ${describeValue(parsed.value)}.` });
      }
    } else {
      problems.push({ path: "", message: `This is not valid JSON — ${parsed.message}` });
    }
    return problems;
  }

  if (spec.kind === "none") return problems;

  const walk = (fields: FieldSpec[]): void => {
    for (const field of fields) {
      const current = readPath(value, field.path);
      const draft = drafts[field.path];

      // Checked before the missing-value guard, because a JSON field's value is
      // whatever its *text* last parsed to: half-typed JSON leaves the value at
      // the previous one — often `null` — and skipping it there is how invalid
      // JSON once sailed past this check and into a run.
      if (field.kind === "json") {
        if (draft === undefined) continue;
        if (draft.trim().length === 0) {
          if (!field.optional) {
            problems.push({ path: field.path, message: `${field.name} is empty, and the type says it always has a value (${field.typeText}).` });
          }
          continue;
        }
        const parsed = parseJson(draft);
        if (!parsed.ok) problems.push({ path: field.path, message: `${field.name} is not valid JSON — ${parsed.message}` });
        continue;
      }

      if (current === undefined || current === null) {
        if (!field.optional) {
          problems.push({
            path: field.path,
            message: `${field.name} has no value, and the type says it always has one (${field.typeText}).`,
          });
        }
        continue;
      }

      switch (field.kind) {
        case "string":
          if (typeof current !== "string") {
            problems.push({ path: field.path, message: mismatch(field, "string", current) });
          }
          break;
        case "number":
          // The draft is what is on screen; the value only follows it once it
          // parses. Checking the text is what makes `"three"` a blocked run
          // rather than a silently-kept previous number.
          if (draft !== undefined && !NUMBER_TEXT.test(draft.trim())) {
            problems.push({
              path: field.path,
              message: `${field.name} wants ${describeExpectedType("number")}, but “${draft.trim().slice(0, 40)}” is ${describeValue(draft)}.`,
            });
          } else if (typeof current !== "number" || !Number.isFinite(current)) {
            problems.push({ path: field.path, message: mismatch(field, "number", current) });
          }
          break;
        case "boolean":
          if (typeof current !== "boolean") problems.push({ path: field.path, message: mismatch(field, "boolean", current) });
          break;
        case "enum": {
          const allowed = (field.options ?? []).map((option) => option.value);
          if (!allowed.some((option) => option === current)) {
            problems.push({
              path: field.path,
              message: `${field.name} must be one of ${allowed.map((option) => JSON.stringify(option)).join(", ")}.`,
            });
          }
          break;
        }
        case "array": {
          if (!Array.isArray(current)) {
            problems.push({ path: field.path, message: mismatch(field, "array", current) });
            break;
          }
          const item = field.item;
          if (item === undefined) break;
          for (const [index, entry] of current.entries()) {
            const rowPath = `${field.path}.${String(index)}`;
            const rowDraft = drafts[rowPath];
            if (item.kind === "number") {
              if (rowDraft !== undefined && !NUMBER_TEXT.test(rowDraft.trim())) {
                problems.push({
                  path: rowPath,
                  message: `${field.name} item ${String(index + 1)} wants ${describeExpectedType("number")}, but “${rowDraft.trim().slice(0, 40)}” is ${describeValue(rowDraft)}.`,
                });
              } else if (typeof entry !== "number" || !Number.isFinite(entry)) {
                problems.push({ path: rowPath, message: `${field.name} item ${String(index + 1)} wants ${describeExpectedType("number")}, but this is ${describeValue(entry)}.` });
              }
            } else if (item.kind === "string" && typeof entry !== "string") {
              problems.push({ path: rowPath, message: `${field.name} item ${String(index + 1)} wants ${describeExpectedType("string")}, but this is ${describeValue(entry)}.` });
            } else if (item.kind === "boolean" && typeof entry !== "boolean") {
              problems.push({ path: rowPath, message: `${field.name} item ${String(index + 1)} wants ${describeExpectedType("boolean")}, but this is ${describeValue(entry)}.` });
            }
          }
          break;
        }
        case "object":
          if (typeof current !== "object" || Array.isArray(current)) {
            problems.push({ path: field.path, message: mismatch(field, "object", current) });
            break;
          }
          walk(field.fields ?? []);
          break;
        // `json` never reaches here: it is handled above the missing-value
        // guard, and the narrowing proves it.
      }
    }
  };

  walk(spec.fields);
  return problems;
}

function mismatch(field: FieldSpec, expected: string, found: unknown): string {
  return `${field.name} wants ${describeExpectedType(expected)}, but this is ${describeValue(found)}.`;
}

export function parseJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, message: message.replace(/^JSON\.parse: /, "").replace(/^Unexpected/, "unexpected") };
  }
}

/* -------------------------------------------------------------------------- */
/* what survives a reload                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `localStorage`, not the `sessionStorage` `persist.ts` uses.
 *
 * That file argues, correctly, that a scratch flow you never asked to save
 * should die with the tab. An input is the opposite: it is the one thing you
 * retype every single iteration, and the whole reason to keep it is that
 * tomorrow's run of the same example should not start from a blank form. Paths
 * survive the trip because they are stored as `{{workspace}}`, not as a temp
 * directory that no longer exists.
 */
const STORAGE_PREFIX = "codeflow.demo.trigger-input.v1.";

interface StoredInput {
  value: unknown;
  drafts: Record<string, string>;
}

function storageKey(exampleId: string, registryId: string): string {
  return `${STORAGE_PREFIX}${exampleId}::${registryId}`;
}

export function loadStoredInput(exampleId: string, registryId: string): StoredInput | null {
  try {
    const raw = localStorage.getItem(storageKey(exampleId, registryId));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as StoredInput;
    if (typeof parsed !== "object" || parsed === null) return null;
    return { value: parsed.value, drafts: typeof parsed.drafts === "object" && parsed.drafts !== null ? parsed.drafts : {} };
  } catch {
    return null;
  }
}

export function saveStoredInput(exampleId: string, registryId: string, stored: StoredInput): void {
  try {
    localStorage.setItem(storageKey(exampleId, registryId), JSON.stringify(stored));
  } catch {
    /* private mode or a full quota — the panel still works, it just forgets */
  }
}

export function clearStoredInput(exampleId: string, registryId: string): void {
  try {
    localStorage.removeItem(storageKey(exampleId, registryId));
  } catch {
    /* nothing to do and nothing worth breaking the app over */
  }
}

/* -------------------------------------------------------------------------- */
/* seeding the form                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The suggested value, with anything remembered laid over the top of it.
 *
 * Reconciled per field rather than taken wholesale: the flow's text is editable,
 * so a remembered input can name a property the type no longer has (dropped) or
 * miss one it now does (filled from the suggestion). Taking the stored object as
 * it stands would hand the run a payload whose shape nobody has checked.
 */
export function seedValue(spec: TriggerInputSpec, stored: unknown): Record<string, unknown> {
  if (spec.kind === "none") return {};
  const suggested = spec.suggested;
  if (spec.kind === "json") {
    return typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : suggested;
  }
  const out: Record<string, unknown> = {};
  const keep = typeof stored === "object" && stored !== null ? (stored as Record<string, unknown>) : {};
  for (const field of spec.fields) {
    const remembered = keep[field.name];
    out[field.name] = remembered === undefined || !fits(field, remembered) ? suggested[field.name] : remembered;
  }
  return out;
}

/** A cheap shape test — enough to reject a remembered value the type outgrew. */
function fits(field: FieldSpec, value: unknown): boolean {
  switch (field.kind) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return (field.options ?? []).some((option) => option.value === value);
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "json":
      return true;
  }
}

/** The text a control starts with, for the fields whose text can be wrong. */
export function seedDrafts(spec: TriggerInputSpec, value: Record<string, unknown>): Record<string, string> {
  const drafts: Record<string, string> = {};
  if (spec.kind === "json") {
    drafts[""] = JSON.stringify(value, null, 2);
    return drafts;
  }
  const walk = (fields: FieldSpec[]): void => {
    for (const field of fields) {
      const current = readPath(value, field.path);
      if (field.kind === "number") drafts[field.path] = current === undefined || current === null ? "" : String(current);
      else if (field.kind === "json") drafts[field.path] = JSON.stringify(current ?? null, null, 2);
      else if (field.kind === "array" && field.item?.kind === "number" && Array.isArray(current)) {
        for (const [index, entry] of current.entries()) drafts[`${field.path}.${String(index)}`] = String(entry);
      } else if (field.kind === "object") walk(field.fields ?? []);
    }
  };
  walk(spec.fields);
  return drafts;
}

/** Every leaf path in `spec`, so the panel can count what came from where. */
export function leafPaths(spec: TriggerInputSpec): string[] {
  const out: string[] = [];
  const walk = (fields: FieldSpec[]): void => {
    for (const field of fields) {
      if (field.kind === "object") walk(field.fields ?? []);
      else out.push(field.path);
    }
  };
  walk(spec.fields);
  return out;
}

/* -------------------------------------------------------------------------- */
/* the hook                                                                    */
/* -------------------------------------------------------------------------- */

export type TriggerInputStatus = "loading" | "ready" | "unavailable";

export interface TriggerInputController {
  status: TriggerInputStatus;
  spec: TriggerInputSpec | null;
  /** Why there is no form, when `status` is `unavailable`. Always a sentence. */
  unavailable: string | null;
  value: Record<string, unknown>;
  drafts: Record<string, string>;
  problems: InputProblem[];
  problemFor: (path: string) => string | null;
  /** `true` when nothing blocks a run. */
  valid: boolean;
  /** Whether a leaf still holds the machine's suggestion, or the user's value. */
  origin: (path: string) => "suggested" | "yours";
  /** How many leaves the user has changed — the panel's one-line summary. */
  changedCount: number;
  set: (path: string, value: unknown) => void;
  setDraft: (path: string, draft: string, value?: unknown) => void;
  reset: () => void;
  /** Exactly what `POST /api/run` is given, or `undefined` for "you decide". */
  payload: () => Record<string, unknown> | undefined;
}

export function useTriggerInput(options: {
  exampleId: string;
  registryId: string;
  source: string;
  /** No dev server, no shape — and the panel says so instead of guessing. */
  enabled: boolean;
}): TriggerInputController {
  const { exampleId, registryId, source, enabled } = options;

  const [spec, setSpec] = useState<TriggerInputSpec | null>(null);
  const [status, setStatus] = useState<TriggerInputStatus>("loading");
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [value, setValue] = useState<Record<string, unknown>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  // Which request is current. A flow edited three times while the first answer
  // is in flight must not end up showing the first flow's fields.
  const token = useRef(0);

  const load = useCallback(
    (fresh: boolean) => {
      const mine = ++token.current;
      if (!enabled) {
        setStatus("unavailable");
        setSpec(null);
        setUnavailable(
          "The demo runner is not available in this build, so the flow's input type cannot be read here and there is nothing to fill in. Run the app with `pnpm dev` to get the form.",
        );
        return;
      }
      setStatus("loading");
      void fetchTriggerInputSpec(source).then(
        (next) => {
          if (token.current !== mine) return;
          const stored = fresh ? null : loadStoredInput(exampleId, registryId);
          const seeded = seedValue(next, stored?.value);
          const seededDrafts = { ...seedDrafts(next, seeded), ...(fresh ? {} : (stored?.drafts ?? {})) };
          setSpec(next);
          setValue(seeded);
          setDrafts(seededDrafts);
          setUnavailable(null);
          setStatus("ready");
        },
        (cause: unknown) => {
          if (token.current !== mine) return;
          setSpec(null);
          setStatus("unavailable");
          setUnavailable(
            `The flow's input type could not be read — ${cause instanceof Error ? cause.message : String(cause)} The run will fall back to the values the server synthesizes, and you will see them in the run log.`,
          );
        },
      );
    },
    [enabled, source, exampleId, registryId],
  );

  useEffect(() => { load(false); }, [load]);

  // Remember only once there is something to remember: writing during the
  // first render would store the suggestion as if the user had chosen it.
  useEffect(() => {
    if (status !== "ready" || spec === null) return;
    saveStoredInput(exampleId, registryId, { value, drafts });
  }, [status, spec, value, drafts, exampleId, registryId]);

  const problems = useMemo(
    () => (spec === null ? [] : validateInput(spec, value, drafts)),
    [spec, value, drafts],
  );

  const set = useCallback((path: string, next: unknown) => {
    setValue((current) => writePath(current, path, next) as Record<string, unknown>);
  }, []);

  const setDraft = useCallback((path: string, draft: string, next?: unknown) => {
    setDrafts((current) => ({ ...current, [path]: draft }));
    if (next !== undefined) setValue((current) => writePath(current, path, next) as Record<string, unknown>);
  }, []);

  const reset = useCallback(() => {
    clearStoredInput(exampleId, registryId);
    load(true);
  }, [exampleId, registryId, load]);

  const origin = useCallback(
    (path: string): "suggested" | "yours" => {
      if (spec === null) return "yours";
      // A field that fails its own type is the user's by definition — the
      // suggestion always satisfies the type it was derived from. Without this,
      // typing `three` over a suggested `3` leaves `value` at 3 and the panel
      // would claim every value is still the demo's while `three` is on screen.
      if (problems.some((problem) => problem.path === path)) return "yours";
      return sameValue(readPath(value, path), readPath(spec.suggested, path)) ? "suggested" : "yours";
    },
    [spec, value, problems],
  );

  const changedCount = useMemo(() => {
    if (spec === null) return 0;
    if (spec.kind === "json") return sameValue(value, spec.suggested) ? 0 : 1;
    return leafPaths(spec).filter((path) => origin(path) === "yours").length;
  }, [spec, value, origin]);

  const problemFor = useCallback(
    (path: string) => problems.find((problem) => problem.path === path)?.message ?? null,
    [problems],
  );

  const payload = useCallback((): Record<string, unknown> | undefined => {
    if (spec === null) return undefined;
    if (spec.kind === "none") return {};
    if (spec.kind === "json") {
      const parsed = parseJson(drafts[""] ?? "");
      return parsed.ok && typeof parsed.value === "object" && parsed.value !== null
        ? (parsed.value as Record<string, unknown>)
        : undefined;
    }
    // A JSON field's authoritative form is its text: `value` only catches up
    // when the text parses, and a run must send what is on screen.
    let out: unknown = value;
    const walk = (fields: FieldSpec[]): void => {
      for (const field of fields) {
        if (field.kind === "object") { walk(field.fields ?? []); continue; }
        if (field.kind !== "json") continue;
        const draft = drafts[field.path];
        if (draft === undefined) continue;
        const parsed = parseJson(draft);
        if (parsed.ok) out = writePath(out, field.path, parsed.value);
      }
    };
    walk(spec.fields);
    return out as Record<string, unknown>;
  }, [spec, value, drafts]);

  return {
    status,
    spec,
    unavailable,
    value,
    drafts,
    problems,
    problemFor,
    valid: problems.length === 0,
    origin,
    changedCount,
    set,
    setDraft,
    reset,
    payload,
  };
}
