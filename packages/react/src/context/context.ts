/**
 * The React context object itself, kept in its own module.
 *
 * Two reasons it does not live in `provider.tsx`:
 *
 * 1. `provider.tsx` exports hooks, constants and types alongside the provider
 *    component, so React Fast Refresh cannot treat it as a refresh boundary and
 *    re-executes it on any dependency update (a `@codeflow-team/core` rebuild while
 *    the dev server runs is enough).
 * 2. A re-executed module produces a *new* context object. A provider mounted
 *    from the previous instance then publishes on the old object while consumers
 *    read the new one, get the `null` default, and throw — the whole page goes
 *    blank until a manual reload.
 *
 * So the object is created once per realm and cached on `globalThis`: module
 * re-execution reuses it, provider and consumers keep agreeing, and a genuine
 * "used outside the provider" mistake still throws.
 */

import { createContext } from "react";
import type { Context } from "react";
import type { CodeFlowContextValue } from "./types.js";

const REGISTRY_KEY = "__codeflow_react_context__";

type ContextRegistry = {
  [REGISTRY_KEY]?: Context<CodeFlowContextValue | null>;
};

const registry = globalThis as ContextRegistry;

export const CodeFlowContext: Context<CodeFlowContextValue | null> =
  registry[REGISTRY_KEY] ??
  (registry[REGISTRY_KEY] = createContext<CodeFlowContextValue | null>(null));
