/**
 * Per-node scope table — what data is *available* at a node (03 §6, 04 §1.2).
 *
 * The UI's left pane lists the values a user may drag into a parameter of the
 * node being configured. In CodeFlow the "connection" between two nodes IS a
 * variable reference in the source, so a drag becomes an ordinary field patch
 * writing a TypeScript expression. That list has to come from the analyzer:
 * the answer depends on lexical scope, shadowing and binding resolution, and a
 * second implementation in the UI would be a second, divergent analyzer.
 *
 * A `ScopeBinding` is the analyzer's `FlowBinding` flattened into plain data —
 * no AST, no live scope object, JSON-serialisable like the rest of the graph.
 */

import type { Schema } from "./schema.js";

/** A node (and port) that writes a binding — 03 §6 union-of-writers. */
export interface ScopeOrigin {
  nodeId: string;
  port?: string;
}

export interface ScopeBinding {
  /** The name as written in the source, e.g. "prs", "pr". */
  name: string;
  /**
   * Mirrors the analyzer's `BindingKind`:
   * "tools" | "value" | "library-function" | "foreign-import" | "local-function".
   *
   * Kept for *every* binding, imports and `tools` included, so the UI can
   * filter: an omission here is invisible, a kind is inspectable.
   */
  kind: string;
  /**
   * Nodes that write this binding (03 §6 — a `let` reassigned in several
   * branches has one origin per writer). Empty for a flow parameter, for an
   * import, and for a local function: nothing in the graph produces them.
   */
  origins: ScopeOrigin[];
  /** Declared output schema of the origin, when there is exactly one origin that has one. */
  schema?: Schema;
  /** True when the binding is the item variable of an enclosing `for…of` / `for await…of`. */
  loopItem?: boolean;
  /** True for a parameter of the flow function itself (`input`, `tools`). */
  parameter?: boolean;
}
