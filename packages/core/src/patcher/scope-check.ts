/**
 * Scope check for a written expression — 06 §3 under invariant I6.
 *
 * A patch may write a TypeScript expression into a field (`{ kind:
 * "expression", text }`) or a template whose `${…}` interpolations are
 * expressions. That is also what a *drag* from the inspector's data pane
 * becomes: in CodeFlow the connection between two nodes IS a variable
 * reference, so dragging `pr.title` into a field is an ordinary field patch.
 *
 * Written verbatim and unchecked, a mis-drag puts a name that resolves to
 * nothing into the user's file. The result parses (so the candidate validator
 * of 06 §4 passes it), analyzes (the analyzer simply finds no binding, so no
 * data edge appears), and the browser demo has no type checker — nothing
 * anywhere says a word, and the flow fails at run time with `pr is not
 * defined`. Silently meaning something other than what the user pointed at is
 * exactly failure mode I6, so the reference is checked against the scope table
 * the analyzer already computed (03 §6, `WorkflowGraph.scopes`).
 *
 * What counts as a reference is deliberately narrow: the **root** of a value
 * reference. `pr.title` references `pr`; `title` is a property name, not a
 * binding. `{ a: 1 }` has no reference at all. A name bound *inside* the
 * expression — an arrow parameter, a destructured arrow parameter, a `const`
 * in an IIFE body — is local, and flagging it would refuse
 * `files.filter(f => f.name)`, which is correct code.
 */

import { ts } from "ts-morph";
import { CodeFlowError } from "../errors.js";

/**
 * Globals a flow may reference without any binding in the file.
 *
 * Deliberately small and hand-written. It is not "the JavaScript global
 * object": a flow runs in a sandbox chosen by the host (01 §1), so `fetch`,
 * `process`, `window` and friends are the host's business, not something core
 * may bless in advance. These are the language's own values — the ones an
 * expression editor genuinely needs to compute with — and nothing else. Adding
 * a name here says "any flow, on any runtime, may use this", so add sparingly.
 */
export const ALLOWED_GLOBALS: readonly string[] = [
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Date",
  "Promise",
  "Set",
  "Map",
  "RegExp",
  "NaN",
  "Infinity",
  "undefined",
  "null",
  "true",
  "false",
  "console",
];

const ALLOWED = new Set(ALLOWED_GLOBALS);

/** How a snippet's text becomes a parseable source file. */
export type SnippetKind = "expression" | "template";

function snippetSource(kind: SnippetKind, text: string): string {
  // Parenthesised so an object literal (`{ a: 1 }`) is an expression rather
  // than a block, and so a comma/`in` at top level cannot escape the snippet.
  return kind === "template" ? `(\`${text}\`)` : `(${text})`;
}

/* -------------------------------------------------------------------------- */
/* local bindings                                                              */
/* -------------------------------------------------------------------------- */

/** Names bound by a binding name node (identifier or destructuring pattern). */
function boundNames(name: ts.BindingName | undefined, out: Set<string>): void {
  if (name === undefined) return;
  if (ts.isIdentifier(name)) {
    out.add(name.text);
    return;
  }
  for (const element of name.elements) {
    if (ts.isOmittedExpression(element)) continue;
    boundNames(element.name, out);
  }
}

