/**
 * @codeflow-team/core — domain model, registry and typed-API codegen.
 *
 * Browser-safe by construction: nothing in this package imports a Node API.
 * Node-only pieces (file-based function library store, fs/watch) live in the CLI.
 */

export * from "./model/index.js";
export * from "./registry/index.js";
export * from "./codegen/index.js";
export * from "./parser/index.js";
export * from "./mapper/index.js";
export * from "./analyzer/index.js";
export * from "./patcher/index.js";
export * from "./diff/index.js";
export * from "./generation/index.js";
export * from "./run/index.js";

export { InMemoryFunctionLibraryStore } from "./library/in-memory-store.js";
export type { InMemoryFunctionLibraryStoreOptions } from "./library/in-memory-store.js";

export { createCodeFlow } from "./session.js";
export type { CodeFlowSession, CreateCodeFlowOptions } from "./session.js";

export { CodeFlowError } from "./errors.js";
export type { CodeFlowErrorCode } from "./errors.js";

export { sha256Hex } from "./util/sha256.js";
export { canonicalJson } from "./util/canonical-json.js";
