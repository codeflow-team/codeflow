/**
 * Formatting style read from the source being patched — 06 §4.
 *
 * "Quote style, indentation and trailing comma of newly inserted text are read
 * from the current source itself (a file using single quotes gets single
 * quotes), never from default manipulation settings."
 *
 * Everything here is therefore *observation*, never configuration: the patch
 * engine has no formatting options to get out of sync with the file.
 */

import { Node, SyntaxKind } from "ts-morph";
import type { SourceFile } from "ts-morph";

export interface SourceStyle {
  /** Dominant string-literal delimiter. */
  quote: '"' | "'";
  /** One level of indentation, e.g. "  " or "\t". */
  indent: string;
  eol: "\n" | "\r\n";
  /** Do statements end with a semicolon? */
  semicolons: boolean;
  /** Do multi-line object/array literals keep a comma after the last element? */
  trailingComma: boolean;
}

function detectQuote(sourceFile: SourceFile): '"' | "'" {
  let double = 0;
  let single = 0;
  for (const literal of sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral)) {
    if (literal.getText().startsWith("'")) single += 1;
    else double += 1;
  }
  return single > double ? "'" : '"';
}

function detectIndent(source: string): string {
  const counts = new Map<string, number>();
  for (const line of source.split("\n")) {
    const match = /^([ \t]+)\S/.exec(line);
    if (match === null) continue;
    const lead = match[1];
    const unit = lead.startsWith("\t") ? "\t" : " ".repeat(lead.length);
    counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  if (counts.size === 0) return "  ";
  if (counts.has("\t")) return "\t";
  // The smallest observed indentation is the unit; deeper lines are multiples.
  let smallest = Number.POSITIVE_INFINITY;
  for (const key of counts.keys()) smallest = Math.min(smallest, key.length);
  return " ".repeat(Number.isFinite(smallest) ? smallest : 2);
}

function detectSemicolons(sourceFile: SourceFile): boolean {
  let with_ = 0;
  let without = 0;
  for (const statement of sourceFile.getDescendantStatements()) {
    if (!Node.isStatement(statement)) continue;
    if (
      !Node.isExpressionStatement(statement) &&
      !Node.isVariableStatement(statement) &&
      !Node.isReturnStatement(statement)
    ) {
      continue;
    }
    if (statement.getText().trimEnd().endsWith(";")) with_ += 1;
    else without += 1;
  }
  return with_ >= without;
}

/** Does this multi-line literal keep a comma after its last element? */
export function hasTrailingComma(node: Node): boolean | null {
  const children = node.getChildren();
  const list = children.find(
    (child) =>
      child.getKind() === SyntaxKind.SyntaxList &&
      child.getChildren().length > 0,
  );
  if (list === undefined) return null;
  const last = list.getChildren()[list.getChildren().length - 1];
  return last.getKind() === SyntaxKind.CommaToken;
}

function detectTrailingComma(sourceFile: SourceFile): boolean {
  let with_ = 0;
  let without = 0;
  const visit = (node: Node): void => {
    if (
      Node.isObjectLiteralExpression(node) ||
      Node.isArrayLiteralExpression(node)
    ) {
      if (node.getText().includes("\n")) {
        const trailing = hasTrailingComma(node);
        if (trailing === true) with_ += 1;
        else if (trailing === false) without += 1;
      }
    }
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return with_ > without;
}

export function detectStyle(sourceFile: SourceFile, source: string): SourceStyle {
  return {
    quote: detectQuote(sourceFile),
    indent: detectIndent(source),
    eol: source.includes("\r\n") ? "\r\n" : "\n",
    semicolons: detectSemicolons(sourceFile),
    trailingComma: detectTrailingComma(sourceFile),
  };
}

/* -------------------------------------------------------------------------- */
/* line helpers                                                                */
/* -------------------------------------------------------------------------- */

/** Offset of the first character of the line containing `offset`. */
export function lineStartOf(source: string, offset: number): number {
  const index = source.lastIndexOf("\n", Math.max(offset - 1, 0));
  return index === -1 ? 0 : index + 1;
}

/** Offset just past the line terminator of the line containing `offset`. */
export function lineEndOf(source: string, offset: number): number {
  const index = source.indexOf("\n", offset);
  return index === -1 ? source.length : index + 1;
}

/** The whitespace prefix of the line containing `offset`. */
export function indentAt(source: string, offset: number): string {
  const start = lineStartOf(source, offset);
  const match = /^[ \t]*/.exec(source.slice(start, offset));
  return match === null ? "" : match[0];
}

/** True when nothing but whitespace precedes `offset` on its line. */
export function startsLine(source: string, offset: number): boolean {
  return source.slice(lineStartOf(source, offset), offset).trim().length === 0;
}
