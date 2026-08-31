/**
 * One statement, several names, one recorded value — 03 §6, 07 §5.
 *
 * `const triaged = []; let skipped = 0;` is a single step, and the runtime
 * records a single value for it, keyed by the names it bound. Handing that
 * whole object to every binding of the step produced draggable rows called
 * `triaged.skipped` and `skipped.triaged`: names for properties that do not
 * exist, on the one surface built for dragging. That is the mis-mapping I6
 * exists to prevent, so it gets a test of its own.
 */

import { describe, expect, it } from "vitest";
import type { NodeRunState } from "@codeflow-team/core";
import { observedAt } from "../src/editor/result.js";
import { scopeRows } from "../src/editor/scope-rows.js";

function state(preview: unknown): NodeRunState {
  return { nodeId: "n1", runs: 1, status: "ok", totalMs: 1, lastAt: 1, preview };
}

describe("a value recorded for several bindings", () => {
  it("gives each binding its own share", () => {
    const recorded = state({ triaged: [{ id: "T-1" }], skipped: 2 });
    expect(observedAt(recorded, null, { field: "triaged" })?.value).toEqual([{ id: "T-1" }]);
    expect(observedAt(recorded, null, { field: "skipped" })?.value).toBe(2);
  });

  it("hands over the whole value when no field is asked for", () => {
    const recorded = state({ triaged: [], skipped: 0 });
    expect(observedAt(recorded, null)?.value).toEqual({ triaged: [], skipped: 0 });
  });

  it("does not re-interpret a value that does not carry the name", () => {
    // The step declared two names but reported something else. Picking a
    // missing key would turn a real value into `undefined`; the honest answer
    // is the value as recorded.
    expect(observedAt(state("just text"), null, { field: "triaged" })?.value).toBe("just text");
    expect(observedAt(state([1, 2]), null, { field: "triaged" })?.value).toEqual([1, 2]);
    expect(observedAt(state({ other: 1 }), null, { field: "triaged" })?.value).toEqual({ other: 1 });
  });

  it("stops the rows that named properties nobody bound", () => {
    const recorded = state({ triaged: [{ id: "T-1" }], skipped: 2 });
    const binding = { name: "skipped", kind: "value", origins: [{ nodeId: "n1" }] };
    const shared = scopeRows(binding, { observed: observedAt(recorded, null) ?? { value: undefined } });
    // Before the fix every binding got the whole object, so `skipped` grew a
    // child called `skipped.triaged`.
    expect(shared.map((row) => row.path)).toContain("skipped.triaged");

    const own = scopeRows(binding, { observed: observedAt(recorded, null, { field: "skipped" })! });
    expect(own.map((row) => row.path)).toEqual(["skipped"]);
  });
});

/**
 * The crash that blanked the page.
 *
 * `RunEvent.preview` is `unknown` by contract, and the demo runner envelopes a
 * *tool* result as `{ tool, source, value }` while sending anything else bare.
 * `"value" in preview` threw `TypeError: Cannot use 'in' operator` the moment a
 * step produced a string — React unmounted and the page went white. It was
 * unreachable while only tool calls reported values.
 */
describe("a preview that is not an object", () => {
  it("does not throw for a string, a number, or null", () => {
    for (const preview of ["Ticket T-1 from Acme", 42, null, true, ["a"]]) {
      expect(() => observedAt(state(preview), null)).not.toThrow();
      expect(observedAt(state(preview), null)?.value).toEqual(preview);
    }
  });

  it("still unwraps a tool envelope", () => {
    const enveloped = state({ tool: "fs.readTextFile", source: "mcp", value: { content: "hi" } });
    expect(observedAt(enveloped, null)?.value).toEqual({ content: "hi" });
  });
});
