/**
 * Source-level types — 03-data-model.md §4, §11.
 *
 * `offset` is the canonical unit for every patch computation; line/column exist
 * for display only.
 */

export interface SourcePosition {
  /** 1-based */
  line: number;
  /** 1-based */
  column: number;
  /** 0-based */
  offset: number;
}

export interface SourceDocument {
  file: string;
  content: string;
  contentHash: string;
}

/** Every node maps back to a source range — 03 §4. */
export interface SourceMapping {
  file: string;
  start: SourcePosition;
  end: SourcePosition;
  /** Structural path from the flow root — 03 §5.1. */
  semanticPath: string;
  /** Normalized hash of the AST subtree (trivia/formatting stripped). */
  fingerprint: string;
}

/** Input of `Parser.update` — 02 §3. Offsets, not positions. */
export interface TextChange {
  /** offset */
  start: number;
  /** offset */
  end: number;
  newText: string;
}

/**
 * Output of the patch engine — one replaced source range.
 * Multiple patches returned by a `NodePatcher` MUST NOT overlap (03 §11).
 */
export interface TextPatch {
  range: { start: SourcePosition; end: SourcePosition };
  oldText: string;
  newText: string;
}
