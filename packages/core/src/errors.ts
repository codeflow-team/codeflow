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
