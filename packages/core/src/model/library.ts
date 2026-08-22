/**
 * Function library storage — 03-data-model.md §11, 05-registry.md §4.
 * Host apps implement this. Core ships an in-memory implementation; the default
 * file-based store (workspace `lib/`) lives in the CLI package (Node-only).
 */

import type { FunctionDefinition } from "../registry/definitions.js";

export interface SaveFunctionOptions {
  /** Without it, saving over an existing name is rejected (UI shows a conflict prompt). */
  overwrite?: boolean;
}

export interface RemoveFunctionOptions {
  /**
   * Removing/renaming a function that is in use requires a usage check first
   * (`codeflow check`, or a scan of the open flows) — same safety bar as
   * delete-node in the patch engine. `force` is only set after the user confirms.
   */
  force?: boolean;
}

export interface FunctionLibraryStore {
  list(): Promise<FunctionDefinition[]>;
  get(name: string): Promise<FunctionDefinition | null>;
  save(def: FunctionDefinition, opts?: SaveFunctionOptions): Promise<void>;
  remove(name: string, opts?: RemoveFunctionOptions): Promise<void>;
  /**
   * Does NOT rewrite flows importing the old name — that is a patch per flow
   * (`codeflow check` lists them; host/user decides).
   */
  rename(oldName: string, newName: string): Promise<void>;
}
