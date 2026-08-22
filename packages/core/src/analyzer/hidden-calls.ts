/**
 * The hidden-call rule — 04-analyzer.md §1.4.
 *
 * "Never swallow a side-effect call." An `await` or a tool call that sits
 * *inside an expression* rather than standing as its own statement makes the
 * whole statement degrade to a `code` node plus a `hidden-call-in-expression`
 * diagnostic. The graph is then honest about not understanding the statement
 * instead of showing a pretty `condition`/`parallel` node that hides a call.
 *
 * Scope decision (recorded in the phase report): the rule fires on `await` and
 * on `tools`-rooted calls only. A *function* call (library or local) nested in
 * an expression does not degrade the statement, because §2.2b explicitly keeps
 * a negated or combined condition containing one as a `condition` node with a
 * raw expression, and §2.6 explicitly blesses a bare function call as a
 * `Promise.all` element. The one exception the spec names — a function
 * *reference* used as a callback — is covered for free: a reference is not a
 * call expression.
 */

import { Node } from "ts-morph";
import type { Frame } from "./context.js";
import { resolveToolsChain } from "./resolve.js";

/**
 * The call positions a statement is allowed to own: the top-level
 * `[const x =] [await] call(...)` shape. Anything else that awaits or calls a
 * tool is hidden.
 */
export function sanctionedTopLevel(statement: Node): Set<Node> {
  const sanctioned = new Set<Node>();
  let expression: Node | undefined;

  if (Node.isExpressionStatement(statement)) {
    expression = statement.getExpression();
  } else if (Node.isVariableStatement(statement)) {
    const declarations = statement.getDeclarationList().getDeclarations();
    if (declarations.length === 1) expression = declarations[0].getInitializer();
  }
  if (expression === undefined) return sanctioned;

  while (Node.isParenthesizedExpression(expression)) {
    expression = expression.getExpression();
  }
  if (Node.isAwaitExpression(expression)) {
    sanctioned.add(expression);
    expression = expression.getExpression();
    while (Node.isParenthesizedExpression(expression)) {
      expression = expression.getExpression();
    }
  }
  if (Node.isCallExpression(expression)) {
    sanctioned.add(expression);
  }
  return sanctioned;
}

/** Nodes to look for: awaits, and `tools`-rooted calls that are not optional-chained. */
function isCallOfInterest(node: Node, frame: Frame): boolean {
  if (Node.isAwaitExpression(node)) return true;
  if (!Node.isCallExpression(node)) return false;
  const chain = resolveToolsChain(node.getExpression(), frame);
  if (chain === null) return false;
  // Optional chaining on `tools` is its own unsupported construct (01 §2) and
  // carries its own diagnostic — not reported twice as a hidden call.
  return !chain.optional && node.getQuestionDotTokenNode() === undefined;
}

/**
 * Every await / tool call inside `root` that is not one of the statement's own
 * sanctioned positions.
 */
export function findHiddenCalls(root: Node, sanctioned: Set<Node>, frame: Frame): Node[] {
  const hidden: Node[] = [];
  const reported = new Set<Node>();

  // `await tools.x.y()` is one hidden call, not two: the await already names it.
  const coveredByAwait = (node: Node): boolean => {
    let parent = node.getParent();
    while (parent !== undefined && Node.isParenthesizedExpression(parent)) {
      parent = parent.getParent();
    }
    return parent !== undefined && reported.has(parent) && Node.isAwaitExpression(parent);
  };

  const consider = (node: Node): void => {
    if (sanctioned.has(node)) return;
    if (!isCallOfInterest(node, frame)) return;
    if (Node.isCallExpression(node) && coveredByAwait(node)) return;
    reported.add(node);
    hidden.push(node);
  };

  const visit = (node: Node): void => {
    consider(node);
    node.forEachChild(visit);
  };
  visit(root);
  return hidden;
}

/** True when the statement contains an optional-chained call on `tools` (01 §2). */
export function findOptionalToolChains(root: Node, frame: Frame): Node[] {
  const found: Node[] = [];
  const visit = (node: Node): void => {
    if (Node.isCallExpression(node)) {
      const chain = resolveToolsChain(node.getExpression(), frame);
      if (chain !== null && (chain.optional || node.getQuestionDotTokenNode() !== undefined)) {
        found.push(node);
      }
    }
    node.forEachChild(visit);
  };
  visit(root);
  return found;
}
