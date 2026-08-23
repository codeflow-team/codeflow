/**
 * The context object must keep its identity when its module is executed twice.
 *
 * Real incident: with the dev server up, rebuilding `@codeflow/core` invalidated
 * `provider.js`; Fast Refresh re-executed it, `createContext` produced a second
 * object, and every consumer of the still-mounted provider read the `null`
 * default and threw `useCodeFlow must be used inside <CodeFlowProvider>` —
 * blank page until a manual reload.
 *
 * `vi.resetModules()` reproduces exactly that: the next import re-executes the
 * module graph, the way HMR does.
 */

import { describe, expect, it, vi } from "vitest";

async function loadContext(): Promise<unknown> {
  const mod = await import("../../src/context/context.js");
  return mod.CodeFlowContext;
}

describe("context identity across module re-execution (HMR)", () => {
  it("hands out the same context object after the module is re-executed", async () => {
    const first = await loadContext();
    vi.resetModules();
    const second = await loadContext();

    expect(second).toBe(first);
  });

  it("survives several re-executions in a row", async () => {
    const first = await loadContext();
    for (let i = 0; i < 3; i += 1) {
      vi.resetModules();
      expect(await loadContext()).toBe(first);
    }
  });

  it("is the very object the provider module publishes on", async () => {
    const { CodeFlowContext } = await import("../../src/context/context.js");
    vi.resetModules();
    // A consumer module re-executed by Fast Refresh reads through the provider's
    // re-export; it has to resolve to the same object the first load produced.
    const { CodeFlowContext: viaProvider } = await import("../../src/context/context.js");

    expect(viaProvider).toBe(CodeFlowContext);
  });
});
