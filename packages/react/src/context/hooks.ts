/**
 * Hooks that read the CodeFlow context.
 *
 * They live apart from `provider.tsx` so that module exports a component and
 * nothing else: React Fast Refresh only accepts a module whose exports are all
 * components, and a mixed module gets invalidated (and its importers reloaded)
 * on every dependency change. See context.ts for what that invalidation used to
 * cost.
 */

import { useContext } from "react";
import type { Diagnostic, WorkflowNode } from "@codeflow/core";
import { CodeFlowContext } from "./context.js";
import type { CodeFlowContextValue } from "./types.js";

export function useCodeFlow(): CodeFlowContextValue {
  const value = useContext(CodeFlowContext);
  if (value === null) throw new Error("useCodeFlow must be used inside <CodeFlowProvider>");
  return value;
}

/** Like `useCodeFlow`, but `null` outside a provider — for optional chrome. */
export function useOptionalCodeFlow(): CodeFlowContextValue | null {
  return useContext(CodeFlowContext);
}

export function useSelectedNode(): WorkflowNode | null {
  return useCodeFlow().selectedNode;
}

export function useNodeDiagnostics(nodeId: string | null): Diagnostic[] {
  const { nodeDiagnostics } = useCodeFlow();
  if (nodeId === null) return [];
  return nodeDiagnostics.get(nodeId) ?? [];
}
