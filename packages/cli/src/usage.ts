/**
 * Workspace-wide usage index — "which flow uses which library function".
 *
 * Core is per-flow by design: a `CodeFlowSession` analyzes one file and keeps no
 * index of who calls what (05-registry.md §4, step 4). That is the right scope
 * for an editor, and the wrong scope for two questions the workspace has to
 * answer anyway:
 *
 *  1. `codeflow check` — after a signature change, which flows break;
 *  2. `FunctionLibraryStore.remove` / `rename` — is this function still in use
 *     (03 §11: the guard must run *before* the destructive operation).
 *
 * Both are the same index, built here by reading the `import` statements of every
 * `flows/**\/*.flow.ts`. Imports, not calls, are the signal: an import of a
 * function that no longer exists is exactly the breakage `check` must report, and
 * a flow that imports a function is a flow that a rename would break.
 *
 * The parse goes through core's `TsMorphParser` rather than a regex — an import
 * inside a comment or a string is not an import.
 */

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { TsMorphParser, type TsSyntaxTree } from "@codeflow/core";
import type { Workspace } from "./config.js";

/** Files `codeflow check` treats as flows — 10-ai-codegen.md §2. */
export const FLOW_SUFFIX = ".flow.ts";

export interface FlowFile {
  /** Absolute path. */
  path: string;
  /** Workspace-relative, POSIX separators — what the CLI prints and JSON reports. */
  relativePath: string;
}

export interface LoadedFlow extends FlowFile {
  source: string;
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Every `*.flow.ts` under `dir`, recursively, sorted by path. */
export async function findFlowFiles(dir: string, root: string): Promise<FlowFile[]> {
  const found: FlowFile[] = [];

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        await walk(child);
      } else if (entry.isFile() && entry.name.endsWith(FLOW_SUFFIX)) {
        found.push({ path: child, relativePath: relative(root, child) });
      }
    }
  };

  await walk(dir);
  return found.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
}

/** Reads every flow of the workspace. */
export async function loadFlows(workspace: Workspace): Promise<LoadedFlow[]> {
  const files = await findFlowFiles(workspace.flowsDir, workspace.root);
  return Promise.all(
    files.map(async (file) => ({ ...file, source: await readFile(file.path, "utf8") })),
  );
}

/**
 * Module specifiers that mean "the function library" for a workspace: the
 * configured `libModulePath` plus whatever the registry's functions declare.
 */
export function libraryModulePaths(
  workspace: Workspace,
  extra: readonly string[] = [],
): string[] {
  return [...new Set([workspace.libModulePath, ...extra])];
}

function isLibraryImport(
  specifier: string,
  modulePaths: readonly string[],
  flowFile: string,
  libDir: string,
): boolean {
  if (modulePaths.includes(specifier)) return true;
  // A relative import that lands inside `lib/` is the same dependency written
  // the long way; treating it as foreign would under-report usage.
  if (!specifier.startsWith(".")) return false;
  const resolved = path.resolve(path.dirname(flowFile), specifier);
  const relativeToLib = path.relative(libDir, resolved);
  return relativeToLib === "" || (!relativeToLib.startsWith("..") && !path.isAbsolute(relativeToLib));
}

/**
 * Names a flow imports from the function library — value imports only.
 *
 * `import type { … }` (whole-clause or per-specifier) is not a usage: no value
 * crosses, and nothing in the flow calls it. Aliases report the *imported* name
 * (`import { isAuthChange as check }` uses `isAuthChange`), because that is the
 * name the library owns.
 */
export function libraryImportsOf(
  flow: LoadedFlow,
  modulePaths: readonly string[],
  libDir: string,
  parser: TsMorphParser = new TsMorphParser(),
): string[] {
  const tree: TsSyntaxTree = parser.parse(flow.source, flow.relativePath);
  const names = new Set<string>();

  for (const declaration of tree.sourceFile.getImportDeclarations()) {
    if (declaration.isTypeOnly()) continue;
    const specifier = declaration.getModuleSpecifierValue();
    if (!isLibraryImport(specifier, modulePaths, flow.path, libDir)) continue;
    for (const imported of declaration.getNamedImports()) {
      if (imported.isTypeOnly()) continue;
      names.add(imported.getName());
    }
  }

  return [...names].sort();
}

export interface FunctionUsage {
  functionName: string;
  /** Workspace-relative paths of the flows importing it. */
  flows: string[];
}

export interface UsageIndex {
  /** Function name → flows importing it, both sorted. */
  byFunction: ReadonlyMap<string, string[]>;
  /** Flow path → the library functions it imports. */
  byFlow: ReadonlyMap<string, string[]>;
  /** The `isInUse` hook of `FunctionLibraryStore` (03 §11). */
  isInUse(name: string): boolean;
  /** Every function used by at least one flow, sorted by name. */
  list(): FunctionUsage[];
}

/** Builds the index from flows already in memory — `check` reads each file once. */
export function buildUsageIndexFrom(
  flows: readonly LoadedFlow[],
  modulePaths: readonly string[],
  libDir: string,
): UsageIndex {
  const parser = new TsMorphParser();
  const byFunction = new Map<string, string[]>();
  const byFlow = new Map<string, string[]>();

  for (const flow of flows) {
    const imported = libraryImportsOf(flow, modulePaths, libDir, parser);
    byFlow.set(flow.relativePath, imported);
    for (const name of imported) {
      const flowsUsing = byFunction.get(name) ?? [];
      if (!flowsUsing.includes(flow.relativePath)) flowsUsing.push(flow.relativePath);
      byFunction.set(name, flowsUsing);
    }
  }
  for (const flowsUsing of byFunction.values()) flowsUsing.sort();

  return {
    byFunction,
    byFlow,
    isInUse: (name) => (byFunction.get(name)?.length ?? 0) > 0,
    list: () =>
      [...byFunction.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([functionName, flows]) => ({ functionName, flows: [...flows] })),
  };
}

export interface BuildUsageIndexOptions {
  /** Extra library module specifiers (e.g. every `modulePath` in the registry). */
  modulePaths?: readonly string[];
  /** Flows already read, to avoid a second pass over the directory. */
  flows?: readonly LoadedFlow[];
}

/**
 * Scans `flows/` and answers "which flow uses which library function".
 *
 * Exported as the workspace-level counterpart to core's per-flow analysis, and
 * used directly as the `isInUse` hook of the file-backed library store.
 */
export async function buildUsageIndex(
  workspace: Workspace,
  options: BuildUsageIndexOptions = {},
): Promise<UsageIndex> {
  const flows = options.flows ?? (await loadFlows(workspace));
  return buildUsageIndexFrom(
    flows,
    libraryModulePaths(workspace, options.modulePaths ?? []),
    workspace.libDir,
  );
}
