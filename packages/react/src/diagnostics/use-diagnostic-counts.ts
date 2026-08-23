/**
 * Diagnostic counts by severity — exported so chrome can badge a trigger.
 *
 * A hook is not a component, so it cannot live in `DiagnosticsPanel.tsx`: React
 * Fast Refresh replaces a module in place only when every export of it is a
 * component, and the panel is rebuilt often enough that losing that property
 * would mean a full page reload (and, in the demo, the whole conversation).
 */

import { useMemo } from "react";
import { useCodeFlow } from "../context/hooks.js";

export function useDiagnosticCounts(): { error: number; warning: number; info: number; total: number } {
  const { graph } = useCodeFlow();
  return useMemo(() => {
    const out = { error: 0, warning: 0, info: 0, total: 0 };
    for (const diagnostic of graph?.diagnostics ?? []) {
      out[diagnostic.severity]++;
      out.total++;
    }
    return out;
  }, [graph]);
}
