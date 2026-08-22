/**
 * Binding-rooted resolution — 04-analyzer.md §1.2.
 *
 * A call is a tool call when its property-access chain is rooted at the binding
 * of the flow's `tools` parameter. Everything is decided from scope analysis;
 * the type checker is never consulted on this path, which is what keeps graph
 * construction fast and browser-safe (02 §3).
 */

import { Node, SyntaxKind } from "ts-morph";
import type { Expression } from "ts-morph";
import type { Frame } from "./context.js";
import type { RegistryLookup } from "../registry/lookup.js";

/** A property-access chain resolved against the scope. */
export interface ToolsChain {
  /** Dotted path after the tools root, e.g. `github.getFiles`. */
  path: string;
  /** True when any link in the chain used `?.` — unsupported (01 §2). */
  optional: boolean;
}

/**
 * Walk a property-access chain down to its root identifier and, if that
 * identifier is bound to the `tools` parameter (directly or through an alias),
 * return the remaining path.
 */
export function resolveToolsChain(expression: Node, frame: Frame): ToolsChain | null {
  const segments: string[] = [];
  let optional = false;
  let current: Node = expression;

  for (;;) {
    if (Node.isPropertyAccessExpression(current)) {
      segments.unshift(current.getName());
      if (current.getQuestionDotTokenNode() !== undefined) optional = true;
      current = current.getExpression();
      continue;
    }
    if (Node.isNonNullExpression(current) || Node.isParenthesizedExpression(current)) {
      current = current.getExpression();
      continue;
    }
    if (Node.isElementAccessExpression(current)) {
      // tools["github"]["getFiles"] — not a resolvable static path.
      return null;
    }
    break;
  }

  if (!Node.isIdentifier(current)) return null;
  const binding = frame.scope.lookup(current.getText());
  if (binding === null || binding.kind !== "tools") return null;

  const path = [...(binding.toolsPrefix ?? []), ...segments].join(".");
  if (path.length === 0) return null;
  return { path, optional };
}

/**
 * A `tools`-rooted expression that is not a call — used to recognise aliases
 * (`const t = tools`, `const gh = tools.github`).
 */
export function toolsAliasPrefix(expression: Node, frame: Frame): readonly string[] | null {
  const segments: string[] = [];
  let current: Node = expression;
  for (;;) {
    if (Node.isPropertyAccessExpression(current)) {
      if (current.getQuestionDotTokenNode() !== undefined) return null;
      segments.unshift(current.getName());
      current = current.getExpression();
      continue;
    }
    if (Node.isParenthesizedExpression(current)) {
      current = current.getExpression();
      continue;
    }
    break;
  }
  if (!Node.isIdentifier(current)) return null;
  const binding = frame.scope.lookup(current.getText());
  if (binding === null || binding.kind !== "tools") return null;
  return [...(binding.toolsPrefix ?? []), ...segments];
}

export type CalleeResolution =
  | { kind: "tool"; toolPath: string; registered: boolean; optional: boolean }
  | { kind: "library-function"; functionName: string; localName: string }
  | { kind: "local-function"; functionName: string }
  | { kind: "unresolved" };

/** Resolve the callee of a call expression to one of the four callable sources (01 §1b). */
export function resolveCallee(
  call: Node,
  frame: Frame,
  registry: RegistryLookup,
): CalleeResolution {
  if (!Node.isCallExpression(call)) return { kind: "unresolved" };
  const callee = call.getExpression();

  const chain = resolveToolsChain(callee, frame);
  if (chain !== null) {
    return {
      kind: "tool",
      toolPath: chain.path,
      registered: registry.getTool(chain.path) !== undefined,
      optional: chain.optional || call.getQuestionDotTokenNode() !== undefined,
    };
  }

  if (Node.isIdentifier(callee)) {
    const binding = frame.scope.lookup(callee.getText());
    if (binding?.kind === "library-function") {
      return {
        kind: "library-function",
        functionName: binding.functionName ?? binding.name,
        localName: binding.name,
      };
    }
    if (binding?.kind === "local-function") {
      return { kind: "local-function", functionName: binding.name };
    }
  }

  return { kind: "unresolved" };
}

/** `Promise.all(...)` — matched structurally, not by string search. */
export function isPromiseAllCall(node: Node): boolean {
  if (!Node.isCallExpression(node)) return false;
  const callee = node.getExpression();
  if (!Node.isPropertyAccessExpression(callee)) return false;
  if (callee.getName() !== "all") return false;
  const target = callee.getExpression();
  return Node.isIdentifier(target) && target.getText() === "Promise";
}

/** Strip parentheses so `(await x)` and `await x` classify the same. */
export function unwrapParens(expression: Expression): Expression {
  let current: Expression = expression;
  while (current.getKind() === SyntaxKind.ParenthesizedExpression) {
    current = (current as import("ts-morph").ParenthesizedExpression).getExpression();
  }
  return current;
}
