/**
 * In-memory `FunctionLibraryStore` — 03-data-model.md §11, 05-registry.md §4.
 *
 * For tests and for the browser. The default file-based store (workspace `lib/`,
 * where the file itself is the only storage) is Node-only and lives in the CLI
 * package, so core stays browser-safe.
 */

import { CodeFlowError } from "../errors.js";
import type {
  FunctionLibraryStore,
  RemoveFunctionOptions,
  SaveFunctionOptions,
} from "../model/library.js";
import type { FunctionDefinition } from "../registry/definitions.js";
import {
  validateFunctionInputSchema,
  validateFunctionName,
  validateModulePath,
} from "../registry/validate.js";

export interface InMemoryFunctionLibraryStoreOptions {
  initial?: FunctionDefinition[];
  /**
   * Usage check (03 §11): removing a function that flows still call must be
   * refused unless the user confirmed. The store cannot know usage on its own —
   * the host (`codeflow check`, or a scan of the open flows) supplies it.
   */
  isInUse?: (name: string) => boolean | Promise<boolean>;
}

export class InMemoryFunctionLibraryStore implements FunctionLibraryStore {
  private readonly functions = new Map<string, FunctionDefinition>();
  private readonly isInUse: ((name: string) => boolean | Promise<boolean>) | undefined;

  constructor(options: InMemoryFunctionLibraryStoreOptions = {}) {
    this.isInUse = options.isInUse;
    for (const def of options.initial ?? []) {
      this.validate(def);
      this.functions.set(def.name, { ...def });
    }
  }

  async list(): Promise<FunctionDefinition[]> {
    return [...this.functions.values()]
      .map((def) => ({ ...def }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  }

  async get(name: string): Promise<FunctionDefinition | null> {
    const def = this.functions.get(name);
    return def === undefined ? null : { ...def };
  }

  async save(def: FunctionDefinition, opts: SaveFunctionOptions = {}): Promise<void> {
    this.validate(def);
    if (this.functions.has(def.name) && opts.overwrite !== true) {
      throw new CodeFlowError(
        "duplicate-function",
        `Function "${def.name}" already exists in the library — save with { overwrite: true } to replace it.`,
      );
    }
    this.functions.set(def.name, { ...def });
  }

  async remove(name: string, opts: RemoveFunctionOptions = {}): Promise<void> {
    if (!this.functions.has(name)) {
      throw new CodeFlowError("function-not-found", `Function "${name}" is not in the library.`);
    }
    if (opts.force !== true && this.isInUse !== undefined && (await this.isInUse(name))) {
      throw new CodeFlowError(
        "function-in-use",
        `Function "${name}" is still used by at least one flow — resolve the usages or remove with { force: true }.`,
      );
    }
    this.functions.delete(name);
  }

  /**
   * Renaming does NOT rewrite flows importing the old name — that is a patch per
   * flow (`codeflow check` lists them; the host/user decides). It also leaves the
   * declaration inside `code` untouched: rewriting source is the patch engine's job.
   */
  async rename(oldName: string, newName: string): Promise<void> {
    const def = this.functions.get(oldName);
    if (def === undefined) {
      throw new CodeFlowError("function-not-found", `Function "${oldName}" is not in the library.`);
    }
    validateFunctionName(newName);
    if (oldName === newName) return;
    if (this.functions.has(newName)) {
      throw new CodeFlowError(
        "duplicate-function",
        `Cannot rename "${oldName}" to "${newName}": that name already exists in the library.`,
      );
    }
    this.functions.delete(oldName);
    this.functions.set(newName, { ...def, name: newName });
  }

  private validate(def: FunctionDefinition): void {
    validateFunctionName(def.name);
    validateFunctionInputSchema(def.name, def.inputSchema);
    validateModulePath(def.modulePath);
  }
}
