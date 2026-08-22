/**
 * Read-only registry surface. Analyzers, patchers and codegen depend on this
 * rather than on the concrete `Registry`, keeping the plugin API narrow.
 */

import type { SemanticAnalyzer } from "../model/plugin.js";
import type { RegisteredFunction, RegisteredNode, RegisteredTool } from "./definitions.js";

export interface RegistryLookup {
  getTool(name: string): RegisteredTool | undefined;
  /** Sorted by name — generated artifacts must not depend on registration order. */
  listTools(): RegisteredTool[];
  listToolNamespaces(): string[];

  getFunction(name: string): RegisteredFunction | undefined;
  listFunctions(): RegisteredFunction[];
  listFunctionModulePaths(): string[];
  listFunctionsByModule(modulePath: string): RegisteredFunction[];

  getNode(type: string): RegisteredNode | undefined;
  listNodes(): RegisteredNode[];

  listAnalyzers(): SemanticAnalyzer[];

  /** Deterministic fingerprint of the registry content — 05 §2. */
  registryHash(): string;
}
