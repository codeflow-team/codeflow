/**
 * Analyzer entry point — code → `WorkflowGraph` (04-analyzer.md).
 *
 * Cold analyze only: this produces a graph that is a pure function of
 * (source, registry), ids included (invariant I2). Carrying ids across a
 * re-analyze inside a session is identity resolution — Phase 3.
 */

import { Node, type SourceFile } from "ts-morph";
import type {
  AnalyzeOptions,
  Diagnostic,
  WorkflowGraph,
  WorkflowNode,
} from "../model/index.js";
import type { RegistryLookup } from "../registry/lookup.js";
import { sha256Hex } from "../util/sha256.js";
import {
  FLOW_ROOT,
  PathScope,
  computeGraphId,
  mappingForPoint,
  mappingFromRange,
  fingerprintSynthetic,
  withRole,
} from "../mapper/index.js";
import { TsMorphParser, isTsSyntaxTree, type TsMorphParserOptions } from "../parser/ts-morph-parser.js";
import { CodeFlowError } from "../errors.js";
import { Scope, type AnalysisContext, type Frame } from "./context.js";
import { addNode, connectAll } from "./builder.js";
import { materializeScopes } from "./scopes.js";
import { checkFlowContract, type FlowFunction } from "./flow-contract.js";
import { emitSequence } from "./emit.js";

export const DEFAULT_ANALYZE_FILE = "flow.ts";

export interface AnalyzeFlowOptions extends AnalyzeOptions {
  /** Graph version — the session bumps it on each re-analyze (03 §1). */
  version?: number;
}

/**
 * Register imports and file-level function declarations in the flow scope.
 * A library-function import is one whose *registered* definition declares the
 * module it was imported from; everything else is a foreign import (01 §4).
 */
function collectModuleBindings(
  sourceFile: SourceFile,
  scope: Scope,
  registry: RegistryLookup,
  flow: FlowFunction | null,
  localFunctions: Map<string, Node>,
): void {
  for (const declaration of sourceFile.getImportDeclarations()) {
    if (declaration.isTypeOnly()) continue;
    const modulePath = declaration.getModuleSpecifierValue();

    for (const specifier of declaration.getNamedImports()) {
      if (specifier.isTypeOnly()) continue;
      const imported = specifier.getName();
      const local = specifier.getAliasNode()?.getText() ?? imported;
      const definition = registry.getFunction(imported);
      if (definition !== undefined && definition.modulePath === modulePath) {
        scope.declare({
          name: local,
          kind: "library-function",
          modulePath,
          functionName: imported,
          writers: [],
        });
      } else {
        scope.declare({ name: local, kind: "foreign-import", modulePath, writers: [] });
      }
    }

    const defaultImport = declaration.getDefaultImport();
    if (defaultImport !== undefined) {
      scope.declare({ name: defaultImport.getText(), kind: "foreign-import", modulePath, writers: [] });
    }
    const namespaceImport = declaration.getNamespaceImport();
    if (namespaceImport !== undefined) {
      scope.declare({ name: namespaceImport.getText(), kind: "foreign-import", modulePath, writers: [] });
    }
  }

  for (const declaration of sourceFile.getFunctions()) {
    if (declaration === flow) continue;
    const name = declaration.getName();
    if (name === undefined) continue;
    localFunctions.set(name, declaration);
    scope.declare({ name, kind: "local-function", writers: [] });
  }
}

/** Anything that can hand the analyzer a ts-morph backed syntax tree (02 §3). */
export interface AnalyzeParser {
  parse(source: string, file?: string): unknown;
}

export function analyzeSource(
  source: string,
  registry: RegistryLookup,
  options: AnalyzeFlowOptions = {},
  parser?: AnalyzeParser,
): WorkflowGraph {
  const file = options.file ?? DEFAULT_ANALYZE_FILE;
  const parserOptions: TsMorphParserOptions = { file };
  const tree = (parser ?? new TsMorphParser(parserOptions)).parse(source, file);
  if (typeof tree !== "object" || tree === null || !isTsSyntaxTree(tree as never)) {
    throw new CodeFlowError(
      "not-implemented",
      "The analyzer requires a ts-morph backed syntax tree; the supplied parser returned something else.",
    );
  }
  const sourceFile = (tree as { sourceFile: SourceFile }).sourceFile;

  const contract = checkFlowContract(sourceFile, file);
  const diagnostics: Diagnostic[] = [...contract.diagnostics];

  const ctx: AnalysisContext = {
    file,
    sourceFile,
    registry,
    nodes: [],
    edges: [],
    diagnostics,
    toolsParam: null,
    localFunctions: new Map(),
    dataEdgeKeys: new Set(),
    controlEdgeKeys: new Set(),
    scopeCaptures: [],
  };

  const flow = contract.flow;
  if (flow !== null) {
    const scope = new Scope(null);
    collectModuleBindings(sourceFile, scope, registry, flow, ctx.localFunctions);
    analyzeFlowBody(ctx, flow, scope, options);
  }

  const contentHash = sha256Hex(source);
  return {
    id: computeGraphId(file, contentHash, registry.registryHash()),
    version: options.version ?? 1,
    source: { file, content: source, contentHash },
    registryHash: registry.registryHash(),
    nodes: ctx.nodes,
    edges: ctx.edges,
    diagnostics: ctx.diagnostics,
    // Materialised last: `FlowBinding.writers` keeps growing during the walk
    // (03 §6 union of writers) — see analyzer/scopes.ts.
    scopes: materializeScopes(ctx),
  };
}

