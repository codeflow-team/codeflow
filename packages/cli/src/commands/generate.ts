/**
 * `codeflow generate` — 10-ai-codegen.md §2/§3, 05-registry.md §2.
 *
 * Registry (from `codeflow.config.ts`) + function library (from `lib/`) →
 * `generated/tools.d.ts` and `generated/lib.d.ts`, each carrying the
 * `registryHash` of the registry it came from. Those files are derived artifacts:
 * one source, one direction, and drift is detectable rather than silent.
 */

import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCodeFlow, type Registry } from "@codeflow-team/core";
import type { FileFunctionLibraryStore } from "../library/file-store.js";
import { agentMarkdown } from "../agent-md.js";
import { loadWorkspace, registryFromConfig, type Workspace } from "../config.js";
import { createLibraryStore } from "../library/store.js";
import { FLOW_STYLE_FILENAME, FLOW_STYLE_MD } from "../prompts.js";

export interface GenerateOptions {
  /** Where to look for the workspace. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Reuse an already-loaded workspace instead of locating and importing the config again. */
  workspace?: Workspace;
  /** Also produce the `CLAUDE.md`/`AGENTS.md` section (10 §3). */
  agentMd?: boolean;
}

export interface WrittenFile {
  path: string;
  /** Workspace-relative, POSIX separators — what the CLI prints. */
  relativePath: string;
  /** False when the file already had exactly this content. */
  changed: boolean;
}

export interface GenerateResult {
  workspace: Workspace;
  registry: Registry;
  /** The workspace library store, with the `isInUse` guard of 03 §11 attached. */
  store: FileFunctionLibraryStore;
  registryHash: string;
  toolCount: number;
  /** Names of the functions found in `lib/`, in registry order. */
  libraryFunctions: string[];
  files: WrittenFile[];
  /** Present only when `agentMd` was requested. */
  agentMd?: string;
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Writes only on a real change, so unchanged artifacts keep their mtime. */
async function writeIfChanged(workspace: Workspace, file: string, content: string): Promise<WrittenFile> {
  let previous: string | null = null;
  try {
    previous = await readFile(file, "utf8");
  } catch {
    previous = null;
  }
  if (previous !== content) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }
  return {
    path: file,
    relativePath: path.relative(workspace.root, file).split(path.sep).join("/"),
    changed: previous !== content,
  };
}

export async function generate(options: GenerateOptions = {}): Promise<GenerateResult> {
  const workspace = options.workspace ?? (await loadWorkspace({ cwd: options.cwd }));
  const registry = registryFromConfig(workspace.config);

  // Functions live in `lib/` — the file is the storage (05 §4). They are added on
  // top of anything the config declared, and win on a name clash for that reason.
  //
  // The store carries the `isInUse` guard of 03 §11 (built lazily from `flows/`),
  // so a host that reaches for `result` and then removes a function gets the
  // usage check for free; generating itself never asks the question.
  const store = createLibraryStore(workspace);
  const functions = await store.list();
  for (const fn of functions) registry.registerFunction(fn, { overwrite: true });

  const files: WrittenFile[] = [];

  if (functions.length > 0 || (await isDirectory(workspace.libDir))) {
    files.push(await writeIfChanged(workspace, store.indexPath, await store.renderIndex()));
  }

  const session = createCodeFlow({ registry, libraryStore: store });
  const namespaces = workspace.config.namespaces;

  files.push(
    await writeIfChanged(
      workspace,
      path.join(workspace.generatedDir, "tools.d.ts"),
      session.generateToolsDts(namespaces === undefined ? {} : { namespaces }),
    ),
    await writeIfChanged(
      workspace,
      path.join(workspace.generatedDir, "lib.d.ts"),
      session.generateLibDts(),
    ),
  );

  // The style guide is seeded once; a host is expected to tune its copy, so it is
  // never overwritten (10 §1: "copy from lib, host can customise").
  const stylePath = path.join(workspace.promptsDir, FLOW_STYLE_FILENAME);
  if (!(await isFile(stylePath))) {
    files.push(await writeIfChanged(workspace, stylePath, FLOW_STYLE_MD));
  }

  const result: GenerateResult = {
    workspace,
    registry,
    store,
    registryHash: registry.registryHash(),
    toolCount: registry.listTools().length,
    libraryFunctions: functions.map((fn) => fn.name),
    files,
  };
  if (options.agentMd === true) result.agentMd = agentMarkdown(workspace);
  return result;
}

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}
