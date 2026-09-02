/**
 * The registry — 05-registry.md.
 *
 * Everything that can become a node is declared here: tools/MCP, library
 * functions, plugin node types. Core ships no tool of its own (design principle
 * 6b): an empty registry is valid, every call then degrades to unknown/code.
 */

import { CodeFlowError } from "../errors.js";
import type { SemanticAnalyzer } from "../model/plugin.js";
import type {
  FunctionDefinition,
  NodeDefinition,
  RegisteredFunction,
  RegisteredNode,
  RegisteredTool,
  ToolDefinition,
} from "./definitions.js";
import { computeRegistryHash } from "./hash.js";
import type { RegistryLookup } from "./lookup.js";
import {
  normalizeEditableFields,
  validateFunctionInputSchema,
  validateFunctionName,
  validateModulePath,
  validateNodeType,
  validateToolName,
} from "./validate.js";

export interface RegisterOptions {
  /** Registering over an existing entry is rejected unless this is set. */
  overwrite?: boolean;
}

export interface RegistryInit {
  tools?: ToolDefinition[];
  functions?: FunctionDefinition[];
  nodes?: NodeDefinition[];
  analyzers?: SemanticAnalyzer[];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export class Registry implements RegistryLookup {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly functions = new Map<string, RegisteredFunction>();
  private readonly nodes = new Map<string, RegisteredNode>();
  private readonly analyzers: SemanticAnalyzer[] = [];
  private cachedHash: string | null = null;

  constructor(init: RegistryInit = {}) {
    for (const tool of init.tools ?? []) this.registerTool(tool);
    for (const fn of init.functions ?? []) this.registerFunction(fn);
    for (const node of init.nodes ?? []) this.registerNode(node);
    for (const analyzer of init.analyzers ?? []) this.registerAnalyzer(analyzer);
  }

  registerTool(def: ToolDefinition, opts: RegisterOptions = {}): void {
    validateToolName(def.name);
    if (this.tools.has(def.name) && opts.overwrite !== true) {
      throw new CodeFlowError(
        "duplicate-tool",
        `Tool "${def.name}" is already registered — pass { overwrite: true } to replace it.`,
      );
    }
    const registered: RegisteredTool = {
      ...def,
      editableFields: normalizeEditableFields(def.editableFields),
    };
    this.tools.set(def.name, registered);
    this.invalidate();
  }

  registerFunction(def: FunctionDefinition, opts: RegisterOptions = {}): void {
    validateFunctionName(def.name);
    validateFunctionInputSchema(def.name, def.inputSchema);
    validateModulePath(def.modulePath);
    if (this.functions.has(def.name) && opts.overwrite !== true) {
      throw new CodeFlowError(
        "duplicate-function",
        `Function "${def.name}" is already registered — pass { overwrite: true } to replace it.`,
      );
    }
    const registered: RegisteredFunction = {
      ...def,
      editableFields: normalizeEditableFields(def.editableFields),
      // Said once here so nothing downstream has to re-decide what "unset"
      // means: a definition that does not choose is called positionally (05 §4).
      argumentStyle: def.argumentStyle ?? "positional",
    };
    this.functions.set(def.name, registered);
    this.invalidate();
  }

  registerNode(def: NodeDefinition, opts: RegisterOptions = {}): void {
    validateNodeType(def.type);
    if (this.nodes.has(def.type) && opts.overwrite !== true) {
      throw new CodeFlowError(
        "duplicate-node",
        `Node type "${def.type}" is already registered — pass { overwrite: true } to replace it.`,
      );
    }
    const registered: RegisteredNode = {
      ...def,
      editableFields: normalizeEditableFields(def.editableFields),
    };
    this.nodes.set(def.type, registered);
    this.invalidate();
  }

  registerAnalyzer(fn: SemanticAnalyzer): void {
    this.analyzers.push(fn);
    // Analyzers are behaviour, not identity — they do not affect registryHash.
  }

  unregisterTool(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) this.invalidate();
    return removed;
  }

  unregisterFunction(name: string): boolean {
    const removed = this.functions.delete(name);
    if (removed) this.invalidate();
    return removed;
  }

  unregisterNode(type: string): boolean {
    const removed = this.nodes.delete(type);
    if (removed) this.invalidate();
    return removed;
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  listTools(): RegisteredTool[] {
    return [...this.tools.values()].sort((a, b) => compare(a.name, b.name));
  }

  listToolNamespaces(): string[] {
    const namespaces = new Set<string>();
    for (const tool of this.tools.values()) {
      const dot = tool.name.indexOf(".");
      namespaces.add(tool.name.slice(0, dot));
    }
    return [...namespaces].sort(compare);
  }

  getFunction(name: string): RegisteredFunction | undefined {
    return this.functions.get(name);
  }

  listFunctions(): RegisteredFunction[] {
    return [...this.functions.values()].sort((a, b) => compare(a.name, b.name));
  }

  listFunctionModulePaths(): string[] {
    const paths = new Set<string>();
    for (const fn of this.functions.values()) paths.add(fn.modulePath);
    return [...paths].sort(compare);
  }

  listFunctionsByModule(modulePath: string): RegisteredFunction[] {
    return this.listFunctions().filter((fn) => fn.modulePath === modulePath);
  }

  getNode(type: string): RegisteredNode | undefined {
    return this.nodes.get(type);
  }

  listNodes(): RegisteredNode[] {
    return [...this.nodes.values()].sort((a, b) => compare(a.type, b.type));
  }

  listAnalyzers(): SemanticAnalyzer[] {
    return [...this.analyzers];
  }

  registryHash(): string {
    this.cachedHash ??= computeRegistryHash({
      tools: this.listTools(),
      functions: this.listFunctions(),
      nodes: this.listNodes(),
    });
    return this.cachedHash;
  }

  private invalidate(): void {
    this.cachedHash = null;
  }
}

export function createRegistry(init: RegistryInit = {}): Registry {
  return new Registry(init);
}
