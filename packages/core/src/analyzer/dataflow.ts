/**
 * Data flow — 03-data-model.md §6.
 *
 * Tracked through identifier **bindings resolved by symbol**, not by name, so
 * shadowing in a nested scope resolves to the nearest declaration. A binding
 * used at N nodes yields N edges from the same port; a `let` reassigned in
 * several branches yields an edge from every writer.
 *
 * Acknowledged limitation (03 §6): edges express def-use, not mutation
 * ordering — `files.push(x)` inside a code node does not re-point existing
 * `files` edges; the code node still gets a reader edge so it is present in
 * the chain.
 */

import { Node, SyntaxKind } from "ts-morph";
import type { AnalysisContext, FlowBinding, Frame } from "./context.js";
import { addEdge } from "./builder.js";

const ASSIGNMENT_OPERATORS = new Set<SyntaxKind>([
  SyntaxKind.EqualsToken,
  SyntaxKind.PlusEqualsToken,
  SyntaxKind.MinusEqualsToken,
  SyntaxKind.AsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken,
  SyntaxKind.PercentEqualsToken,
  SyntaxKind.AmpersandAmpersandEqualsToken,
  SyntaxKind.BarBarEqualsToken,
  SyntaxKind.QuestionQuestionEqualsToken,
]);

/** True when this identifier is a *name* position rather than a value reference. */
function isNamePosition(identifier: Node): boolean {
  const parent = identifier.getParent();
  if (parent === undefined) return false;

  // `pr.title` — `title` is a member name, not a binding reference.
  if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === identifier) return true;
  // `{ channel: value }` — `channel` is a key. (`{ pr }` shorthand IS a read.)
  if (Node.isPropertyAssignment(parent) && parent.getNameNode() === identifier) return true;
  // Declaration names.
  if (Node.isVariableDeclaration(parent) && parent.getNameNode() === identifier) return true;
  if (Node.isBindingElement(parent) && parent.getNameNode() === identifier) return true;
  if (Node.isParameterDeclaration(parent) && parent.getNameNode() === identifier) return true;
  if (Node.isFunctionDeclaration(parent) && parent.getNameNode() === identifier) return true;
  // `{ data: renamed }` inside a binding pattern — `data` is the property name.
  if (Node.isBindingElement(parent) && parent.getPropertyNameNode() === identifier) return true;
  // Labels (`continue outer`) are not bindings.
  if (Node.isLabeledStatement(parent)) return true;
  if (parent.getKind() === SyntaxKind.BreakStatement) return true;
  if (parent.getKind() === SyntaxKind.ContinueStatement) return true;
  return false;
}

/** The left-hand side of a plain `=` is a write, not a read. */
function isPlainAssignmentTarget(identifier: Node): boolean {
  const parent = identifier.getParent();
  return (
    parent !== undefined &&
    Node.isBinaryExpression(parent) &&
    parent.getOperatorToken().getKind() === SyntaxKind.EqualsToken &&
    parent.getLeft() === identifier
  );
}

/**
 * Label of a data edge: the property path when the read is the root of a
 * property access (`input.repository`, `pr.title`), otherwise the binding name.
 */
function edgeLabel(identifier: Node, binding: FlowBinding): string {
  const parent = identifier.getParent();
  if (
    parent !== undefined &&
    Node.isPropertyAccessExpression(parent) &&
    parent.getExpression() === identifier
  ) {
    // `files.some(…)` reads `files`, not a `files.some` value — a method call
    // must not turn into a property label.
    const grandParent = parent.getParent();
    const isCallee =
      grandParent !== undefined &&
      Node.isCallExpression(grandParent) &&
      grandParent.getExpression() === parent;
    if (!isCallee) return `${binding.name}.${parent.getName()}`;
  }
  return binding.name;
}

function collectIdentifiers(root: Node, out: Node[]): void {
  if (Node.isIdentifier(root)) out.push(root);
  root.forEachChild((child) => collectIdentifiers(child, out));
}

/**
 * Create data edges from every binding read inside `regions` into `targetId`.
 * `declared` names are the bindings the statement itself introduces — reading
 * your own declaration is not an inbound edge.
 */
