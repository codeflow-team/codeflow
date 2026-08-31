/**
 * The MCP server list as React state, and the registry it composes to.
 *
 * One hook, called once, in `App`. Everything downstream — the palette, the
 * session `analyze` resolves against, the AI's `tools.d.ts`, the Run bindings —
 * reads the single `RegistryLookup` this returns, which is the point: there is
 * one registry, and four consumers of it (05 §2).
 *
 * The composed registry takes over **as soon as one enabled server contributes
 * a tool**, and hands back to the built-in example registries when none does.
 * No hidden mode switch: what is on the list is what is in the palette.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRegistry, type RegistryLookup } from "@codeflow-team/core";
import type { ExampleRegistry, FlowExample } from "../examples-source.js";
import { registryFor } from "../examples-source.js";
import { registryInstance } from "../registry.js";
import { compose, type ComposedRegistry, type McpServerConfig } from "./model.js";
import { clearServers, loadServers, saveServers, tokenFor } from "./storage.js";

export interface McpServersState {
  servers: McpServerConfig[];
  setServers: (next: McpServerConfig[] | ((current: McpServerConfig[]) => McpServerConfig[])) => void;
  updateServer: (id: string, patch: Partial<McpServerConfig>) => void;
  replaceServer: (id: string, next: McpServerConfig) => void;
  removeServer: (id: string) => void;
  addServer: (config: McpServerConfig) => void;
  reset: () => void;
  /** Set when the browser refused to persist the list, so the UI can say so. */
  storageError: string | null;
  composed: ComposedRegistry;
  /** True when the composed registry is the one in use. */
  active: boolean;
  tokenFor: (config: McpServerConfig) => string | undefined;
}

export function useMcpServers(): McpServersState {
  const [servers, setServersState] = useState<McpServerConfig[]>(() => loadServers() ?? []);
  const [storageError, setStorageError] = useState<string | null>(null);
  const first = useRef(true);

  useEffect(() => {
    // Nothing to write on the very first render — that value came *from*
    // storage, and writing it back would only risk a spurious quota error.
    if (first.current) {
      first.current = false;
      return;
    }
    const result = saveServers(servers);
    setStorageError(result.ok ? null : (result.error ?? null));
  }, [servers]);

  const setServers = useCallback(
    (next: McpServerConfig[] | ((current: McpServerConfig[]) => McpServerConfig[])) => {
      setServersState((current) => (typeof next === "function" ? next(current) : next));
    },
    [],
  );

  const updateServer = useCallback((id: string, patch: Partial<McpServerConfig>) => {
    setServersState((current) =>
      current.map((server) => (server.id === id ? { ...server, ...patch } : server)),
    );
  }, []);

  const replaceServer = useCallback((id: string, next: McpServerConfig) => {
    setServersState((current) => current.map((server) => (server.id === id ? next : server)));
  }, []);

  const removeServer = useCallback((id: string) => {
    setServersState((current) => current.filter((server) => server.id !== id));
  }, []);

  const addServer = useCallback((config: McpServerConfig) => {
    setServersState((current) => [...current, config]);
  }, []);

  const reset = useCallback(() => {
    clearServers();
    setServersState([]);
    setStorageError(null);
  }, []);

  const composed = useMemo(() => compose(servers), [servers]);
  const active = composed.toolCount > 0;

  return {
    servers,
    setServers,
    updateServer,
    replaceServer,
    removeServer,
    addServer,
    reset,
    storageError,
    composed,
    active,
    tokenFor,
  };
}

/**
 * Which `ExampleRegistry` is in force, and the live `RegistryLookup` for it.
 *
 * A tiny cache keyed by the registry's id: `registryHash` is what a graph is
 * analyzed against and what every patch is validated against (05 §2), so a
 * registry object rebuilt on each render would invalidate the open graph on
 * every keystroke. The composed id already changes exactly when the content
 * does (`compose()` fingerprints the tools), so identity and content agree.
 */
const composedCache = new Map<string, RegistryLookup>();

export function activeRegistry(
  example: FlowExample,
  state: Pick<McpServersState, "composed" | "active">,
): { source: ExampleRegistry; lookup: RegistryLookup; fromMcp: boolean } {
  if (!state.active) {
    const source = registryFor(example);
    return { source, lookup: registryInstance(source), fromMcp: false };
  }
  const source = state.composed.registry;
  let lookup = composedCache.get(source.id);
  if (lookup === undefined) {
    lookup = createRegistry({ tools: source.tools, functions: source.functions });
    // One composition at a time is all anyone needs; the cache exists for
    // identity stability across renders, not as a history.
    if (composedCache.size > 8) composedCache.clear();
    composedCache.set(source.id, lookup);
  }
  return { source, lookup, fromMcp: true };
}
