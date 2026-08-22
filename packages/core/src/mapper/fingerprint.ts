/**
 * Fingerprint — 03-data-model.md §4: "normalized hash of the AST subtree
 * (trivia/formatting stripped)".
 *
 * Normalization walks the tree with `forEachChild`, which yields semantic
 * children only — punctuation, whitespace and comments never appear. Leaves
 * (identifiers, literals) contribute their text; interior nodes contribute only
 * their kind plus their children, so reformatting cannot change the result.
 *
 * A few node kinds carry meaning in a token that `forEachChild` does not visit
 * (`!x` vs `-x`, `const` vs `let`); those are discriminated explicitly.
 */

import { Node } from "ts-morph";
import { sha256Hex } from "../util/sha256.js";

const FORMAT = "codeflow.fingerprint.v1";

function discriminator(node: Node): string {
  if (Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node)) {
    return `#${String(node.getOperatorToken())}`;
  }
  if (Node.isVariableDeclarationList(node)) {
    return `#${node.getDeclarationKind()}`;
  }
  return "";
}

/** Canonical, trivia-free serialization of an AST subtree. */
export function normalizeAst(node: Node): string {
  const kind = node.getKindName();
  const children: string[] = [];
  node.forEachChild((child) => {
    children.push(normalizeAst(child));
  });
  if (children.length === 0) {
    return `${kind}${discriminator(node)}=${JSON.stringify(node.getText())}`;
  }
  return `${kind}${discriminator(node)}(${children.join(",")})`;
}

/** Fingerprint of a single AST subtree. */
export function fingerprintNode(node: Node): string {
  return sha256Hex(`${FORMAT}|${normalizeAst(node)}`);
}

/** Fingerprint of a run of sibling nodes (used by merged `code` nodes, 04 §2.11). */
export function fingerprintNodes(nodes: readonly Node[]): string {
  return sha256Hex(`${FORMAT}|${nodes.map(normalizeAst).join("|")}`);
}

/** Fingerprint of a synthetic node that has no AST subtree of its own (03 §4). */
export function fingerprintSynthetic(owner: Node, role: string): string {
  return sha256Hex(`${FORMAT}|synthetic:${role}|${normalizeAst(owner)}`);
}

/** Fingerprint keyed only on a string — used for the synthetic trailing output node. */
export function fingerprintText(text: string): string {
  return sha256Hex(`${FORMAT}|text|${text}`);
}
