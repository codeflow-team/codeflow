/**
 * Analyzer state — scopes, bindings, frames.
 *
 * Resolution is by **binding, never by name** (04 §1.2): a call is a tool call
 * when its property-access chain is rooted at the binding of the flow's second
 * parameter. An alias (`const t = tools`) resolves; an unrelated object that
 * merely happens to be called `tools` in a nested scope does not.
 */

import type { Node, SourceFile } from "ts-morph";
import type { Diagnostic, WorkflowEdge, WorkflowNode } from "../model/index.js";
import type { RegistryLookup } from "../registry/lookup.js";
import { PathScope } from "../mapper/index.js";

export type BindingKind =
  /** the `tools` parameter, or an alias/partial alias of it */
  | "tools"
  /** a value binding: const/let/param/loop variable/destructured name */
  | "value"
  /** an import that resolves to a registered library function */
  | "library-function"
  /** an import from a module that is not the function library */
  | "foreign-import"
  /** a named function declared in the flow file */
  | "local-function";

export interface BindingWriter {
  nodeId: string;
  port?: string;
}

export interface FlowBinding {
  name: string;
  kind: BindingKind;
  /** For `kind: "tools"` — the path already consumed by the alias, e.g. `["github"]`. */
  toolsPrefix?: readonly string[];
  /** For imports — the module specifier. */
  modulePath?: string;
  /** For library functions — the registered name (may differ from the local alias). */
  functionName?: string;
  /**
   * Nodes that write this binding, in source order. A `const` has exactly one;
   * a `let` reassigned in several branches has one per writer (03 §6).
   */
  writers: BindingWriter[];
}

export class Scope {
  private readonly bindings = new Map<string, FlowBinding>();

  constructor(readonly parent: Scope | null = null) {}

  declare(binding: FlowBinding): FlowBinding {
    this.bindings.set(binding.name, binding);
    return binding;
  }

  /** Nearest binding for `name` — shadowing resolves to the innermost declaration. */
  lookup(name: string): FlowBinding | null {
    let scope: Scope | null = this;
    while (scope !== null) {
      const found = scope.bindings.get(name);
      if (found !== undefined) return found;
      scope = scope.parent;
    }
    return null;
  }

  child(): Scope {
    return new Scope(this);
  }
}

/** A dangling control output waiting to be connected to whatever comes next. */
export interface Exit {
  nodeId: string;
  port?: string;
  label?: string;
}

/**
 * Collector for `jump`/`output` nodes that must also flow into a `finally`
 * block (04 §2.7). Only jumps that actually leave the `try` are collected —
 * a `break` targeting a loop nested *inside* the try does not run the finally.
 */
export interface TerminalSink {
  nodeIds: string[];
}

/** Per-block analysis frame: naming scope, binding scope, container, sinks. */
export interface Frame {
  scope: Scope;
  path: PathScope;
  /** Nearest container node (loop/try) — how nesting is represented, see report. */
  parentId: string | null;
  /** Which subgraph slot of the container: "body" | "catch" | "finally". */
  parentSlot: string | null;
  sink: TerminalSink | null;
  /** Loop nesting depth accumulated since `sink` was installed. */
  sinkLoopDepth: number;
  /** Labels of loops nested inside the `try`, for labeled `break`/`continue`. */
  sinkLabels: ReadonlySet<string>;
}

export interface AnalysisContext {
  file: string;
  sourceFile: SourceFile;
  registry: RegistryLookup;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  diagnostics: Diagnostic[];
  /** Name of the flow's second parameter, or null when the contract is violated. */
  toolsParam: string | null;
  /** Named function declarations in the flow file — 04 §3. */
  localFunctions: Map<string, Node>;
  /** Deduplication key set for data edges (one edge per source/port → target). */
  dataEdgeKeys: Set<string>;
  /** Deduplication for control edges. */
  controlEdgeKeys: Set<string>;
}

/** Derive a nested frame, inheriting anything not overridden. */
export function childFrame(frame: Frame, overrides: Partial<Frame>): Frame {
  return {
    scope: overrides.scope ?? frame.scope.child(),
    path: overrides.path ?? frame.path,
    parentId: overrides.parentId === undefined ? frame.parentId : overrides.parentId,
    parentSlot: overrides.parentSlot === undefined ? frame.parentSlot : overrides.parentSlot,
    sink: overrides.sink === undefined ? frame.sink : overrides.sink,
    sinkLoopDepth: overrides.sinkLoopDepth ?? frame.sinkLoopDepth,
    sinkLabels: overrides.sinkLabels ?? frame.sinkLabels,
  };
}
