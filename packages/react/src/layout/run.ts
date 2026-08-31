/**
 * Async ELK run (07 §1: "chạy async", §7: "layout không block interaction").
 *
 * `elkjs` is imported lazily so importing `@codeflow-team/react` for the pure
 * adapters — or unit-testing them — never pulls in the layout engine.
 */

import type { WorkflowGraph } from "@codeflow-team/core";
import type { ELK as ElkInstance } from "elkjs/lib/elk-api.js";
import { collectLayout, toElkGraph, type ElkGraphOptions, type LayoutBox } from "./elk-graph.js";

export interface LayoutResult {
  /** Parent-relative box per node id — exactly what React Flow wants. */
  boxes: Map<string, LayoutBox>;
  skippedEdgeIds: string[];
}

let elkPromise: Promise<ElkInstance> | null = null;

async function getElk(): Promise<ElkInstance> {
  elkPromise ??= import("elkjs/lib/elk.bundled.js").then((module) => {
    const Ctor = (module.default ?? module) as unknown as new () => ElkInstance;
    return new Ctor();
  });
  return elkPromise;
}

export async function runLayout(graph: WorkflowGraph, options: ElkGraphOptions): Promise<LayoutResult> {
  const { root, skippedEdgeIds } = toElkGraph(graph, options);
  if ((root.children ?? []).length === 0) return { boxes: new Map(), skippedEdgeIds };
  const elk = await getElk();
  const laidOut = await elk.layout(root);
  return { boxes: collectLayout(laidOut), skippedEdgeIds };
}
