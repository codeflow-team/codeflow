/**
 * "Result" — what a node actually produced, and how sure we are of it.
 *
 * Two facts from 09 §1 drive everything here, and both are about *not* saying
 * more than the run said:
 *
 * - **An item number is only ever the runtime's.** `RunEvent.iteration` is
 *   absent when a runtime cannot count passes, and core deliberately produces no
 *   `iterations` array in that case. The label for that state is "latest" — an
 *   invented "item 1" would be exactly the forbidden move (07 §5).
 * - **A trace may not describe this graph any more.** `traceMatches` answers
 *   `current` / `stale` / `unknown`, and only `current` may be shown plainly.
 *   `unknown` is uncertainty, not a synonym for current.
 *
 * Pure, so both statements are testable without a DOM.
 */

import type { NodeRunState, RegistryLookup, Schema, TraceMatch, WorkflowNode } from "@codeflow/core";
import { stringData } from "../graph/index.js";
import { describeSchema } from "./scope-rows.js";

/**
 * One entry in the item selector.
 *
 * `iteration` is `null` for the "latest" entry — the state where the runtime
 * reported values but no loop indices. Nothing downstream may turn that `null`
 * into a number.
 */
export interface ResultItem {
  key: string;
  /** "Item 3", "Item 3 · 1" for a nested loop, or "latest". */
  label: string;
  iteration: number[] | null;
  status?: NodeRunState["status"];
  durationMs?: number;
  hasValue: boolean;
  value?: unknown;
}

/**
 * The passes through a node a UI may offer, newest information first.
 *
 * With `iterations` present there is one entry per observed pass, addressable
 * by its loop index. Without it there is exactly one entry, labelled "latest",
 * because "the most recent completed run" is all `preview` ever claimed to be.
 */
export function resultItems(state: NodeRunState | null | undefined): ResultItem[] {
  if (state === null || state === undefined) return [];

  const iterations = state.iterations;
  if (iterations !== undefined && iterations.length > 0) {
    return iterations.map((entry) => ({
      key: entry.iteration.join("."),
      label: iterationLabel(entry.iteration),
      iteration: [...entry.iteration],
      status: entry.status,
      ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
      hasValue: entry.preview !== undefined,
      ...(entry.preview === undefined ? {} : { value: entry.preview }),
    }));
  }

  return [
    {
      key: "latest",
      label: LATEST_LABEL,
      iteration: null,
      status: state.status,
      ...(state.durationMs === undefined ? {} : { durationMs: state.durationMs }),
      hasValue: state.preview !== undefined,
      ...(state.preview === undefined ? {} : { value: state.preview }),
    },
  ];
}

/**
 * The word for "the most recent value, and nothing about which pass produced
 * it". Exported so the component cannot spell it differently.
 */
export const LATEST_LABEL = "latest";

/**
 * `[2]` → "Item 3"; `[2, 0]` → "Item 3 · 1".
 *
 * One-based on screen because the reader is counting items, not indices; the
 * `iteration` array itself keeps the runtime's own zero-based numbers.
 */
export function iterationLabel(iteration: readonly number[]): string {
  if (iteration.length === 0) return LATEST_LABEL;
  return `Item ${iteration.map((index) => String(index + 1)).join(" · ")}`;
}

/* -------------------------------------------------------------------------- */
/* how much of this run still describes this flow                              */
/* -------------------------------------------------------------------------- */

export interface TraceNotice {
  /** True only for `current`. Everything else has to render as uncertainty. */
  current: boolean;
  tone: "ok" | "warn" | "muted";
  title: string;
  text: string;
}

/**
 * Caption for a trace's relationship to the graph on screen.
 *
 * `stale` is the dangerous one: node ids survive patches by design (I5), so a
 * value from an earlier version re-attaches to the very node whose code just
 * changed. It has to say so. `unknown` is not "probably fine" — nothing
 * established that the trace belongs to this flow, so it says that instead.
 */
export function traceNotice(match: TraceMatch): TraceNotice {
  switch (match) {
    case "current":
      return {
        current: true,
        tone: "ok",
        title: "From the last run of this flow",
        text: "The code has not changed since this run, so these are the values this flow produces now.",
      };
    case "stale":
      return {
        current: false,
        tone: "warn",
        title: "From an earlier version of this flow",
        text: "The code changed after this run. These values are what the *previous* version produced — they are not what this flow does now.",
      };
    case "unknown":
      return {
        current: false,
        tone: "muted",
        title: "This run may be out of date",
        text: "The run did not say which version of the flow it belongs to, so nothing here establishes that these values are current.",
      };
  }
}