export function recordReads(
  ctx: AnalysisContext,
  frame: Frame,
  targetId: string,
  regions: readonly Node[],
  declared: ReadonlySet<string> = new Set(),
): void {
  const identifiers: Node[] = [];
  for (const region of regions) collectIdentifiers(region, identifiers);

  for (const identifier of identifiers) {
    if (isNamePosition(identifier)) continue;
    if (isPlainAssignmentTarget(identifier)) continue;
    const name = identifier.getText();
    if (declared.has(name)) continue;
    const binding = frame.scope.lookup(name);
    if (binding === null) continue;
    if (binding.kind === "tools") continue;
    if (binding.writers.length === 0) continue;
    const label = edgeLabel(identifier, binding);
    for (const writer of binding.writers) {
      addEdge(ctx, {
        source: writer.nodeId,
        target: targetId,
        kind: "data",
        sourcePort: writer.port,
        label,
      });
    }
  }
}

/**
 * Register `nodeId` as a writer of every binding assigned inside `regions`
 * (`x = …`, `x += …`, `x++`) — the union-of-writers rule of 03 §6.
 */
export function recordWrites(
  ctx: AnalysisContext,
  frame: Frame,
  nodeId: string,
  regions: readonly Node[],
): void {
  const visit = (node: Node): void => {
    let target: Node | undefined;
    if (Node.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.getOperatorToken().getKind())) {
      target = node.getLeft();
    } else if (Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node)) {
      const operator = node.getOperatorToken();
      if (operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken) {
        target = node.getOperand();
      }
    }
    if (target !== undefined && Node.isIdentifier(target)) {
      const binding = frame.scope.lookup(target.getText());
      if (binding !== null && binding.kind === "value") {
        const port = binding.name;
        if (!binding.writers.some((w) => w.nodeId === nodeId && w.port === port)) {
          binding.writers.push({ nodeId, port });
        }
      }
    }
    node.forEachChild(visit);
  };
  for (const region of regions) visit(region);
  void ctx;
}

/** Names read (as values) anywhere inside `root`. Used by the while bound check. */
export function readIdentifierNames(root: Node): Set<string> {
  const identifiers: Node[] = [];
  collectIdentifiers(root, identifiers);
  const names = new Set<string>();
  for (const identifier of identifiers) {
    if (isNamePosition(identifier)) continue;
    names.add(identifier.getText());
  }
  return names;
}

/** Names assigned or updated anywhere inside `root` (`x = …`, `x += …`, `x++`). */
export function assignedIdentifierNames(root: Node): Set<string> {
  const names = new Set<string>();
  const visit = (node: Node): void => {
    let target: Node | undefined;
    if (Node.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.getOperatorToken().getKind())) {
      target = node.getLeft();
    } else if (Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node)) {
      const operator = node.getOperatorToken();
      if (operator === SyntaxKind.PlusPlusToken || operator === SyntaxKind.MinusMinusToken) {
        target = node.getOperand();
      }
    }
    if (target !== undefined && Node.isIdentifier(target)) names.add(target.getText());
    node.forEachChild(visit);
  };
  visit(root);
  return names;
}

/** Names bound by a declaration name node (identifier or destructuring pattern). */
export function bindingNames(nameNode: Node): { name: string; property?: string }[] {
  if (Node.isIdentifier(nameNode)) return [{ name: nameNode.getText() }];
  const names: { name: string; property?: string }[] = [];
  if (Node.isObjectBindingPattern(nameNode)) {
    for (const element of nameNode.getElements()) {
      const propertyName = element.getPropertyNameNode()?.getText();
      const local = element.getNameNode().getText();
      names.push(propertyName === undefined ? { name: local } : { name: local, property: propertyName });
    }
    return names;
  }
  if (Node.isArrayBindingPattern(nameNode)) {
    for (const element of nameNode.getElements()) {
      if (Node.isBindingElement(element)) names.push({ name: element.getNameNode().getText() });
    }
    return names;
  }
  return names;
}