function analyzeFlowBody(
  ctx: AnalysisContext,
  flow: FlowFunction,
  scope: Scope,
  options: AnalyzeFlowOptions,
): void {
  const parameters = flow.getParameters();
  const inputParameter = parameters[0];
  const toolsParameter = parameters[1];

  if (toolsParameter !== undefined) {
    ctx.toolsParam = toolsParameter.getName();
    scope.declare({
      name: ctx.toolsParam,
      kind: "tools",
      toolsPrefix: [],
      writers: [],
      parameter: true,
    });
  }

  const trigger = emitTrigger(ctx, flow, options);
  if (inputParameter !== undefined) {
    // `input` is a flow parameter *and* the trigger's output port: the trigger
    // is a real node in the graph, so a drag from it has somewhere to come from.
    scope.declare({
      name: inputParameter.getName(),
      kind: "value",
      writers: [{ nodeId: trigger.id, port: inputParameter.getName() }],
      parameter: true,
    });
  }

  const body = flow.getBody();
  if (body === undefined || !Node.isBlock(body)) return;

  const frame: Frame = {
    scope,
    path: new PathScope(FLOW_ROOT),
    parentId: null,
    parentSlot: null,
    sink: null,
    sinkLoopDepth: 0,
    sinkLabels: new Set<string>(),
  };

  const exits = emitSequence(ctx, frame, body.getStatements(), [{ nodeId: trigger.id }]);

  // A flow with no explicit `return` gets a synthetic output node at the end of
  // the body (04 §2.10). When every path already returned, there is nothing to
  // fall through to and no synthetic node is created.
  if (exits.length === 0) return;
  const closeBrace = body.getEnd();
  const output = addNode(ctx, frame, {
    type: "output",
    label: "End Flow",
    mapping: mappingForPoint(
      ctx.file,
      ctx.sourceFile,
      Math.max(closeBrace - 1, body.getStart()),
      closeBrace,
      withRole(FLOW_ROOT, "output"),
      "output",
    ),
    synthetic: true,
    data: { explicit: false, expression: null },
  });
  connectAll(ctx, exits, output.id);
}

function emitTrigger(
  ctx: AnalysisContext,
  flow: FlowFunction,
  options: AnalyzeFlowOptions,
): WorkflowNode {
  const parameters = flow.getParameters();
  const inputParameter = parameters[0];
  const inputName = inputParameter?.getName() ?? "input";
  const inputType = inputParameter?.getTypeNode()?.getText() ?? null;

  // The trigger maps to the flow signature — the construct that produced it (03 §4).
  const body = flow.getBody();
  const start = flow.getStart();
  const end = body === undefined ? flow.getEnd() : body.getStart();
  const semanticPath = withRole(FLOW_ROOT, "trigger");

  // A fresh, empty scope: nothing in the flow has run yet, so the trigger's
  // scope table is empty — it *produces* `input`, it cannot read it (03 §6).
  const frame: Frame = {
    scope: new Scope(null),
    path: new PathScope(FLOW_ROOT),
    parentId: null,
    parentSlot: null,
    sink: null,
    sinkLoopDepth: 0,
    sinkLabels: new Set<string>(),
  };

  const meta = options.trigger;
  return addNode(ctx, frame, {
    type: "trigger",
    label: meta?.label ?? "Trigger",
    mapping: mappingFromRange({
      file: ctx.file,
      sourceFile: ctx.sourceFile,
      start,
      end,
      semanticPath,
      fingerprint: fingerprintSynthetic(flow, "trigger"),
    }),
    synthetic: true,
    outputs:
      inputParameter === undefined
        ? []
        : [
            inputType === null
              ? { id: inputName, label: inputName }
              : { id: inputName, label: inputName, schema: inputType },
          ],
    data: {
      paramName: inputName,
      inputType,
      triggerKind: meta?.kind ?? null,
      ...(meta?.config === undefined ? {} : { config: meta.config }),
    },
  });
}
