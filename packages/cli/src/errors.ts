/**
 * CLI-level errors.
 *
 * The function-library guards reuse `CodeFlowError` from core (same codes as the
 * in-memory store, so a host can branch on `code` without caring which store it
 * got). Everything that is genuinely CLI-shaped — a missing config, a malformed
 * library file — gets its own code here rather than being squeezed into core's
 * closed union.
 */

export type CliErrorCode =
  | "config-not-found"
  | "invalid-config"
  | "invalid-library-file"
  | "workspace-exists"
  | "usage"
  | "not-implemented";

export class CliError extends Error {
  readonly code: CliErrorCode;

  constructor(code: CliErrorCode, message: string) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}
