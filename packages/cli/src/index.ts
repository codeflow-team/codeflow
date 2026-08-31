/**
 * `@codeflow-team/cli` — the Node-only half of CodeFlow (02-architecture.md §2).
 *
 * Split from core because it needs fs: core has to stay browser-safe. Everything
 * here is also usable programmatically, so a host app can run the same generate
 * pass its CLI does without shelling out.
 *
 * Implemented: the file-based `FunctionLibraryStore` over the workspace `lib/`,
 * `codeflow generate` (+ `--agent-md`), `codeflow init`, and `codeflow check`
 * (workspace-wide analysis + the usage index behind the library store's guard).
 */

export { FileFunctionLibraryStore } from "./library/file-store.js";
export type { FileFunctionLibraryStoreOptions } from "./library/file-store.js";
export { createLibraryStore } from "./library/store.js";
export type { CreateLibraryStoreOptions } from "./library/store.js";
export {
  MARKER as FUNCTION_FILE_MARKER,
  hasFunctionHeader,
  kebabCase,
  parseFunctionFile,
  serializeFunctionFile,
  stripFunctionHeader,
} from "./library/metadata.js";

export {
  CONFIG_FILENAMES,
  DEFAULT_LAYOUT,
  DEFAULT_MODULE_PATH,
  defineConfig,
  findConfig,
  loadConfigFile,
  loadWorkspace,
  registryFromConfig,
} from "./config.js";
export type {
  CodeflowConfig,
  CodeflowConfigExport,
  LoadWorkspaceOptions,
  Workspace,
} from "./config.js";

export { generate } from "./commands/generate.js";
export type { GenerateOptions, GenerateResult, WrittenFile } from "./commands/generate.js";
export { init } from "./commands/init.js";
export type { InitOptions, InitResult } from "./commands/init.js";
export { check, checkToJson, formatCheck, GENERATED_ARTIFACTS } from "./commands/check.js";
export type {
  CheckOptions,
  CheckResult,
  DiagnosticCounts,
  FlowCheck,
  StaleArtifact,
} from "./commands/check.js";

export {
  buildUsageIndex,
  buildUsageIndexFrom,
  findFlowFiles,
  libraryImportsOf,
  libraryModulePaths,
  loadFlows,
  FLOW_SUFFIX,
} from "./usage.js";
export type {
  BuildUsageIndexOptions,
  FlowFile,
  FunctionUsage,
  LoadedFlow,
  UsageIndex,
} from "./usage.js";

export { agentMarkdown, AGENT_MD_BEGIN, AGENT_MD_END } from "./agent-md.js";
export { FLOW_STYLE_MD, FLOW_STYLE_FILENAME } from "./prompts.js";

export { run, USAGE } from "./run.js";
export type { Io } from "./run.js";

export { CliError } from "./errors.js";
export type { CliErrorCode } from "./errors.js";
