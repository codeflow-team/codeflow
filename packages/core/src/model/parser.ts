/**
 * Parser abstraction — 02-architecture.md §3.
 * MVP: TS Compiler API + ts-morph, `update` = full re-parse. The contract stays
 * the same if an incremental implementation (Tree-sitter) is swapped in later.
 */

import type { TextChange } from "./source.js";

declare const syntaxTreeBrand: unique symbol;

/** Opaque to everything above the parser layer. */
export interface SyntaxTree {
  readonly [syntaxTreeBrand]?: never;
}

export interface Parser {
  parse(source: string): SyntaxTree;
  update(previous: SyntaxTree, source: string, changes: TextChange[]): SyntaxTree;
}
