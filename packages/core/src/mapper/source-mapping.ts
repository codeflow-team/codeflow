/**
 * Building `SourceMapping` values — 03-data-model.md §4.
 *
 * Every node maps back to a source range. Offsets are canonical; line/column
 * exist for display. Synthetic nodes (merge, trigger, implicit output) map to
 * the range of the construct that produced them and carry a role qualifier in
 * the semantic path — several nodes may share a range, but only one of them
 * owns it for editing.
 */

import type { Node, SourceFile } from "ts-morph";
import type { SourceMapping, SourcePosition } from "../model/index.js";
import { fingerprintNode, fingerprintNodes, fingerprintSynthetic, fingerprintText } from "./fingerprint.js";

export function positionAt(sourceFile: SourceFile, offset: number): SourcePosition {
  const { line, column } = sourceFile.getLineAndColumnAtPos(offset);
  return { line, column, offset };
}

export interface RangeInput {
  file: string;
  sourceFile: SourceFile;
  start: number;
  end: number;
  semanticPath: string;
  fingerprint: string;
}

export function mappingFromRange(input: RangeInput): SourceMapping {
  return {
    file: input.file,
    start: positionAt(input.sourceFile, input.start),
    end: positionAt(input.sourceFile, input.end),
    semanticPath: input.semanticPath,
    fingerprint: input.fingerprint,
  };
}

/** Mapping of a node that owns exactly one AST subtree. */
export function mappingForNode(
  file: string,
  sourceFile: SourceFile,
  node: Node,
  semanticPath: string,
): SourceMapping {
  return mappingFromRange({
    file,
    sourceFile,
    start: node.getStart(),
    end: node.getEnd(),
    semanticPath,
    fingerprint: fingerprintNode(node),
  });
}

/** Mapping of a merged `code` node covering a run of consecutive statements. */
export function mappingForStatements(
  file: string,
  sourceFile: SourceFile,
  statements: readonly Node[],
  semanticPath: string,
): SourceMapping {
  const first = statements[0];
  const last = statements[statements.length - 1];
  return mappingFromRange({
    file,
    sourceFile,
    start: first.getStart(),
    end: last.getEnd(),
    semanticPath,
    fingerprint: fingerprintNodes(statements),
  });
}

/**
 * Mapping of a synthetic node: it shares the range of the construct that
 * produced it (03 §4) but keeps its own fingerprint so it is never confused
 * with the owner node.
 */
export function mappingForSynthetic(
  file: string,
  sourceFile: SourceFile,
  owner: Node,
  semanticPath: string,
  role: string,
  range?: { start: number; end: number },
): SourceMapping {
  return mappingFromRange({
    file,
    sourceFile,
    start: range?.start ?? owner.getStart(),
    end: range?.end ?? owner.getEnd(),
    semanticPath,
    fingerprint: fingerprintSynthetic(owner, role),
  });
}

/** Mapping of a synthetic node with no owning subtree (implicit trailing output). */
export function mappingForPoint(
  file: string,
  sourceFile: SourceFile,
  start: number,
  end: number,
  semanticPath: string,
  role: string,
): SourceMapping {
  return mappingFromRange({
    file,
    sourceFile,
    start,
    end,
    semanticPath,
    fingerprint: fingerprintText(`${role}|${semanticPath}`),
  });
}
