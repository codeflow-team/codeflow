/**
 * `codeflow.config.ts` — the workspace's declaration of its registry and layout
 * (10-ai-codegen.md §2).
 *
 * The config is code the workspace owner wrote, and the CLI runs it as a build
 * script, exactly like `vite.config.ts` (05-registry.md §6 draws that line
 * explicitly). Flow code, library `code` and anything AI generated are never
 * executed.
 *
 * It is loaded with a plain dynamic `import()`: Node ≥22.6 strips TypeScript
 * types natively, so a `.ts` config needs no build step and no extra dependency.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createRegistry,
  type FunctionDefinition,
  type NodeDefinition,
  type Registry,
  type RegistryInit,
  type RegistryLookup,
  type ToolDefinition,
} from "@codeflow/core";
import { CliError } from "./errors.js";

/** Config file names, in resolution order. */
export const CONFIG_FILENAMES = [
  "codeflow.config.ts",
  "codeflow.config.mts",
  "codeflow.config.js",
  "codeflow.config.mjs",
] as const;

export const DEFAULT_LAYOUT = {
  flowsDir: "flows",
  libDir: "lib",
  generatedDir: "generated",
  promptsDir: "prompts",
} as const;

export const DEFAULT_MODULE_PATH = "@flows/lib";

export interface CodeflowConfig {
  /**
   * Either a live registry (`createRegistry(...)`, or anything implementing
   * `RegistryLookup`) or the plain data to build one from. Combined with the
   * `tools`/`functions`/`nodes` shorthands below.
   */
  registry?: RegistryLookup | RegistryInit;

  /** Shorthand for `registry: { tools }` — the common case. */
  tools?: ToolDefinition[];
  /**
   * Functions declared in config. Functions living in `lib/` are added on top by
   * `codeflow generate` and win on a name clash, since the file is the storage.
   */
  functions?: FunctionDefinition[];
  nodes?: NodeDefinition[];

  /** Layout overrides — all relative to the config file's directory. */
  flowsDir?: string;
  libDir?: string;
  generatedDir?: string;
  promptsDir?: string;

  /** Module specifier library functions are imported from. Default `"@flows/lib"`. */
  libModulePath?: string;

  /** Restrict the tools emitted into `generated/tools.d.ts` — 10 §4. */
  namespaces?: string[];
}

/**
 * What `codeflow.config.ts` may default-export: a config object, a registry, or a
 * (possibly async) function producing either.
 */
export type CodeflowConfigExport =
  | CodeflowConfig
  | RegistryLookup
  | (() => CodeflowConfig | RegistryLookup | Promise<CodeflowConfig | RegistryLookup>);

/** Identity helper for typed configs: `export default defineConfig({ … })`. */
export function defineConfig(config: CodeflowConfig): CodeflowConfig {
  return config;
}

export interface Workspace {
  /** Directory holding `codeflow.config.ts`. */
  root: string;
  configPath: string;
  config: CodeflowConfig;
  flowsDir: string;
  libDir: string;
  generatedDir: string;
  promptsDir: string;
  libModulePath: string;
}

function isRegistryLookup(value: unknown): value is RegistryLookup {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RegistryLookup>;
  return typeof candidate.listTools === "function" && typeof candidate.registryHash === "function";
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * Finds the nearest `codeflow.config.*`, walking up from `from` — so the CLI works
 * from anywhere inside the workspace, not only at its root.
 */
export async function findConfig(from: string): Promise<string | null> {
  let dir = path.resolve(from);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if (await exists(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function importFresh(file: string): Promise<Record<string, unknown>> {
  // Bust the module cache on content change, so a long-lived process (watch mode,
  // a test suite) does not keep serving a stale config.
  const version = await stat(file).then((s) => s.mtimeMs, () => Date.now());
  const url = `${pathToFileURL(file).href}?codeflow=${version}`;
  return (await import(url)) as Record<string, unknown>;
}

function normalize(value: unknown, configPath: string): CodeflowConfig {
  if (isRegistryLookup(value)) return { registry: value };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliError(
      "invalid-config",
      `${configPath}: default export must be a config object, a registry, or a function returning one (got ${Array.isArray(value) ? "an array" : typeof value}).`,
    );
  }
  return value as CodeflowConfig;
}

/** Loads and normalizes a config file. Does not touch the registry. */
export async function loadConfigFile(configPath: string): Promise<CodeflowConfig> {
  const module = await importFresh(configPath);
  const exported = "default" in module ? module["default"] : undefined;
  if (exported === undefined) {
    throw new CliError("invalid-config", `${configPath}: no default export found.`);
  }
  const resolved = typeof exported === "function" ? await (exported as () => unknown)() : exported;
  return normalize(resolved, configPath);
}

export interface LoadWorkspaceOptions {
  /** Directory to start looking for the config from. Defaults to `process.cwd()`. */
  cwd?: string;
}

/** Locates the config, loads it, and resolves the workspace layout (10 §2). */
export async function loadWorkspace(options: LoadWorkspaceOptions = {}): Promise<Workspace> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const configPath = await findConfig(cwd);
  if (configPath === null) {
    throw new CliError(
      "config-not-found",
      `No ${CONFIG_FILENAMES[0]} found in ${cwd} or any parent directory — run \`codeflow init\` to scaffold a workspace.`,
    );
  }
  const config = await loadConfigFile(configPath);
  const root = path.dirname(configPath);
  const resolve = (value: string | undefined, fallback: string): string =>
    path.resolve(root, value ?? fallback);

  return {
    root,
    configPath,
    config,
    flowsDir: resolve(config.flowsDir, DEFAULT_LAYOUT.flowsDir),
    libDir: resolve(config.libDir, DEFAULT_LAYOUT.libDir),
    generatedDir: resolve(config.generatedDir, DEFAULT_LAYOUT.generatedDir),
    promptsDir: resolve(config.promptsDir, DEFAULT_LAYOUT.promptsDir),
    libModulePath: config.libModulePath ?? DEFAULT_MODULE_PATH,
  };
}

/**
 * Builds one `Registry` out of everything the config declares.
 *
 * A supplied `RegistryLookup` is copied into a fresh registry rather than used as
 * is: the CLI has to add the functions found in `lib/` on top, and mutating the
 * host's registry object would be a side effect on someone else's state.
 */
export function registryFromConfig(config: CodeflowConfig): Registry {
  const tools: ToolDefinition[] = [];
  const functions: FunctionDefinition[] = [];
  const nodes: NodeDefinition[] = [];

  if (config.registry !== undefined) {
    if (isRegistryLookup(config.registry)) {
      tools.push(...config.registry.listTools());
      functions.push(...config.registry.listFunctions());
      nodes.push(...config.registry.listNodes());
    } else {
      tools.push(...(config.registry.tools ?? []));
      functions.push(...(config.registry.functions ?? []));
      nodes.push(...(config.registry.nodes ?? []));
    }
  }
  tools.push(...(config.tools ?? []));
  functions.push(...(config.functions ?? []));
  nodes.push(...(config.nodes ?? []));

  const init: RegistryInit = { tools, functions, nodes };
  return createRegistry(init);
}
