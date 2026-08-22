/**
 * `codeflow init` — scaffolds the standard workspace layout of 10-ai-codegen.md §2.
 *
 * Not part of the MVP feature list; it exists so that the layout every other piece
 * of tooling assumes can be produced in one command, for demos and for tests.
 * It only scaffolds — `generated/` and `prompts/` are produced by
 * `codeflow generate`, which is the single code path that writes them.
 */

import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { CliError } from "../errors.js";
import { FileFunctionLibraryStore } from "../library/file-store.js";
import {
  CONFIG_TEMPLATE,
  FLOWS_README,
  SAMPLE_FUNCTION,
  TSCONFIG_TEMPLATE,
  packageJsonTemplate,
} from "../templates.js";

export interface InitOptions {
  /** Target directory. Defaults to `process.cwd()`. Created if missing. */
  cwd?: string;
  /** Overwrite files that already exist. Without it, an existing config aborts. */
  force?: boolean;
}

export interface InitResult {
  root: string;
  /** Workspace-relative paths of the files written. */
  files: string[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function init(options: InitOptions = {}): Promise<InitResult> {
  const root = path.resolve(options.cwd ?? process.cwd());
  const configPath = path.join(root, "codeflow.config.ts");

  if (options.force !== true && (await exists(configPath))) {
    throw new CliError(
      "workspace-exists",
      `${configPath} already exists — pass --force to overwrite the scaffold.`,
    );
  }

  const files: string[] = [];
  const write = async (relative: string, content: string): Promise<void> => {
    const file = path.join(root, relative);
    if (options.force !== true && (await exists(file))) return;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
    files.push(relative);
  };

  await mkdir(root, { recursive: true });
  await write("package.json", packageJsonTemplate(path.basename(root)));
  await write("codeflow.config.ts", CONFIG_TEMPLATE);
  await write("tsconfig.json", TSCONFIG_TEMPLATE);
  await write("flows/README.md", FLOWS_README);

  // The sample function goes through the store, so its file looks exactly like one
  // saved from the UI later — the file is the storage, there is no special case.
  const store = new FileFunctionLibraryStore({ dir: path.join(root, "lib") });
  if (options.force === true || (await store.get(SAMPLE_FUNCTION.name)) === null) {
    await store.save(SAMPLE_FUNCTION, { overwrite: true });
    files.push("lib/is-auth-change.ts", "lib/index.ts");
  }

  return { root, files };
}
