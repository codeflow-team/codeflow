/**
 * Text edit primitives — the mechanical half of "minimal patch" (06 §4).
 *
 * A `TextEdit` is a replacement of one offset range of the *current* source.
 * Every operation of the patch engine reduces to a set of such edits, computed
 * from the range of the **smallest AST node affected** — never by reprinting a
 * parent node, which is what would drag the printer's quote style, indentation
 * and trailing commas across untouched code (06 §4, invariant I3).
 *
 * Edits inside one patch must not overlap (03 §11); `applyEdits` enforces that
 * rather than trusting callers.
 */

import { CodeFlowError } from "../errors.js";
import type { SourcePosition, TextPatch } from "../model/index.js";

export interface TextEdit {
  /** offset, 0-based */
  start: number;
  /** offset, 0-based, exclusive */
  end: number;
  newText: string;
}

/** Sorted by start; ties put the shorter (insertion) first for stable output. */
export function sortEdits(edits: readonly TextEdit[]): TextEdit[] {
  return [...edits].sort((a, b) => (a.start === b.start ? a.end - b.end : a.start - b.start));
}

export function assertNoOverlap(edits: readonly TextEdit[]): void {
  const sorted = sortEdits(edits);
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current.start < previous.end) {
      throw new CodeFlowError(
        "patch-invalid",
        `Overlapping edits at ${String(current.start)}: [${String(previous.start)},${String(previous.end)}) and [${String(current.start)},${String(current.end)}) — a patch may never rewrite the same range twice (03 §11).`,
      );
    }
  }
}

/** Drop edits that change nothing — an empty edit must not show up as a patch. */
export function meaningful(edits: readonly TextEdit[], source: string): TextEdit[] {
  return edits.filter((edit) => source.slice(edit.start, edit.end) !== edit.newText);
}

export function applyEdits(source: string, edits: readonly TextEdit[]): string {
  assertNoOverlap(edits);
  const sorted = sortEdits(edits);
  let out = "";
  let cursor = 0;
  for (const edit of sorted) {
    out += source.slice(cursor, edit.start);
    out += edit.newText;
    cursor = edit.end;
  }
  return out + source.slice(cursor);
}

/* -------------------------------------------------------------------------- */
/* offset mapping — old source → new source                                    */
/* -------------------------------------------------------------------------- */

/**
 * Map an offset of the pre-patch source onto the patched source.
 *
 * `side` decides what happens at the boundary of a pure insertion sitting
 * exactly on the offset: a range *starting* there moves behind the inserted
 * text, a range *ending* there does not swallow it. This is what makes patch
 * provenance (03 §5.2 step 0) exact for the "insert a statement before an
 * existing one" case, where the inserted text is byte-identical to its
 * neighbour and no heuristic could tell them apart.
 */
export function mapOffset(offset: number, edits: readonly TextEdit[], side: "start" | "end"): number {
  let delta = 0;
  for (const edit of sortEdits(edits)) {
    const width = edit.newText.length - (edit.end - edit.start);
    const insertionHere = edit.start === edit.end && edit.start === offset;
    if (edit.end < offset || (edit.end === offset && !(insertionHere && side === "end"))) {
      delta += width;
      continue;
    }
    if (edit.start >= offset) break;
    // The offset falls strictly inside a replaced range: clamp onto the edge of
    // the replacement corresponding to the side being mapped.
    return side === "start" ? edit.start + delta : edit.start + delta + edit.newText.length;
  }
  return offset + delta;
}

/* -------------------------------------------------------------------------- */
/* TextPatch conversion                                                        */
/* -------------------------------------------------------------------------- */

/** Line/column of an offset, computed on the pre-patch source (1-based). */
export function positionOf(source: string, offset: number): SourcePosition {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < offset && index < source.length; index++) {
    if (source.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: offset - lineStart + 1, offset };
}

/** `TextEdit[]` → the public `TextPatch[]` shape (03 §11), in source order. */
export function toPatches(source: string, edits: readonly TextEdit[]): TextPatch[] {
  return sortEdits(edits).map((edit) => ({
    range: { start: positionOf(source, edit.start), end: positionOf(source, edit.end) },
    oldText: source.slice(edit.start, edit.end),
    newText: edit.newText,
  }));
}
