/**
 * The workspace's function-library store, with its usage guard wired in.
 *
 * `FileFunctionLibraryStore` refuses to remove a function that flows still use,
 * but it cannot know usage on its own (03-data-model.md §11) — the host supplies
 * the answer. In a workspace, the host is this CLI and the answer is the usage
 * index built from `flows/` (`usage.ts`), so every store the CLI hands out comes
 * with the guard already attached rather than each caller remembering to.
 *
 * The index is built **lazily and once**: scanning and parsing every flow is real
 * work, and `codeflow generate` — which creates a store on every run — never asks
 * the question. A `remove`/`rename` pays for it; nothing else does.
 */

import type { Workspace } from "../config.js";
import { buildUsageIndex, type UsageIndex } from "../usage.js";
import { FileFunctionLibraryStore } from "./file-store.js";

export interface CreateLibraryStoreOptions {
  /**
   * A usage index already built (by `codeflow check`, say). Without one, the
   * store builds it on the first `isInUse` question and reuses it afterwards.
   */
  usageIndex?: UsageIndex;
  /** Drop the usage guard entirely — for a store that will only ever read. */
  usageGuard?: boolean;
}

/** The store for a workspace's `lib/`, with the `isInUse` guard of 03 §11. */
export function createLibraryStore(
  workspace: Workspace,
  options: CreateLibraryStoreOptions = {},
): FileFunctionLibraryStore {
  if (options.usageGuard === false) {
    return new FileFunctionLibraryStore({
      dir: workspace.libDir,
      modulePath: workspace.libModulePath,
    });
  }

  let index: UsageIndex | undefined = options.usageIndex;
  let pending: Promise<UsageIndex> | undefined;

  return new FileFunctionLibraryStore({
    dir: workspace.libDir,
    modulePath: workspace.libModulePath,
    isInUse: async (name) => {
      if (index === undefined) {
        pending ??= buildUsageIndex(workspace);
        index = await pending;
      }
      return index.isInUse(name);
    },
  });
}
