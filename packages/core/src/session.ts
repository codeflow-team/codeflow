/**
 * Public entry point — `CodeFlowSession`, 02-architecture.md §4.
 *
 * A session holds the registry (+ its hash), the parser/project kept warm, and
 * the most recent graph — the basis for identity continuity (03 §5.0).
 *
 * Phase 1 implements the registry and codegen halves. Analyzer, patcher and the
 * generation-context builder land in later phases per the build order (08 §2);
 * their methods throw until then rather than returning a plausible lie.
 */

import { notImplemented } from "./errors.js";
import { generateLibDts, type GenerateLibDtsOptions } from "./codegen/lib-dts.js";
import { generateToolsDts, type GenerateToolsDtsOptions } from "./codegen/tools-dts.js";
import type {
  AnalyzeOptions,
  BuildGenerationContextOptions,
  FunctionLibraryStore,
  GenerationContext,
  Parser,
  PatchResult,
  ValidationResult,
  WorkflowGraph,
} from "./model/index.js";
import type { RegistryLookup } from "./registry/lookup.js";

export interface CreateCodeFlowOptions {
  /** Required — the analyzer needs a registry (04 §1). */
  registry: RegistryLookup;
  libraryStore?: FunctionLibraryStore;
  /** Override the `Parser` implementation (02 §3). */
  parser?: Parser;
}

export interface CodeFlowSession {
  readonly registry: RegistryLookup;
  readonly libraryStore: FunctionLibraryStore | undefined;
  readonly parser: Parser | undefined;

  /** Fingerprint of the registry this session analyzes against (05 §2). */
  registryHash(): string;

  /** Most recent graph produced in this session, or `null` before the first analyze. */
  getGraph(): WorkflowGraph | null;

  analyze(source: string, options?: AnalyzeOptions): Promise<WorkflowGraph>;
  patchNode(nodeId: string, changes: Record<string, unknown>): Promise<PatchResult>;
  validate(source: string): Promise<ValidationResult>;
  buildGenerationContext(options?: BuildGenerationContextOptions): Promise<GenerationContext>;

  /** Derived artifacts — `generated/tools.d.ts` and `generated/lib.d.ts` (05 §2). */
  generateToolsDts(options?: GenerateToolsDtsOptions): string;
  generateLibDts(options?: GenerateLibDtsOptions): string;
}

class Session implements CodeFlowSession {
  readonly registry: RegistryLookup;
  readonly libraryStore: FunctionLibraryStore | undefined;
  readonly parser: Parser | undefined;

  private graph: WorkflowGraph | null = null;

  constructor(options: CreateCodeFlowOptions) {
    this.registry = options.registry;
    this.libraryStore = options.libraryStore;
    this.parser = options.parser;
  }

  registryHash(): string {
    return this.registry.registryHash();
  }

  getGraph(): WorkflowGraph | null {
    return this.graph;
  }

  async analyze(_source: string, _options?: AnalyzeOptions): Promise<WorkflowGraph> {
    throw notImplemented("CodeFlowSession.analyze", 2);
  }

  async validate(_source: string): Promise<ValidationResult> {
    throw notImplemented("CodeFlowSession.validate", 2);
  }

  async patchNode(_nodeId: string, _changes: Record<string, unknown>): Promise<PatchResult> {
    throw notImplemented("CodeFlowSession.patchNode", 4);
  }

  async buildGenerationContext(
    _options?: BuildGenerationContextOptions,
  ): Promise<GenerationContext> {
    throw notImplemented("CodeFlowSession.buildGenerationContext", 5);
  }

  generateToolsDts(options: GenerateToolsDtsOptions = {}): string {
    return generateToolsDts(this.registry, options);
  }

  generateLibDts(options: GenerateLibDtsOptions = {}): string {
    return generateLibDts(this.registry, options);
  }
}

export function createCodeFlow(options: CreateCodeFlowOptions): CodeFlowSession {
  return new Session(options);
}
