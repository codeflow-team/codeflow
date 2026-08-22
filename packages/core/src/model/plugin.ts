/**
 * Registry extension points — 03-data-model.md §11.
 *
 * Minimal signatures on purpose. The load-bearing principle: a plugin NEVER gets
 * write access to the source, it only returns `TextPatch[]`.
 */

import type { Diagnostic } from "./diagnostic.js";
import type { WorkflowNode } from "./graph.js";
import type { SourceDocument, SourceMapping, TextPatch } from "./source.js";
import type { RegistryLookup } from "../registry/lookup.js";

declare const astNodeBrand: unique symbol;

/**
 * A syntax-tree node. Opaque to plugins so the underlying parser (MVP: ts-morph)
 * can change without breaking the plugin API.
 */
export interface AstNode {
  readonly [astNodeBrand]?: never;
}

export type BindingKind =
  /** rooted at the `tools` parameter of the flow function */
  | "tools"
  /** imported binding (library function or foreign module) */
  | "import"
  /** declared inside the flow file */
  | "local"
  | "unknown";

export interface Binding {
  name: string;
  kind: BindingKind;
  /** for `kind: "import"` — the module specifier, e.g. "@flows/lib" */
  modulePath?: string;
  declaration?: AstNode;
}

export interface AnalyzeContext {
  source: SourceDocument;
  registry: RegistryLookup;
  /** Resolve an identifier/expression to the binding it is rooted at (by symbol). */
  resolveBinding(node: AstNode): Binding | null;
  addDiagnostic(diagnostic: Diagnostic): void;
}

export interface PatchContext {
  source: SourceDocument;
  resolveRange(nodeId: string): SourceMapping | null;
  addDiagnostic(diagnostic: Diagnostic): void;
}

export type SemanticAnalyzer = (ctx: AnalyzeContext, node: AstNode) => WorkflowNode | null;

export type NodePatcher = (
  ctx: PatchContext,
  node: WorkflowNode,
  changes: Record<string, unknown>,
) => TextPatch[];

/**
 * React component type — defined in @codeflow/react. Core only keeps an opaque
 * reference so it stays browser-safe and React-free.
 */
export type NodeRenderer = unknown;