type FunctionLike =
  | ts.ArrowFunction
  | ts.FunctionExpression
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLike {
  return (
    ts.isArrowFunction(node) ||
    ts.isFunctionExpression(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** Names a function-like introduces: its parameters (destructuring included). */
function functionScope(node: FunctionLike): Set<string> {
  const names = new Set<string>();
  for (const parameter of node.parameters) boundNames(parameter.name, names);
  if ((ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) && node.name !== undefined) {
    names.add(node.name.text);
  }
  return names;
}

/** Names declared directly in a statement list (`const`, `let`, `var`, `function`). */
function blockScope(statements: readonly ts.Statement[]): Set<string> {
  const names = new Set<string>();
  for (const statement of statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        boundNames(declaration.name, names);
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) {
      names.add(statement.name.text);
    }
    if (ts.isClassDeclaration(statement) && statement.name !== undefined) {
      names.add(statement.name.text);
    }
  }
  return names;
}

/* -------------------------------------------------------------------------- */
/* reference positions                                                         */
/* -------------------------------------------------------------------------- */

/**
 * True when this identifier names something instead of reading a value — the
 * same distinction the analyzer's data flow makes (analyzer/dataflow.ts).
 * `{ pr }` shorthand is deliberately absent: it *is* a read of `pr`.
 */
function isNamePosition(node: ts.Identifier, parent: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true;
  if (ts.isBindingElement(parent) && (parent.propertyName === node || parent.name === node)) return true;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true;
  if (ts.isParameter(parent) && parent.name === node) return true;
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true;
  if (ts.isFunctionExpression(parent) && parent.name === node) return true;
  if (ts.isClassDeclaration(parent) && parent.name === node) return true;
  if (ts.isClassExpression(parent) && parent.name === node) return true;
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true;
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true;
  if (ts.isEnumMember(parent) && parent.name === node) return true;
  if (ts.isMetaProperty(parent)) return true;
  if (ts.isLabeledStatement(parent) && parent.label === node) return true;
  if (ts.isBreakOrContinueStatement(parent) && parent.label === node) return true;
  return false;
}

/**
 * Root identifiers of every value reference in `text`, in the order they are
 * written (duplicates collapsed to their first occurrence).
 *
 * A snippet that does not parse yields `[]`: the reference list would be
 * guesswork on a broken tree, and the candidate validation of 06 §4 refuses
 * the patch a moment later anyway, with a message about the syntax rather than
 * a made-up one about scope.
 */
export function rootReferences(text: string, kind: SnippetKind = "expression"): string[] {
  const file = ts.createSourceFile(
    "__codeflow_expression__.ts",
    snippetSource(kind, text),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );
  // `parseDiagnostics` is internal but stable, and the alternative (a full
  // Program) would cost a compiler host for a one-line snippet.
  const errors = (file as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics;
  if (errors !== undefined && errors.length > 0) return [];

  const found: string[] = [];
  const seen = new Set<string>();

  const visit = (node: ts.Node, scopes: readonly ReadonlySet<string>[]): void => {
    // Types are not value references: `pr as PullRequest` reads `pr` only.
    if (ts.isTypeNode(node) || ts.isTypeParameterDeclaration(node)) return;

    if (ts.isIdentifier(node)) {
      const parent = node.parent as ts.Node | undefined;
      if (parent !== undefined && isNamePosition(node, parent)) return;
      const name = node.text;
      if (scopes.some((scope) => scope.has(name))) return;
      if (!seen.has(name)) {
        seen.add(name);
        found.push(name);
      }
      return;
    }

    let inner = scopes;
    if (isFunctionLike(node)) {
      inner = [...scopes, functionScope(node)];
    } else if (ts.isBlock(node) || ts.isModuleBlock(node)) {
      inner = [...scopes, blockScope(node.statements)];
    } else if (ts.isCatchClause(node)) {
      const names = new Set<string>();
      boundNames(node.variableDeclaration?.name, names);
      inner = [...scopes, names];
    } else if (ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isForStatement(node)) {
      const names = new Set<string>();
      const initializer = node.initializer;
      if (initializer !== undefined && ts.isVariableDeclarationList(initializer)) {
        for (const declaration of initializer.declarations) boundNames(declaration.name, names);
      }
      inner = [...scopes, names];
    }

    node.forEachChild((child) => {
      visit(child, inner);
    });
  };

  visit(file, []);
  return found;
}

/* -------------------------------------------------------------------------- */
/* the check                                                                   */
/* -------------------------------------------------------------------------- */

export interface ScopeCheckInput {
  /** Field or operation the value is written into — named in the message. */
  field: string;
  /** Node label, so the message says *where* the refusal happened. */
  nodeLabel: string;
  /** Names available at this point, already ordered for display. */
  available: readonly string[];
  /**
   * The subset worth *offering* in the message, when it differs from what is
   * legal. `tools` and an imported function are in scope and referencing them
   * is fine, but a message that answers "what can I put here?" with `tools`
   * invites nonsense from the reader this product is for. So the check stays
   * permissive and the suggestion stays useful. Defaults to `available`.
   */
  suggest?: readonly string[];
}

/**
 * Refuse an expression that references a name nothing binds here.
 *
 * Refusal, not repair: there is no safe guess at what the user meant, and
 * writing the reference anyway would produce code that does not run while the
 * UI shows a configured node (I6, 07 §5 "say 'not supported' out loud").
 */
export function checkExpressionScope(
  text: string,
  kind: SnippetKind,
  input: ScopeCheckInput,
): void {
  const available = new Set(input.available);
  const suggest = input.suggest ?? input.available;
  for (const name of rootReferences(text, kind)) {
    if (available.has(name) || ALLOWED.has(name)) continue;
    const inScope =
      suggest.length === 0
        ? "nothing is in scope at this step"
        : `values in scope at this step: ${suggest.join(", ")}`;
    throw new CodeFlowError(
      "patch-unsupported",
      `\`${name}\` is not available here — ${inScope}. "${input.field}" on "${input.nodeLabel}" was left unchanged (03 §6, 06 §3).`,
    );
  }
}
