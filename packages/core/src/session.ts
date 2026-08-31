/**
 * Public entry point — `CodeFlowSession`, 02-architecture.md §4.
 *
 * A session holds the registry (+ its hash), the parser/project kept warm, and
 * the most recent graph — the basis for identity continuity (03 §5.0).
 *
 * Built in the order of 08 §2: registry and codegen (phase 1), the analyzer
 * (2), identity continuity and the graph diff (3), the patch engine (4), and
 * the AI generation surface — `buildGenerationContext` / `validate` (5).
 */

import { CodeFlowError } from "./errors.js";
import { buildGenerationContext } from "./generation/context.js";
import { validateFlowSource, type ValidateFlowOptions } from "./generation/validate.js";
import { computePatch } from "./patcher/patch.js";
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
  PatchNodeOptions,
  PatchResult,
  ScopeBinding,
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

  /**
   * What is in scope **at** `nodeId` — the values the inspector may offer for
   * dragging into one of that node's fields (03 §6, `WorkflowGraph.scopes`).
   *
   * Answers `[]` for an unknown id and before the first analyze rather than
   * throwing: the UI calls this on every selection change, including on a node
   * that has just been deleted, and an empty list is the honest answer there.
   */
  scopeAt(nodeId: string): ScopeBinding[];

  analyze(source: string, options?: AnalyzeOptions): Promise<WorkflowGraph>;
  /**
   * Apply one edit to a node and patch it back into the source (06 §4).
   * Refusals are thrown as `CodeFlowError`s with a `patch-*` code — the caller
   * always learns *why*, and the source is never half-written.
   */
  patchNode(
    nodeId: string,
    changes: Record<string, unknown>,
    options?: PatchNodeOptions,
  ): Promise<PatchResult>;
  /** Score AI output against the conformance ladder (10 §5). Never mutates the session. */
  validate(source: string, options?: ValidateFlowOptions): Promise<ValidationResult>;
  /** Everything the AI needs to see to write a flow against this registry (10 §1). */
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
  /**
   * Options of the last analyze, minus `provenance` (which belongs to one patch,
   * never to the session). A re-analyze triggered by a patch has to see the same
   * file path and trigger metadata, or the graph would change for reasons the
   * user did not ask for.
   */
  private lastOptions: AnalyzeOptions = {};
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

  scopeAt(nodeId: string): ScopeBinding[] {
    return this.graph?.scopes[nodeId] ?? [];
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
    const { provenance: _provenance, ...sticky } = options ?? {};
    this.lastOptions = sticky;
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

  /**
   * Score `source` on the conformance ladder of 10 §5 — the check a host runs on
   * AI output before showing it to anyone.
   *
   * Deliberately side-effect free: the session's graph, identity continuity and
   * diff are left exactly as they were. Validation answers "is this code good
   * enough", not "this is the flow we are now editing"; a host that accepts the
   * result calls `analyze` (or `patchNode`) afterwards.
   */
  async validate(source: string, options: ValidateFlowOptions = {}): Promise<ValidationResult> {
    const { level, diagnostics } = validateFlowSource(source, this.registry, {
      parser: this.tsParser,
      ...(this.lastOptions.file === undefined ? {} : { file: this.lastOptions.file }),
      ...options,
    });
    return { level, diagnostics };
  }

  /**
   * Edit a node and patch the change back into the source (06 §4).
   *
   * Conflict detection runs first (06 §5): the registry must still be the one
   * the graph was analyzed against, and — when the host hands over a newer file
   * — the graph is re-analyzed and the node's **raw text** compared, so an edit
   * made outside CodeFlow is never silently overwritten.
   *
   * The patch itself is computed on a candidate source and only committed once
   * it parses and re-analyzes cleanly; the re-analyze carries patch provenance,
   * so every other node keeps its id exactly (03 §5.2 step 0).
   */
  async patchNode(
    nodeId: string,
    changes: Record<string, unknown>,
    options: PatchNodeOptions = {},
  ): Promise<PatchResult> {
    let graph = this.graph;
    if (graph === null) {
      throw new CodeFlowError(
        "patch-node-not-found",
        "Nothing has been analyzed in this session yet — call analyze() before patchNode().",
      );
    }

    // 0 — the graph is a function of (source, registry); a moved registry makes
    // it stale no matter what the source says (06 §5.0).
    if (graph.registryHash !== this.registry.registryHash()) {
      throw new CodeFlowError(
        "patch-conflict",
        "The registry changed since this graph was analyzed — re-analyze the flow before editing (06 §5).",
      );
    }

    // 1–4 — the file may have moved under us.
    if (options.source !== undefined && options.source !== graph.source.content) {
      const previous = graph.nodes.find((node) => node.id === nodeId);
      if (previous === undefined) {
        throw new CodeFlowError(
          "patch-node-not-found",
          `No node "${nodeId}" in the current graph — re-analyze before editing.`,
        );
      }
      const before = graph.source.content.slice(
        previous.source.start.offset,
        previous.source.end.offset,
      );
      graph = await this.analyze(options.source, this.lastOptions);
      const current = graph.nodes.find((node) => node.id === nodeId);
      if (current === undefined) {
        throw new CodeFlowError(
          "patch-conflict",
          "This node no longer exists after re-analyzing the changed file — reload the workflow before editing (06 §5).",
        );
      }
      const after = options.source.slice(current.source.start.offset, current.source.end.offset);
      // Raw text, not the fingerprint: a fingerprint drops trivia and would miss
      // a comment change that a region-replacing patch would overwrite (06 §5).
      if (before !== after) {
        throw new CodeFlowError(
          "patch-conflict",
          "This node changed since the workflow was loaded — reload the workflow before editing (06 §5).",
        );
      }
    }

    const computed = computePatch({
      graph,
      registry: this.registry,
      nodeId,
      changes,
      ...(this.lastOptions.trigger === undefined ? {} : { analyzeOptions: { trigger: this.lastOptions.trigger } }),
    });

    if (computed.patches.length === 0) {
      // Empty edit: not one byte changes, and the graph is left exactly as it is (I4).
      return {
        source: graph.source.content,
        patches: [],
        graph,
        diagnostics: computed.diagnostics,
        changes: [],
      };
    }

    const next = await this.analyze(computed.source, {
      ...this.lastOptions,
      provenance: computed.provenance,
    });

    return {
      source: computed.source,
      patches: computed.patches,
      graph: next,
      diagnostics: [...computed.diagnostics, ...next.diagnostics],
      changes: this.lastChanges(),
    };
  }

  async buildGenerationContext(
    options: BuildGenerationContextOptions = {},
  ): Promise<GenerationContext> {
    return buildGenerationContext(this.registry, options);
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
