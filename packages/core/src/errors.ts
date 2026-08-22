/** Typed errors so callers (UI, CLI, tests) can branch on `code`, not on message text. */

export type CodeFlowErrorCode =
  | "invalid-tool-name"
  | "invalid-function-name"
  | "invalid-node-type"
  | "invalid-schema"
  | "invalid-editable-field"
  | "invalid-module-path"
  | "duplicate-tool"
  | "duplicate-function"
  | "duplicate-node"
  | "function-not-found"
  | "function-in-use"
  /* patch engine — 06-patch-engine.md */
  /** No graph in the session yet, or the node id is unknown. */
  | "patch-node-not-found"
  /** The field/node cannot be edited safely (06 §1) — never guessed at. */
  | "patch-not-editable"
  /** The edit is outside the MVP scope (06 §2) — said out loud, never approximated. */
  | "patch-unsupported"
  /** Source or registry moved since the graph was loaded (06 §5). */
  | "patch-conflict"
  /** Deleting the node would break a downstream binding (06 §2). */
  | "patch-dependency"
  /** The candidate source failed validation — nothing was written (06 §4). */
  | "patch-invalid"
  | "not-implemented";

export class CodeFlowError extends Error {
  readonly code: CodeFlowErrorCode;

  constructor(code: CodeFlowErrorCode, message: string) {
    super(message);
    this.name = "CodeFlowError";
    this.code = code;
  }
}

export function notImplemented(what: string, phase: number): CodeFlowError {
  return new CodeFlowError("not-implemented", `${what}: not implemented (phase ${phase})`);
}
