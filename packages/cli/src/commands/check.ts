/**
 * `codeflow check` — NOT IMPLEMENTED YET.
 *
 * The command scans `flows/`, analyzes every flow against the current registry and
 * reports workspace-wide diagnostics. That is the mechanism for catching cross-flow
 * breakage when a tool or a library function changes or disappears (05-registry.md
 * §2/§4), and the usage check that must run before a `remove`/`rename` on the
 * function library (03-data-model.md §11).
 *
 * All of it needs the semantic analyzer — phase 2 of the build order (08-mvp.md §2),
 * `CodeFlowSession.analyze` currently throws `not-implemented`. So this command
 * says so and exits non-zero: "not implemented" must never be mistaken for
 * "checked, nothing wrong".
 *
 * TODO once the analyzer lands:
 *  1. load the workspace + registry exactly like `generate` does;
 *  2. compare the `registryHash` header of `generated/*.d.ts` with the current
 *     registry → `stale-generated-artifacts` error telling the user to run
 *     `codeflow generate` (05 §2, 03 §7);
 *  3. glob `flows/**\/*.flow.ts`, `session.analyze()` each, collect `Diagnostic[]`;
 *  4. print them grouped by file with severity, code, line/column and the fix hint;
 *  5. exit 1 when any diagnostic has severity `error`;
 *  6. expose the usage index it builds as the `isInUse` hook of
 *     `FileFunctionLibraryStore`, so remove/rename get a real guard instead of the
 *     host having to supply one;
 *  7. `--json` output for CI, `--watch` for the dev loop.
 */

import { CliError } from "../errors.js";

export const CHECK_NOTICE =
  "codeflow check: requires analyzer (coming) — the semantic analyzer is phase 2 of the build order (08-mvp.md §2) and is not implemented yet.\n" +
  "Once it lands, `codeflow check` will analyze every flow in flows/, report workspace-wide diagnostics, flag generated/*.d.ts that no longer match the registry, and answer 'is this library function still used?' before a remove or rename.";

export interface CheckOptions {
  cwd?: string;
}

export async function check(_options: CheckOptions = {}): Promise<never> {
  throw new CliError("not-implemented", CHECK_NOTICE);
}
