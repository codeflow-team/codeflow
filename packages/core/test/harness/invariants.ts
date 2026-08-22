/**
 * Invariant checks used by the fixture harness — 11-testing.md §2.
 *
 * I1 (faithful projection): every statement in the flow body belongs to exactly
 * one node. Nodes nest (a statement inside a loop body is inside the loop
 * node's range too), so ownership is defined as the *innermost* non-synthetic
 * node whose range contains the statement. Synthetic nodes (trigger, merge,
 * implicit output) share a range with the construct that produced them (03 §4)
 * and never own it.
 */

import { Node } from "ts-morph";
import type { Statement } from "ts-morph";
import { TsMorphParser } from "../../src/parser/index.js";
import { checkFlowContract } from "../../src/analyzer/index.js";
import type { WorkflowGraph, WorkflowNode } from "../../src/model/index.js";

export interface OwnershipProblem {
  statement: string;
  offset: number;
  owners: string[];
}

function isSynthetic(node: WorkflowNode): boolean {
  if (node.type === "trigger" || node.type === "merge") return true;
  return node.type === "output" && node.data["explicit"] === false;
}

/** Every statement list reachable inside the flow body. */
function collectBlocks(root: Node): Statement[][] {
  const blocks: Statement[][] = [];
  const visit = (node: Node): void => {
    if (Node.isBlock(node) || Node.isCaseClause(node) || Node.isDefaultClause(node)) {
      blocks.push(node.getStatements());
    }
    if (Node.isIfStatement(node)) {
      const thenStatement = node.getThenStatement();
      if (!Node.isBlock(thenStatement)) blocks.push([thenStatement]);
      const elseStatement = node.getElseStatement();
      if (elseStatement !== undefined && !Node.isBlock(elseStatement)) blocks.push([elseStatement]);
    }
    if (
      Node.isForOfStatement(node) ||
      Node.isForStatement(node) ||
      Node.isForInStatement(node) ||
      Node.isWhileStatement(node) ||
      Node.isDoStatement(node)
    ) {
      const body = node.getStatement();
      if (!Node.isBlock(body)) blocks.push([body]);
    }
    node.forEachChild(visit);
  };
  visit(root);
  return blocks;
}

/**
 * Assert I1 over a graph: full coverage, exactly one owner per statement, and
 * no partial overlap between the owners of one block.
 */
export function checkStatementOwnership(
  source: string,
  graph: WorkflowGraph,
  file: string,
): OwnershipProblem[] {
  const problems: OwnershipProblem[] = [];
  const parser = new TsMorphParser({ file });
  const sourceFile = parser.parse(source, file).sourceFile;
  const flow = checkFlowContract(sourceFile, file).flow;
  if (flow === null) return problems;
  const body = flow.getBody();
  if (body === undefined) return problems;

  const owners = graph.nodes.filter((node) => !isSynthetic(node));

  const codeNodes = owners.filter((node) => node.type === "code");

  for (const block of collectBlocks(body)) {
    if (block.length === 0) continue;
    // A `code` node is an opaque region: it swallows whatever blocks are nested
    // inside the statements it covers (04 §2.11), so those inner blocks have no
    // owners of their own — and must not be required to.
    const blockStart = block[0].getStart();
    const blockEnd = block[block.length - 1].getEnd();
    const swallowed = codeNodes.some(
      (node) =>
        node.source.start.offset <= blockStart &&
        node.source.end.offset >= blockEnd &&
        (node.source.start.offset < blockStart || node.source.end.offset > blockEnd),
    );
    if (swallowed) continue;

    // A node may only own statements of THIS block, so its range has to line up
    // with statement boundaries here — an enclosing construct's node (which
    // starts at a statement of the *parent* block) can never be the owner.
    const starts = new Set(block.map((statement) => statement.getStart()));
    const ends = new Set(block.map((statement) => statement.getEnd()));

    const blockOwners: { node: WorkflowNode; start: number; end: number }[] = [];
    for (const statement of block) {
      const start = statement.getStart();
      const end = statement.getEnd();
      const containing = owners.filter(
        (node) =>
          node.source.start.offset <= start &&
          node.source.end.offset >= end &&
          starts.has(node.source.start.offset) &&
          ends.has(node.source.end.offset),
      );
      if (containing.length === 0) {
        problems.push({ statement: statement.getText().slice(0, 60), offset: start, owners: [] });
        continue;
      }
      let width = Number.POSITIVE_INFINITY;
      for (const node of containing) {
        width = Math.min(width, node.source.end.offset - node.source.start.offset);
      }
      const innermost = containing.filter(
        (node) => node.source.end.offset - node.source.start.offset === width,
      );
      if (innermost.length !== 1) {
        problems.push({
          statement: statement.getText().slice(0, 60),
          offset: start,
          owners: innermost.map((node) => `${node.type}:${node.source.semanticPath}`),
        });
        continue;
      }
      const owner = innermost[0];
      blockOwners.push({
        node: owner,
        start: owner.source.start.offset,
        end: owner.source.end.offset,
      });
    }

    // Owners of one block must not partially overlap: they are either the same
    // node (a merged code run) or strictly consecutive ranges.
    const unique = blockOwners.filter(
      (entry, index) => index === 0 || entry.node.id !== blockOwners[index - 1].node.id,
    );
    for (let index = 1; index < unique.length; index++) {
      const previous = unique[index - 1];
      const current = unique[index];
      if (current.start < previous.end) {
        problems.push({
          statement: `overlapping owners in block: ${previous.node.source.semanticPath} / ${current.node.source.semanticPath}`,
          offset: current.start,
          owners: [previous.node.source.semanticPath, current.node.source.semanticPath],
        });
      }
    }
  }

  return problems;
}
