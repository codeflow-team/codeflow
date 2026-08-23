/**
 * Node → AST resolution — step 3 of the patch pipeline (06 §4).
 *
 * A graph node carries the source range it owns (03 §4). Locating the AST node
 * again is therefore an exact-range lookup, not a search: no fuzzy matching, no
 * re-derivation of what the analyzer decided. When the range no longer lines up
 * with a node boundary the patch is refused rather than approximated — the
 * whole point of conflict detection (06 §5).
 */

import { Node } from "ts-morph";
import type { Expression, ObjectLiteralExpression, SourceFile, Statement } from "ts-morph";
import { CodeFlowError } from "../errors.js";
import type { WorkflowNode } from "../model/index.js";
import { staticPropertyName } from "../util/property-names.js";

/** Every AST node whose range is exactly [start, end), outermost first. */
export function nodesAtRange(sourceFile: SourceFile, start: number, end: number): Node[] {
  const found: Node[] = [];
  const visit = (node: Node): void => {
    const nodeStart = node.getStart();
    const nodeEnd = node.getEnd();
    if (nodeEnd < start || nodeStart > end) return;
    if (nodeStart === start && nodeEnd === end) found.push(node);
    node.forEachChild(visit);
  };
  visit(sourceFile);
  return found;
}

/** The outermost AST node covering exactly the graph node's range. */
export function astNodeFor(sourceFile: SourceFile, node: WorkflowNode): Node {
  const matches = nodesAtRange(sourceFile, node.source.start.offset, node.source.end.offset);
  if (matches.length === 0) {
    throw new CodeFlowError(
      "patch-conflict",
      `Node "${node.label}" no longer lines up with a syntax node at ${String(node.source.start.offset)}..${String(node.source.end.offset)} — reload the workflow before editing (06 §5).`,
    );
  }
  return matches[0];
}

/** The statement a graph node owns (its range starts at a statement boundary). */
export function statementFor(sourceFile: SourceFile, node: WorkflowNode): Statement {
  const start = node.source.start.offset;
  const end = node.source.end.offset;
  let best: Statement | null = null;
  const visit = (current: Node): void => {
    if (current.getEnd() < start || current.getStart() > end) return;
    if (Node.isStatement(current) && current.getStart() === start && current.getEnd() <= end) {
      if (best === null || current.getEnd() > best.getEnd()) best = current;
    }
    current.forEachChild(visit);
  };
  visit(sourceFile);
  if (best === null) {
    throw new CodeFlowError(
      "patch-conflict",
      `Node "${node.label}" no longer starts at a statement boundary — reload the workflow before editing (06 §5).`,
    );
  }
  return best;
}

function unwrap(expression: Node | undefined): Node | undefined {
  let current = expression;
  while (current !== undefined && Node.isParenthesizedExpression(current)) {
    current = current.getExpression();
  }
  return current;
}

/**
 * The call expression a `tool`/`function`/`unknown` node stands for.
 *
 * Mirrors the analyzer's own unwrapping (`await`, parentheses, a single `const`
 * declarator) so the patcher edits exactly the call the node was built from —
 * and never a different call that happens to sit in the same statement.
 */
export function callExpressionFor(sourceFile: SourceFile, node: WorkflowNode): Node {
  const owner = astNodeFor(sourceFile, node);
  if (Node.isCallExpression(owner)) return owner;

  let expression: Node | undefined;
  if (Node.isExpressionStatement(owner)) expression = unwrap(owner.getExpression());
  else if (Node.isVariableStatement(owner)) {
    const declarations = owner.getDeclarationList().getDeclarations();
    if (declarations.length === 1) expression = unwrap(declarations[0].getInitializer());
  }
  if (expression !== undefined && Node.isAwaitExpression(expression)) {
    expression = unwrap(expression.getExpression());
  }
  if (expression !== undefined && Node.isCallExpression(expression)) return expression;

  throw new CodeFlowError(
    "patch-conflict",
    `Node "${node.label}" no longer resolves to a call expression — reload the workflow before editing (06 §5).`,
  );
}

/**
 * The argument object literal of a call, when the node is editable at all.
 *
 * 06 §1: an argument that is a variable (`send(payload)`) shows on the canvas
 * but its fields are not editable — the patcher never guesses what the variable
 * holds.
 */
export function argumentObjectFor(call: Node, label: string): ObjectLiteralExpression {
  if (!Node.isCallExpression(call)) {
    throw new CodeFlowError("patch-not-editable", `Node "${label}" is not a call.`);
  }
  const args = call.getArguments();
  if (args.length !== 1) {
    throw new CodeFlowError(
      "patch-not-editable",
      `Node "${label}" does not take a single object-literal argument, so its fields are not editable — edit it in the code view (06 §1).`,
    );
  }
  const only = unwrap(args[0]);
  if (only === undefined || !Node.isObjectLiteralExpression(only)) {
    throw new CodeFlowError(
      "patch-not-editable",
      `The argument of "${label}" is not a visible object literal, so its fields are not editable — edit it in the code view (06 §1).`,
    );
  }
  return only;
}

export interface PropertyLocation {
  /** The property node itself. */
  property: Node;
  /** Its value, or `undefined` for a shorthand property. */
  value: Expression | undefined;
  /** Index among the object's properties. */
  index: number;
  shorthand: boolean;
}

/**
 * Find a named property of an object literal, plus where it sits (06 §1 spread
 * rules).
 *
 * Matching is on the key JavaScript binds, not on how it is spelled: `channel`,
 * `"channel"` and `["channel"]` are the same property. Matching on the source
 * text instead would miss the quoted form and make the caller *append* a second
 * `channel` — leaving the value the user is looking at in place while quietly
 * overriding it (I6).
 */
export function findProperty(object: ObjectLiteralExpression, name: string): PropertyLocation | null {
  const properties = object.getProperties();
  for (let index = 0; index < properties.length; index++) {
    const property = properties[index];
    if (staticPropertyName(property) !== name) continue;
    if (Node.isPropertyAssignment(property)) {
      return { property, value: property.getInitializer(), index, shorthand: false };
    }
    if (Node.isShorthandPropertyAssignment(property)) {
      return { property, value: undefined, index, shorthand: true };
    }
  }
  return null;
}

/** True when the literal holds a key that cannot be named without running code. */
export function hasOpaqueKey(object: ObjectLiteralExpression): boolean {
  return object
    .getProperties()
    .some((property) => !Node.isSpreadAssignment(property) && staticPropertyName(property) === null);
}

/** Index of the last spread element, or -1 — 06 §1. */
export function lastSpreadIndex(object: ObjectLiteralExpression): number {
  const properties = object.getProperties();
  for (let index = properties.length - 1; index >= 0; index--) {
    if (Node.isSpreadAssignment(properties[index])) return index;
  }
  return -1;
}
