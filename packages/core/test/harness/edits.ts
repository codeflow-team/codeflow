/**
 * Edit cases of the fixture corpus — 11-testing.md §3.2.
 *
 *     fixtures/<case>/edits/<name>.edit.json        what to change
 *     fixtures/<case>/edits/<name>.expected.diff    the diff it must produce,
 *                                                   character for character
 *
 * The `.edit.json` names the node by **semantic path** rather than by id: a
 * path is readable in review, and the derivation path → id is asserted
 * separately by the fixture suite (03 §5.0).
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface EditCase {
  /** File base name, e.g. "change-channel". */
  name: string;
  fixture: string;
  dir: string;
  description: string;
  /** Semantic path of the node being patched. */
  node: string;
  changes: Record<string, unknown>;
  /** The edit is expected to be refused with this error code (06 §2, §5). */
  error?: { code: string; message?: string };
  /** How many nodes the edit removes / adds (default 0). */
  expectRemoved?: number;
  expectAdded?: number;
  /**
   * Semantic paths of nodes allowed to change in more than their source range,
   * *besides* the edited node — I4 says nothing else may change.
   */
  alsoUpdated?: string[];
  /**
   * The full expected set of substantively-changed nodes, when it is not
   * "the edited node" (e.g. editing a local function body changes no node data
   * at all — only source offsets move).
   */
  expectUpdated?: string[];
  /** Semantic path of the edited node *after* the patch, when the path changes. */
  updatedAs?: string;
  /** Applying the same edit again must be a no-op unless this says otherwise. */
  idempotent?: boolean;
  /** Diagnostic codes the patch result must carry, in order. */
  diagnostics?: string[];
  /** Path of the expected diff file. */
  diffPath: string;
  /** Contents of the expected diff, or null when it has not been written yet. */
  expectedDiff: string | null;
}

export function listEdits(fixtureDir: string, fixture: string): EditCase[] {
  const dir = join(fixtureDir, "edits");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((entry) => entry.endsWith(".edit.json"))
    .sort()
    .map((entry) => {
      const name = entry.slice(0, -".edit.json".length);
      const parsed = JSON.parse(readFileSync(join(dir, entry), "utf8")) as Omit<
        EditCase,
        "name" | "fixture" | "dir" | "diffPath" | "expectedDiff"
      >;
      const diffPath = join(dir, `${name}.expected.diff`);
      return {
        ...parsed,
        name,
        fixture,
        dir,
        diffPath,
        expectedDiff: existsSync(diffPath) ? readFileSync(diffPath, "utf8") : null,
      };
    });
}
