/**
 * The per-node scope table — `WorkflowGraph.scopes` (03 §6, model/scope.ts).
 *
 * Two timing rules make this correct, and both are the reason this is a
 * separate pass instead of something `addNode` could finish on the spot:
 *
 *  1. **The name set is captured when the node is emitted** (`addNode`).
 *     Reading the scope later would show bindings declared *after* the node —
 *     the exact opposite of "what can I drag into this node".
 *  2. **The writers are read afterwards.** `FlowBinding.writers` is mutated
 *     after the fact: a `let` reassigned by a later statement adds a writer
 *     (03 §6, union of writers). So the capture holds live binding references
 *     and this pass flattens them once the analysis is complete.
 *
 * Consequence of (2), and it is the intended answer rather than a leak: a
 * node inside a loop body sees an accumulator `let` with the *later* node in
 * the same body listed as an origin. On the second iteration that node really
 * did produce the value being read, so the loop accumulator's origin list is
 * only complete with it.
 */

import type { ScopeBinding, ScopeOrigin, Schema, WorkflowNode } from "../model/index.js";
import type { AnalysisContext, FlowBinding } from "./context.js";

/**
 * Declared output schema of a binding's origin — only when there is exactly
 * one origin and that origin publishes a schema for the port. With several
 * writers there is no single declared type to show, and inventing a union
 * would be claiming knowledge the analyzer does not have (I6).
 */
function schemaOfOrigin(
  origins: readonly ScopeOrigin[],
  nodesById: ReadonlyMap<string, WorkflowNode>,
): Schema | undefined {
  if (origins.length !== 1) return undefined;
  const origin = origins[0];
  const node = nodesById.get(origin.nodeId);
  if (node === undefined) return undefined;
  const port =
    origin.port === undefined
      ? node.outputs.length === 1
        ? node.outputs[0]
        : undefined
      : node.outputs.find((candidate) => candidate.id === origin.port);
  return port?.schema;
}

function toScopeBinding(
  binding: FlowBinding,
  nodeId: string,
  nodesById: ReadonlyMap<string, WorkflowNode>,
): ScopeBinding {
  // A node never lists itself: it is the writer, not a reader, of its own output.
  const origins: ScopeOrigin[] = binding.writers
    .filter((writer) => writer.nodeId !== nodeId)
    .map((writer) => (writer.port === undefined ? { nodeId: writer.nodeId } : { nodeId: writer.nodeId, port: writer.port }));

  const entry: ScopeBinding = { name: binding.name, kind: binding.kind, origins };
  const schema = schemaOfOrigin(origins, nodesById);
  if (schema !== undefined) entry.schema = schema;
  if (binding.loopItem === true) entry.loopItem = true;
  if (binding.parameter === true) entry.parameter = true;
  return entry;
}

/**
 * Flatten every capture into plain data.
 *
 * **Ordering (I2)**: bindings are sorted by name, comparing UTF-16 code units
 * (not `localeCompare`, whose result depends on the host's locale data). The
 * alternative — declaration order — has no single meaning across a shadowing
 * chain, where an entry may come from any scope on the way out; one stable
 * rule that a reader can verify by eye beats a positional one that cannot be.
 * Node keys follow node emission order, which is itself deterministic, so a
 * cold analyze of the same (source, registry) serialises byte-identically.
 */
export function materializeScopes(ctx: AnalysisContext): Record<string, ScopeBinding[]> {
  const nodesById = new Map(ctx.nodes.map((node) => [node.id, node]));
  const scopes: Record<string, ScopeBinding[]> = {};
  for (const capture of ctx.scopeCaptures) {
    const bindings = capture.bindings
      .map((binding) => toScopeBinding(binding, capture.nodeId, nodesById))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    scopes[capture.nodeId] = bindings;
  }
  return scopes;
}
