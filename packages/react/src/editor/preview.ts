/**
 * The renderer seam — `NodeDefinition.renderer` and `previewRenderers`.
 *
 * Core has declared `NodeDefinition.renderer` since 05 §1 and, until now,
 * `grep -rn "renderer" packages/react/src` returned nothing: an extension point
 * that nobody read is not an extension point, it is a promise. This module and
 * `PreviewValue.tsx` close it, in two halves:
 *
 * - a **node renderer** (core's `NodeDefinition.renderer`) draws the body of a
 *   card for a host-registered node type;
 * - a **preview renderer** (`previewRenderers` on `<CodeFlowProvider>`) draws a
 *   *value* — an emit payload or an observed result — in the node editor.
 *
 * **There is deliberately no image renderer here, and adding one is not a
 * helpful contribution.** The product ships no tool that produces an image
 * today, so such a renderer could only ever be tested against a mock — and this
 * repo's own record is that real schemas find bugs mocks do not. The seam is
 * the deliverable; the first real renderer waits for a real producer. When one
 * exists, it is a host-side `previewRenderers` entry and needs no change here.
 *
 * Exactly one built-in ships: a readable JSON/text fallback, used when nothing
 * else matches — so a value is never rendered as nothing.
 */

import type { ReactNode } from "react";
import type { Schema } from "@codeflow/core";

/**
 * Everything a renderer is told about the value it is about to draw.
 *
 * `kind` is `RunEmit.kind` — an open string core never interprets (a host that
 * defines a kind is the only party that knows what it means) — and `null` when
 * the value is an observed result rather than an emit.
 */
export interface PreviewContext {
  value: unknown;
  kind: string | null;
  /** Declared schema for this value, when the graph or registry knows one. */
  schema?: Schema;
  /** Media type, when the host attached one to the emit. */
  mediaType?: string;
  nodeId: string;
}

export interface PreviewRenderer {
  /** Stable id — used as the React key and for debugging which one matched. */
  id: string;
  /** First match wins, in the order the host listed them. */
  match: (context: PreviewContext) => boolean;
  render: (context: PreviewContext) => ReactNode;
}

/**
 * The first renderer that claims this value, or `null` for "use the built-in".
 *
 * Order is the host's list order, not a score: a scoring rule would make which
 * renderer runs depend on a heuristic the host cannot see, and "put yours
 * first" is a contract anyone can hold in their head.
 *
 * A renderer whose `match` throws is skipped rather than allowed to take the
 * pane down — a broken host extension must not cost the user their result.
 */
export function pickPreviewRenderer(
  renderers: readonly PreviewRenderer[] | null | undefined,
  context: PreviewContext,
): PreviewRenderer | null {
  for (const renderer of renderers ?? []) {
    try {
      if (renderer.match(context)) return renderer;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * The built-in fallback's text: a string as itself, anything else as indented
 * JSON.
 *
 * Values that JSON cannot express (a cycle, a `BigInt`) fall back to `String()`
 * rather than throwing — the pane says what it can and never goes blank.
 */
export function previewText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Media type a host attached to an emit payload, when it used the usual keys. */
export function mediaTypeOf(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  for (const key of ["mediaType", "mimeType", "contentType"]) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
