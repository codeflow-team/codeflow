/**
 * Public entry point — `CodeFlowSession`, 02-architecture.md §4.
 *
 * A session holds the registry (+ its hash), the parser/project kept warm, and
 * the most recent graph — the basis for identity continuity (03 §5.0).
 *
 * Phase 1 implements the registry and codegen halves, Phase 2 the analyzer,
 * Phase 3 identity continuity and the graph diff. The patcher and the
 * generation-context builder land in later phases per the build order (08 §2);
 * their methods throw until then rather than returning a plausible lie.
 */

import { notImplemented } from "./errors.js";
import { generateLibDts, type GenerateLibDtsOptions } from "./codegen/lib-dts.js";
import { generateToolsDts, type GenerateToolsDtsOptions } from "./codegen/tools-dts.js";
import { analyzeSource, type AnalyzeParser } from "./analyzer/analyze.js";
import { TsMorphParser } from "./parser/ts-morph-parser.js";
import { applyIdentity, resolveIdentity, type IdentityResolution } from "./mapper/resolve.js";
import { diffGraphs } from "./diff/graph-diff.js";
import type {
  AnalyzeOptions,
  BuildGenerationContextOptions,
  FunctionLibraryStore,
  GenerationContext,
  GraphChange,
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

  /**
   * Diff of the most recent `analyze` against the graph the session held before
   * it (03 §10). Empty before the first analyze, and empty *for* the first
   * analyze: there is nothing to diff against, and the whole graph is returned
   * anyway. Scoped to the session, like identity continuity itself (03 §5.0).
   */
  lastChanges(): GraphChange[];

  /** How the last re-analyze bound ids across (03 §5.2); `null` on a cold analyze. */
  lastResolution(): IdentityResolution | null;

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
  private changes: GraphChange[] = [];
  private resolution: IdentityResolution | null = null;
  /** Kept warm across analyses so re-analyze stays inside the <100ms target (07 §7). */
  private readonly tsParser: TsMorphParser;

  constructor(options: CreateCodeFlowOptions) {
    this.registry = options.registry;
    this.libraryStore = options.libraryStore;
    this.parser = options.parser;
    this.tsParser = new TsMorphParser();
  }

  registryHash(): string {
    return this.registry.registryHash();
  }

  getGraph(): WorkflowGraph | null {
    return this.graph;
  }

  lastChanges(): GraphChange[] {
    return [...this.changes];
  }

  lastResolution(): IdentityResolution | null {
    return this.resolution;
  }

  /**
   * Analyze `source` into a `WorkflowGraph` (04-analyzer.md).
   *
   * The first analyze of a session is **cold**: the graph is a pure function of
   * (source, registry), node ids included (I2). Every analyze after that is a
   * cold analysis followed by identity resolution against the graph the session
   * holds (03 §5.0, §5.2) — surviving nodes keep their ids, `data.parentId` and
   * edge endpoints are remapped with them, and the resulting diff is available
   * from `lastChanges()`. `version` increments either way.
   *
   * Session ids may therefore differ from what a cold analyze of the same source
   * would produce. That is the point: I2 promises determinism on the cold path,
   * a session promises continuity.
   */
  async analyze(source: string, options?: AnalyzeOptions): Promise<WorkflowGraph> {
    const previous = this.graph;
    const version = (previous?.version ?? 0) + 1;
    const parser = (this.parser ?? this.tsParser) as AnalyzeParser;
    const cold = analyzeSource(source, this.registry, { ...options, version }, parser);

    if (previous === null) {
      this.graph = cold;
      this.changes = [];
      this.resolution = null;
      return cold;
    }

    const resolution = resolveIdentity(previous, cold, { provenance: options?.provenance });
    const graph = applyIdentity(cold, resolution);
    this.resolution = resolution;
    this.changes = diffGraphs(previous, graph);
    this.graph = graph;
    return graph;
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
