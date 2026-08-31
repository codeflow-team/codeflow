/**
 * What this Node can do, for the tests that need more than the packages do.
 *
 * The demo runner writes `flow.ts` and `lib.ts` into a scratch directory and
 * starts `new Worker(".../worker.ts")` on them. That works because Node strips
 * TypeScript types itself — unflagged from 22.18 and 23.6 — and it is the same
 * capability `codeflow.config.ts` depends on (packages/cli/src/config.ts).
 *
 * Below that floor those tests cannot run at all: the worker dies with
 * ERR_UNKNOWN_FILE_EXTENSION before a single frame is emitted. Everything the
 * repository *publishes* builds and tests on Node 20, so the honest arrangement
 * is a skip that says which tests were not run and why — not a silent pass, and
 * not a red CI on a version that is genuinely supported for what ships.
 */

/** True when `new Worker("….ts")` can load a TypeScript file directly. */
export function stripsTypesNatively(version: string = process.versions.node): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number.parseInt(part, 10));
  if (Number.isNaN(major)) return false;
  if (major >= 24) return true;
  if (major === 23) return minor >= 6;
  if (major === 22) return minor >= 18;
  return false;
}

export const TYPE_STRIPPING_REASON =
  `Node ${process.versions.node} cannot load a .ts file directly; the demo runner's worker needs 22.18+ or 23.6+`;
