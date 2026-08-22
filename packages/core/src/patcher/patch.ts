/**
 * The patch pipeline — 06-patch-engine.md §4.
 *
 *     patchNode(nodeId, changes)
 *       → resolve node → source mapping
 *       → verify the region has not moved since the graph was loaded (§5)
 *       → resolve the AST node
 *       → validate the edit
 *       → compute the patch on a CANDIDATE source (in memory)
 *       → validate the candidate (re-parse, re-analyze; on failure ABORT —
 *         the real source is not touched by a single byte)
 *       → commit atomically
 *       → re-analyze → graph diff → UI update
 *
 * Transactionality is the point of the candidate: there is no state in which
 * the source has been written and the damage is discovered afterwards.
 */

import type { SourceFile } from "ts-morph";
import { CodeFlowError } from "../errors.js";
import type {
  AnalyzeOptions,
  Diagnostic,
  ProvenanceMap,
  ProvenanceTarget,
  TextPatch,
  WorkflowGraph,
  WorkflowNode,
} from "../model/index.js";
import type { RegistryLookup } from "../registry/lookup.js";
import { analyzeSource } from "../analyzer/analyze.js";
import { checkFlowContract } from "../analyzer/flow-contract.js";
import { resolveIdentity } from "../mapper/resolve.js";
import { TsMorphParser } from "../parser/ts-morph-parser.js";
import { applyEdits, assertNoOverlap, mapOffset, meaningful, toPatches, type TextEdit } from "./edits.js";
import { planPatch } from "./plan.js";
import { detectStyle } from "./style.js";

export interface ComputePatchInput {
  /** The graph being edited; its `source.content` is the text patched. */
  graph: WorkflowGraph;
  registry: RegistryLookup;
  nodeId: string;
  changes: Record<string, unknown>;
  /** Analyze options to reuse when validating the candidate. */
  analyzeOptions?: Pick<AnalyzeOptions, "trigger">;
}

export interface ComputedPatch {
  /** The patched source — identical to the input when nothing changed. */
  source: string;
  patches: TextPatch[];
  diagnostics: Diagnostic[];
  /** `oldNodeId → new location`, for identity resolution (03 §5.2 step 0). */
  provenance: ProvenanceMap;
  edits: TextEdit[];
}

function nodeOf(graph: WorkflowGraph, nodeId: string): WorkflowNode {
  const node = graph.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) {
    throw new CodeFlowError(
      "patch-node-not-found",
      `No node "${nodeId}" in the current graph — re-analyze before editing.`,
    );
  }
  return node;
}

/**
 * Patch provenance, computed from the edits themselves (03 §5.2 step 0).
 *
 * Every surviving node is located by its **new offset range**, obtained by
 * pushing its old range through the edits. Ranges — not semantic paths — are
 * what stays true when an insert or delete renumbers siblings, which is exactly
 * the case where a heuristic would mis-bind (inserting a call byte-identical to
 * the one already there). Nodes the patch deleted are marked `removed` so they
 * are never rebound to something else.
 *
 * Entries follow graph order, which puts an owner node before the synthetic
 * node sharing its range (a condition before its merge); the resolver binds the
 * first unbound match, so the pairs line up.
 */
export function buildProvenance(
  graph: WorkflowGraph,
  edits: readonly TextEdit[],
  removed: readonly string[],
): ProvenanceMap {
  const gone = new Set(removed);
  const provenance: Record<string, ProvenanceTarget> = {};
  for (const node of graph.nodes) {
    if (gone.has(node.id)) {
      provenance[node.id] = { removed: true };
      continue;
    }
    provenance[node.id] = {
      range: {
        start: mapOffset(node.source.start.offset, edits, "start"),
        end: mapOffset(node.source.end.offset, edits, "end"),
      },
    };
  }
  return provenance;
}

/**
 * Validate the candidate before anything is committed (06 §4).
 *
 * Three questions, in order of how loudly a "no" would fail: does it still
 * parse, does it still obey the flow contract, and does the node that was
 * edited still exist in the graph the candidate produces.
 */
function validateCandidate(
  candidate: string,
  file: string,
  input: ComputePatchInput,
  provenance: ProvenanceMap,
  expectNode: string | null,
  before: { contractErrors: number },
): void {
  const parser = new TsMorphParser({ file });
  const sourceFile: SourceFile = parser.parse(candidate, file).sourceFile;

  const syntactic = sourceFile
    .getProject()
    .getProgram()
    .getSyntacticDiagnostics(sourceFile)
    .map((diagnostic) => {
      const message = diagnostic.getMessageText();
      return typeof message === "string" ? message : message.getMessageText();
    });
  if (syntactic.length > 0) {
    throw new CodeFlowError(
      "patch-invalid",
      `The edit would not parse (${syntactic.join("; ")}) — the source was left untouched (06 §4).`,
    );
  }

  const contract = checkFlowContract(sourceFile, file);
  const contractErrors = contract.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
  if (contractErrors > before.contractErrors) {
    throw new CodeFlowError(
      "patch-invalid",
      `The edit would break the flow contract (${contract.diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => diagnostic.message)
        .join("; ")}) — the source was left untouched (01 §1, 06 §4).`,
    );
  }

  if (expectNode === null) return;
  const cold = analyzeSource(candidate, input.registry, { file, ...(input.analyzeOptions ?? {}) });
  const resolution = resolveIdentity(input.graph, cold, { provenance });
  const survived = [...resolution.mapping.values()].includes(expectNode);
  if (!survived) {
    throw new CodeFlowError(
      "patch-invalid",
      "The edit would make the edited node disappear from the graph — the source was left untouched (06 §4).",
    );
  }
}

/**
 * Compute (but do not commit) the patch for one node. Returns the candidate
 * source; the caller commits it by re-analyzing with the returned provenance.
 */
export function computePatch(input: ComputePatchInput): ComputedPatch {
  const graph = input.graph;
  const node = nodeOf(graph, input.nodeId);
  const source = graph.source.content;
  const file = graph.source.file;

  const parser = new TsMorphParser({ file });
  const sourceFile = parser.parse(source, file).sourceFile;
  const style = detectStyle(sourceFile, source);
  const contractErrors = checkFlowContract(sourceFile, file).diagnostics.filter(
    (diagnostic) => diagnostic.severity === "error",
  ).length;

  const plan = planPatch({
    sourceFile,
    source,
    style,
    graph,
    registry: input.registry,
    node,
    changes: input.changes,
  });

  const edits = meaningful(plan.edits, source);
  if (edits.length === 0) {
    // An empty edit changes nothing — not one byte (I4).
    return { source, patches: [], diagnostics: plan.diagnostics, provenance: {}, edits: [] };
  }
  assertNoOverlap(edits);

  const candidate = applyEdits(source, edits);
  const provenance = buildProvenance(graph, edits, plan.removed);
  const expectNode = plan.removed.includes(node.id) ? null : node.id;
  validateCandidate(candidate, file, input, provenance, expectNode, { contractErrors });

  return {
    source: candidate,
    patches: toPatches(source, edits),
    diagnostics: plan.diagnostics,
    provenance,
    edits,
  };
}
