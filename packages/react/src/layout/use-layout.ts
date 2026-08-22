import { useEffect, useRef, useState } from "react";
import type { WorkflowGraph } from "@codeflow/core";
import type { DisclosureMode } from "../flow/summary.js";
import type { LayoutDirection } from "./elk-graph.js";
import { runLayout, type LayoutResult } from "./run.js";

export interface UseElkLayoutOptions {
  mode: DisclosureMode;
  direction?: LayoutDirection;
}

export interface UseElkLayoutState {
  layout: LayoutResult | null;
  /** True while ELK is running — the canvas stays interactive meanwhile (07 §7). */
  pending: boolean;
  error: Error | null;
}

/**
 * Run ELK whenever the graph identity, the disclosure mode or the direction
 * changes. Stale results are dropped so a slow run can never overwrite a newer
 * one.
 */
export function useElkLayout(
  graph: WorkflowGraph | null,
  options: UseElkLayoutOptions,
): UseElkLayoutState {
  const [state, setState] = useState<UseElkLayoutState>({ layout: null, pending: graph !== null, error: null });
  const runId = useRef(0);
  const { mode, direction } = options;

  useEffect(() => {
    if (graph === null) {
      setState({ layout: null, pending: false, error: null });
      return;
    }
    const id = ++runId.current;
    setState((previous) => ({ ...previous, pending: true, error: null }));

    runLayout(graph, { mode, direction }).then(
      (layout) => {
        if (runId.current !== id) return;
        setState({ layout, pending: false, error: null });
      },
      (error: unknown) => {
        if (runId.current !== id) return;
        setState({ layout: null, pending: false, error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
  }, [graph, mode, direction]);

  return state;
}