/* -------------------------------------------------------------------------- */
/* values                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Unwrap the `{ tool, source, value }` envelope a host runtime may put around a
 * preview, without assuming one is there.
 *
 * The demo's runner wraps its previews so a card can say whether a value came
 * from a live MCP server or from a stub; a different runtime sends the value
 * itself. Reading `value` when — and only when — the key is present handles
 * both without inventing a convention core does not have.
 */
export function unwrapPreview(preview: unknown): unknown {
  if (typeof preview === "object" && preview !== null && !Array.isArray(preview) && "value" in preview) {
    return (preview as { value: unknown }).value;
  }
  return preview;
}

/** Where a preview says its data came from, when the host said so at all. */
export function previewOrigin(preview: unknown): { tool?: string; source?: string } | null {
  if (typeof preview !== "object" || preview === null || Array.isArray(preview)) return null;
  const record = preview as Record<string, unknown>;
  const tool = typeof record["tool"] === "string" ? record["tool"] : undefined;
  const source = typeof record["source"] === "string" ? record["source"] : undefined;
  if (tool === undefined && source === undefined) return null;
  return { ...(tool === undefined ? {} : { tool }), ...(source === undefined ? {} : { source }) };
}

/**
 * The value a run observed for one node, at one iteration — or `undefined` when
 * the run says nothing about it.
 *
 * Wrapped in an object so an observed `null` (a real answer) stays
 * distinguishable from "nothing observed" (no answer). `iteration` is matched
 * exactly; when the requested pass has no entry, the most recent pass that
 * carries a value is used, because that is what `preview` has always meant.
 */
export function observedAt(
  state: NodeRunState | null | undefined,
  iteration: readonly number[] | null,
): { value: unknown } | undefined {
  if (state === null || state === undefined) return undefined;

  const iterations = state.iterations;
  if (iterations !== undefined && iterations.length > 0) {
    const wanted =
      iteration === null
        ? undefined
        : iterations.find((entry) => sameIteration(entry.iteration, iteration));
    const chosen =
      wanted ?? [...iterations].reverse().find((entry) => entry.preview !== undefined);
    if (chosen !== undefined && chosen.preview !== undefined) {
      return { value: unwrapPreview(chosen.preview) };
    }
  }

  if (state.preview === undefined) return undefined;
  return { value: unwrapPreview(state.preview) };
}

function sameIteration(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/* -------------------------------------------------------------------------- */
/* what a node says it produces, when nothing has run                          */
/* -------------------------------------------------------------------------- */

export interface DeclaredOutput {
  /** The binding name the value lands in, when the flow gives it one. */
  name: string | null;
  /** The declared type in words, or null when nothing declares one. */
  typeText: string | null;
  schema?: Schema;
}

/**
 * The declared output shape of a node — the honest answer before a run.
 *
 * Ports first (the analyzer put the binding names there), then the registry's
 * `outputSchema`. Returns nulls rather than guesses: a step whose output type
 * nobody declared has an unknown output, and saying so is the whole point.
 */
export function declaredOutput(
  node: WorkflowNode,
  registry: RegistryLookup | null | undefined,
): DeclaredOutput {
  const port = node.outputs[0];
  const fromRegistry = registrySchema(node, registry);
  const schema = port?.schema ?? fromRegistry;
  return {
    name: port?.label ?? null,
    typeText: describeSchema(schema) ?? null,
    ...(schema === undefined ? {} : { schema }),
  };
}

function registrySchema(node: WorkflowNode, registry: RegistryLookup | null | undefined): Schema | undefined {
  if (registry === null || registry === undefined) return undefined;
  if (node.type === "tool" || node.type === "unknown") {
    const name = stringData(node, "toolName");
    return name === null ? undefined : registry.getTool(name)?.outputSchema;
  }
  if (node.type === "function") {
    const name = stringData(node, "functionName");
    return name === null ? undefined : registry.getFunction(name)?.outputSchema;
  }
  return registry.getNode(String(node.type))?.outputSchema;
}
