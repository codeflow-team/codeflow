/**
 * Every `.tsx` module must be a React Fast Refresh boundary.
 *
 * Real incident (QA, 2026-08-23): with the dev server up, `flow/visual.js`
 * exported a lookup table (`nodeVisual`, `REGISTRY_ICONS`) next to two
 * components. React Refresh only swaps a module in place when *all* of its
 * runtime exports look like components; one that does not makes the module a
 * non-boundary, the update propagates to the root, and Vite answers with
 * `full-reload`. The page came back blank three times in twenty minutes, each
 * time taking the whole chat conversation, the flow being edited and the AI
 * request in flight with it.
 *
 * The rule this test encodes is exactly React Refresh's own
 * `isLikelyComponentType`: a function whose name starts with a capital letter,
 * or a `forwardRef`/`memo` object. Types are erased at build time and do not
 * count. Anything else — a hook, a `cva()` table, a helper, a re-exported
 * namespace — belongs in a sibling `.ts` module.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out.sort();
}

const REACT_FORWARD_REF = Symbol.for("react.forward_ref");
const REACT_MEMO = Symbol.for("react.memo");

/** React Refresh's `isLikelyComponentType`, close enough for a static gate. */
function isLikelyComponent(value: unknown): boolean {
  if (typeof value === "function") {
    const name = value.name;
    return name.length > 0 && name[0] === name[0]?.toUpperCase() && /^[A-Z]/.test(name);
  }
  if (typeof value === "object" && value !== null) {
    const tag = (value as { $$typeof?: symbol }).$$typeof;
    return tag === REACT_FORWARD_REF || tag === REACT_MEMO;
  }
  return false;
}

describe("Fast Refresh boundaries", () => {
  const files = tsxFiles(SRC);

  it("finds the .tsx modules to check", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const file of files) {
    const name = relative(SRC, file);
    it(`${name} exports only components`, async () => {
      const module = (await import(file)) as Record<string, unknown>;
      const offenders = Object.entries(module)
        .filter(([key]) => key !== "__esModule" && key !== "default")
        .filter(([, value]) => !isLikelyComponent(value))
        .map(([key]) => key);

      expect(offenders, `${name} must export components only — move ${offenders.join(", ")} to a .ts module`).toEqual(
        [],
      );
    });
  }
});
