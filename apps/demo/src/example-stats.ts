/**
 * Real numbers for the gallery cards.
 *
 * A card that says "34 steps" has to have counted them, so every example is
 * analyzed once — cold, in its own session, so measuring never disturbs the
 * identity continuity of the flow the user is actually editing (03 §5.0).
 * Results are cached for the lifetime of the page and computed lazily, one
 * example at a time with a yield in between, so opening the gallery never
 * blocks the frame.
 */

import { createCodeFlow, type RegistryLookup, type WorkflowGraph } from "@codeflow-team/core";
import type { FlowExample } from "./examples-source.js";
import { registryInstanceFor } from "./registry.js";

export interface ExampleStats {
  nodes: number;
  /** Nodes a reader would call a step: everything but the synthetic ends. */
  steps: number;
  containers: number;
  errors: number;
  warnings: number;
  ms: number;
}

const cache = new Map<string, ExampleStats>();
const inFlight = new Map<string, Promise<ExampleStats | null>>();

export function statsFor(exampleId: string): ExampleStats | null {
  return cache.get(exampleId) ?? null;
}

export function statsFromGraph(graph: WorkflowGraph, ms: number): ExampleStats {
  const containers = new Set<string>();
  for (const node of graph.nodes) {
    const parent = node.data["parentId"];
    if (typeof parent === "string" && parent.length > 0) containers.add(parent);
  }
  return {
    nodes: graph.nodes.length,
    steps: graph.nodes.filter((node) => node.type !== "trigger" && node.type !== "output").length,
    containers: containers.size,
    errors: graph.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length,
    warnings: graph.diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length,
    ms,
  };
}

async function measure(example: FlowExample, lookup?: RegistryLookup): Promise<ExampleStats | null> {
  try {
    // A flow the visitor made may name the composed MCP registry, which
    // `registryInstanceFor` knows nothing about — so the caller passes the one
    // `flow-registry.ts` resolved instead of this file guessing.
    const session = createCodeFlow({ registry: lookup ?? registryInstanceFor(example) });
    const started = performance.now();
    const graph = await session.analyze(example.source, {
      trigger: { kind: "webhook", label: "Trigger" },
    });
    const stats = statsFromGraph(graph, Math.round(performance.now() - started));
    cache.set(example.id, stats);
    return stats;
  } catch {
    // A gallery card is not the place to report an analyzer failure — the flow
    // itself will say so, loudly, the moment it is opened.
    return null;
  }
}

export function measureExample(
  example: FlowExample,
  lookup?: RegistryLookup,
): Promise<ExampleStats | null> {
  const cached = cache.get(example.id);
  if (cached !== undefined) return Promise.resolve(cached);
  const running = inFlight.get(example.id);
  if (running !== undefined) return running;
  const promise = measure(example, lookup).finally(() => {
    inFlight.delete(example.id);
  });
  inFlight.set(example.id, promise);
  return promise;
}

/** Measure everything that has no numbers yet, one at a time, yielding between. */
export async function measureAll(
  examples: readonly FlowExample[],
  onEach: (id: string, stats: ExampleStats) => void,
  lookupFor?: (example: FlowExample) => RegistryLookup | undefined,
): Promise<void> {
  for (const example of examples) {
    if (cache.has(example.id)) {
      onEach(example.id, cache.get(example.id) as ExampleStats);
      continue;
    }
    const stats = await measureExample(example, lookupFor?.(example));
    if (stats !== null) onEach(example.id, stats);
    await new Promise((resolve) => { setTimeout(resolve, 0); });
  }
}

/**
 * Forget what was measured for one flow.
 *
 * A visitor's own flow is edited in place, so its card's numbers stop being
 * true the moment the source changes. A built-in example never changes and is
 * never invalidated.
 */
export function forgetStats(id: string): void {
  cache.delete(id);
}

/** Record numbers the app already paid for — the open flow is never re-analyzed. */
export function rememberStats(exampleId: string, stats: ExampleStats): void {
  cache.set(exampleId, stats);
}
