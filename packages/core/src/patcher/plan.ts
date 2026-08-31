/**
 * Edit planning — which text edits one `patchNode` call produces (06 §2).
 *
 * The supported edit set is exactly the MVP list of 06 §2, no more:
 * primitive arguments and object properties, expressions, `if`/`while`
 * conditions, the iterable of a `for…of`, deleting a node (with a dependency
 * check), inserting a node from the palette, changing a tool, and replacing the
 * opaque region of a code node or a local function body. Anything else is
 * refused **out loud** (`patch-unsupported`), never approximated (07 §5).
 *
 * `changes` keys:
 *
 *   - a plain key is an argument property of the node (`{ channel: "#eng" }`),
 *     the shape 06 §4 shows;
 *   - `$set` is the same thing spelled out, for property names that would clash
 *     with an operation key;
 *   - `$condition`, `$iterable`, `$code`, `$tool`, `$delete`, `$insert` are the
 *     operations. Operations that rewrite or remove a whole statement do not
 *     combine with anything else.
 */

import { Node, SyntaxKind } from "ts-morph";
import type { Block, SourceFile, Statement } from "ts-morph";
import { CodeFlowError } from "../errors.js";
import { checkFlowContract } from "../analyzer/flow-contract.js";
import type { Diagnostic, Schema, WorkflowGraph, WorkflowNode } from "../model/index.js";
import { isNamedFieldsSchema, isTsTypeRef } from "../model/schema.js";
import type { RegistryLookup } from "../registry/lookup.js";
import { inputSchemaFieldNames } from "../registry/validate.js";
import { canonicalJson } from "../util/canonical-json.js";
import type { TextEdit } from "./edits.js";
import {
  argumentObjectFor,
  astNodeFor,
  callExpressionFor,
  findProperty,
  hasOpaqueKey,
  lastSpreadIndex,
  statementFor,
} from "./locate.js";
import {
  addPropertyEdit,
  removePropertyEdits,
  replaceFieldsEdit,
  setPropertyEdit,
} from "./object-edits.js";
import {
  appendToBlockEdit,
  deleteRangeEdits,
  ensureImportEdits,
  identifiersIn,
  insertStatementEdit,
  isUnbracedBody,
  retargetToolEdit,
  suggestVariableName,
  type InsertWhere,
} from "./statement-edits.js";
import type { SourceStyle } from "./style.js";
import { checkExpressionScope } from "./scope-check.js";
import {
  asFieldValue,
  formOf,
  renderValue,
  resolveValue,
  type FieldValue,
  type ResolvedValue,
} from "./values.js";

export interface PlanInput {
  sourceFile: SourceFile;
  source: string;
  style: SourceStyle;
  graph: WorkflowGraph;
  registry: RegistryLookup;
  node: WorkflowNode;
  changes: Record<string, unknown>;
}

export interface PatchPlan {
  edits: TextEdit[];
  diagnostics: Diagnostic[];
  /** Nodes this patch deletes — provenance marks them removed, never rebound. */
  removed: string[];
}

const OPERATION_KEYS = ["$set", "$condition", "$iterable", "$code", "$tool", "$delete", "$insert"];
/** Operations that own the whole statement and cannot be mixed with others. */
const EXCLUSIVE_KEYS = ["$delete", "$insert", "$code", "$condition", "$iterable"];

/* -------------------------------------------------------------------------- */
/* entry point                                                                 */
/* -------------------------------------------------------------------------- */

export function planPatch(input: PlanInput): PatchPlan {
  const keys = Object.keys(input.changes);
  for (const key of keys) {
    if (key.startsWith("$") && !OPERATION_KEYS.includes(key)) {
      throw new CodeFlowError(
        "patch-unsupported",
        `Unknown patch operation "${key}" — supported operations are ${OPERATION_KEYS.join(", ")} (06 §2).`,
      );
    }
  }
  for (const exclusive of EXCLUSIVE_KEYS) {
    if (keys.includes(exclusive) && keys.length > 1) {
      throw new CodeFlowError(
        "patch-unsupported",
        `"${exclusive}" rewrites the whole statement and cannot be combined with other changes in one patch.`,
      );
    }
  }

  if (input.changes["$delete"] !== undefined) return planDelete(input);
  if (input.changes["$insert"] !== undefined) return planInsert(input);
  if (input.changes["$code"] !== undefined) return planCode(input);
  if (input.changes["$condition"] !== undefined) return planCondition(input);
  if (input.changes["$iterable"] !== undefined) return planIterable(input);
  return planFields(input);
}

/* -------------------------------------------------------------------------- */
/* scope of a written expression — 03 §6, 06 §3                                */
/* -------------------------------------------------------------------------- */

/**
 * A check run on every expression (and every template) a patch writes, before
 * one byte is planned. See `scope-check.ts` for why an unchecked reference is
 * an I6 failure rather than a typo.
 */
export type ExpressionGuard = (field: string, value: ResolvedValue) => void;

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The bindings a node declares: its output ports' **labels**.
 *
 * The label is the local name (`const { data: rows }` gives port `data`
 * labelled `rows` — 03 §6); the id is the property it came from, which binds
 * nothing and must not be offered as a name.
 */
function outputNames(node: WorkflowNode): string[] {
  return node.outputs.map((port) => port.label);
}

/** Names a patch may reference at `node`, sorted so the message is stable. */
function namesAt(graph: WorkflowGraph, nodeId: string, extra: readonly string[] = []): string[] {
  const names = new Set((graph.scopes[nodeId] ?? []).map((binding) => binding.name));
  for (const name of extra) names.add(name);
  return [...names].sort(byName);
}

/**
 * The subset of `namesAt` worth *offering* when the check refuses.
 *
 * Everything in scope stays legal — `tools.slack.send` in an expression is a
 * perfectly good reference. But the refusal message answers "what can I put
 * here?", and answering that with `tools` or the name of an imported function
 * points the reader at something that is not a value. Values and the flow's own
 * parameters are the honest answer; the check itself is unchanged.
 */
function suggestionsAt(graph: WorkflowGraph, nodeId: string, extra: readonly string[] = []): string[] {
  const names = new Set(
    (graph.scopes[nodeId] ?? [])
      .filter((binding) => binding.kind === "value")
      .map((binding) => binding.name),
  );
  for (const name of extra) names.add(name);
  return [...names].sort(byName);
}

function guardFor(
  available: readonly string[],
  nodeLabel: string,
  suggest: readonly string[],
): ExpressionGuard {
  return (field, value) => {
    if (value.kind === "expression") {
      checkExpressionScope(value.text, "expression", { field, nodeLabel, available, suggest });
      return;
    }
    if (value.kind === "template") {
      checkExpressionScope(value.text, "template", { field, nodeLabel, available, suggest });
    }
  };
}

/** Guard for an edit *of* a node's own fields: the node's scope, as analyzed. */
function scopeGuard(input: PlanInput): ExpressionGuard {
  return guardFor(
    namesAt(input.graph, input.node.id),
    input.node.label,
    suggestionsAt(input.graph, input.node.id),
  );
}

/**
 * Guard for an **insert**, whose reference point is the insertion site rather
 * than the anchor node:
 *
 *  - `before` — the anchor's own binding is not declared yet at that point, so
 *    the anchor's scope is exactly right;
 *  - `after` — the anchor has run, so what it declares is available too;
 *  - `append` — the statement lands at the *end* of a block, where everything
 *    that block declared is in scope. The nearest thing the graph already
 *    knows is the scope of the last node in that block, plus what that node
 *    declares; with an empty block, the container's own scope and outputs (a
 *    loop's item variable, a catch's error binding).
 *
 * Conservative by construction: an over-refusal names the binding and can be
 * worked around in the code view, while an under-check writes code that does
 * not run.
 */
function insertGuard(input: PlanInput, spec: InsertSpec): ExpressionGuard {
  const where = spec.where ?? "after";
  const node = input.node;
  if (where === "before") {
    return guardFor(namesAt(input.graph, node.id), node.label, suggestionsAt(input.graph, node.id));
  }
  if (where === "after") {
    return guardFor(
      namesAt(input.graph, node.id, outputNames(node)),
      node.label,
      suggestionsAt(input.graph, node.id, outputNames(node)),
    );
  }

  const slot = node.type === "try" ? (spec.slot ?? "body") : "body";
  const isChild = (candidate: WorkflowNode): boolean =>
    node.type === "trigger"
      ? candidate.data["parentId"] === null
      : candidate.data["parentId"] === node.id && candidate.data["parentSlot"] === slot;

  let last: WorkflowNode | null = null;
  for (const candidate of input.graph.nodes) {
    if (candidate.id === node.id || !isChild(candidate)) continue;
    if (last === null || candidate.source.end.offset > last.source.end.offset) last = candidate;
  }
  if (last === null) {
    return guardFor(
      namesAt(input.graph, node.id, outputNames(node)),
      node.label,
      suggestionsAt(input.graph, node.id, outputNames(node)),
    );
  }
  return guardFor(
    namesAt(input.graph, last.id, outputNames(last)),
    node.label,
    suggestionsAt(input.graph, last.id, outputNames(last)),
  );
}

/* -------------------------------------------------------------------------- */
/* argument fields — 06 §1, §2                                                 */
/* -------------------------------------------------------------------------- */

function fieldChanges(changes: Record<string, unknown>): Record<string, FieldValue> {
  const fields: Record<string, FieldValue> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (key === "$tool") continue;
    if (key === "$set") {
      const set = value as Record<string, unknown>;
      if (typeof set !== "object" || set === null) {
        throw new CodeFlowError("patch-unsupported", "`$set` must be an object of field values.");
      }
      for (const [name, raw] of Object.entries(set)) fields[name] = asFieldValue(name, raw);
      continue;
    }
    if (key.startsWith("$")) continue;
    fields[key] = asFieldValue(key, value);
  }
  return fields;
}

function definitionFor(input: PlanInput): {
  inputSchema: Schema | undefined;
  editable: string[];
  label: string;
} {
  const { node, registry } = input;
  if (node.type === "tool" || node.type === "unknown") {
    const tool = registry.getTool(String(node.data["toolName"] ?? ""));
    return {
      inputSchema: tool?.inputSchema,
      editable: (tool?.editableFields ?? []).map((field) => field.name),
      label: node.label,
    };
  }
  if (node.type === "function") {
    const definition = registry.getFunction(String(node.data["functionName"] ?? ""));
    return {
      inputSchema: definition?.inputSchema,
      editable: (definition?.editableFields ?? []).map((field) => field.name),
      label: node.label,
    };
  }
  return { inputSchema: undefined, editable: [], label: node.label };
}

function planFields(input: PlanInput): PatchPlan {
  const fields = fieldChanges(input.changes);
  const retarget = input.changes["$tool"];
  const edits: TextEdit[] = [];
  const diagnostics: Diagnostic[] = [];

  if (retarget !== undefined) {
    const plan = planToolChange(input, typeof retarget === "string" ? retarget : "");
    edits.push(...plan.edits);
    diagnostics.push(...plan.diagnostics);
  }

  if (Object.keys(fields).length === 0) return { edits, diagnostics, removed: [] };

  if (input.node.type !== "tool" && input.node.type !== "function") {
    throw new CodeFlowError(
      "patch-not-editable",
      `"${input.node.label}" (${input.node.type}) has no editable argument fields (06 §2).`,
    );
  }

  const call = callExpressionFor(input.sourceFile, input.node);
  const definition = definitionFor(input);
  const schemaFields = definition.inputSchema === undefined ? null : inputSchemaFieldNames(definition.inputSchema);
  const guard = scopeGuard(input);

  // A function is called with positional parameters; its named schema is the
  // bridge between an editable field and the argument at that position (05 §4).
  if (input.node.type === "function") {
    return {
      edits: [...edits, ...positionalEdits(input, call, definition, schemaFields, fields, guard)],
      diagnostics,
      removed: [],
    };
  }

  const object = argumentObjectFor(call, input.node.label);
  const spread = lastSpreadIndex(object);

  for (const [name, value] of Object.entries(fields)) {
    if (definition.editable.length > 0 && !definition.editable.includes(name)) {
      throw new CodeFlowError(
        "patch-not-editable",
        `Field "${name}" is not declared editable on "${definition.label}" — editable fields are ${definition.editable.join(", ")} (06 §1).`,
      );
    }

    const location = findProperty(object, name);
    if (location === null) {
      // Adding a property after a spread would override a value the user cannot
      // see — never done silently (06 §1).
      if (spread !== -1) {
        throw new CodeFlowError(
          "patch-not-editable",
          `"${definition.label}" spreads another object into its argument — a new "${name}" would override a value that is not visible in the source. Edit it in the code view (06 §1).`,
        );
      }
      // Same reasoning for a computed key nobody can name (`["chan" + "nel"]`):
      // it may well *be* this field, in which case appending a second one
      // silently overrides the value on screen. Refuse instead of guessing.
      if (hasOpaqueKey(object)) {
        throw new CodeFlowError(
          "patch-not-editable",
          `The argument of "${definition.label}" has a computed key that cannot be resolved without running the code — a new "${name}" might override it, or be overridden by it. Edit it in the code view (06 §1).`,
        );
      }
      const resolved = asFieldValue(name, value);
      if (typeof resolved === "object" && resolved !== null && resolved.kind === "remove") continue;
      if (schemaFields !== null && !schemaFields.includes(name)) {
        throw new CodeFlowError(
          "patch-unsupported",
          `"${name}" is not a field of the input schema of "${definition.label}" — only schema fields can be added (06 §2).`,
        );
      }
      // A brand-new property has no original form: resolution matches what
      // `addPropertyEdit` does, so the guard sees exactly what will be written.
      guard(name, resolveValue(name, resolved, "none"));
      edits.push(...addPropertyEdit(object, name, resolved, input.style, input.source));
      continue;
    }

    // 06 §1: with a spread present, only properties *after* it are editable —
    // a property before it may be overridden by the spread.
    if (spread !== -1 && location.index < spread) {
      throw new CodeFlowError(
        "patch-not-editable",
        `"${name}" is written before a spread in the argument of "${definition.label}", so its effective value is not visible — edit it in the code view (06 §1).`,
      );
    }

    const fieldValue = asFieldValue(name, value);
    // Resolved against the form it replaces, exactly as `setPropertyEdit`
    // does — a bare string against a template field is a template body, and
    // its `${…}` interpolations are references like any other (06 §3).
    guard(name, resolveValue(name, fieldValue, location.shorthand ? "none" : formOf(location.value)));
    edits.push(...setPropertyEdit(object, location, name, fieldValue, input.style, input.source));

    // Clearing a field the schema knows about leaves the node unconfigured —
    // said out loud rather than left to be discovered at run time (06 §3).
    const removes = typeof fieldValue === "object" && fieldValue !== null && fieldValue.kind === "remove";
    if (removes && schemaFields !== null && schemaFields.includes(name)) {
      diagnostics.push({
        severity: "warning",
        code: "needs-configuration",
        message: `\`${name}\` was removed from "${definition.label}" — the node needs configuration before the flow runs (06 §3).`,
        source: input.node.source,
      });
    }
  }

  return { edits, diagnostics, removed: [] };
}

/**
 * Edits for a function call's positional arguments (05 §4).
 *
 * The n-th key of the input schema names the n-th parameter, so editing field
 * `files` replaces the argument at that position — and nothing else on the line.
 * An argument that is not written out at all is refused rather than appended:
 * guessing which optional parameters were skipped is exactly the kind of
 * silent reinterpretation I6 forbids.
 */
function positionalEdits(
  input: PlanInput,
  call: Node,
  definition: { label: string; editable: string[] },
  schemaFields: string[] | null,
  fields: Record<string, FieldValue>,
  guard: ExpressionGuard,
): TextEdit[] {
  if (!Node.isCallExpression(call)) return [];
  const args = call.getArguments();
  const edits: TextEdit[] = [];

  for (const [name, value] of Object.entries(fields)) {
    if (definition.editable.length > 0 && !definition.editable.includes(name)) {
      throw new CodeFlowError(
        "patch-not-editable",
        `Field "${name}" is not declared editable on "${definition.label}" — editable fields are ${definition.editable.join(", ")} (06 §1).`,
      );
    }
    const index = schemaFields === null ? -1 : schemaFields.indexOf(name);
    if (index === -1) {
      throw new CodeFlowError(
        "patch-not-editable",
        `"${definition.label}" has no input field "${name}" — a function's editable fields come from its declared input schema (05 §4).`,
      );
    }
    const argument = args[index];
    if (argument === undefined) {
      throw new CodeFlowError(
        "patch-unsupported",
        `Argument ${String(index + 1)} ("${name}") of "${definition.label}" is not written out in the call — add it in the code view (06 §2).`,
      );
    }
    const resolved = resolveValue(name, value, formOf(argument));
    if (resolved.kind === "remove") {
      throw new CodeFlowError(
        "patch-unsupported",
        `A positional argument cannot be removed on its own — removing "${name}" would shift every argument after it (06 §2).`,
      );
    }
    guard(name, resolved);
    edits.push({
      start: argument.getStart(),
      end: argument.getEnd(),
      newText: renderValue(resolved, argument, input.style),
    });
  }
  return edits;
}

/* -------------------------------------------------------------------------- */
/* condition / iterable — 06 §2                                                */
/* -------------------------------------------------------------------------- */

function expressionText(field: string, value: unknown, guard: ExpressionGuard): string {
  // A bare string here *is* the expression source (a condition has no literal
  // form to fall back to), so it is guarded like an explicit expression.
  if (typeof value === "string") {
    guard(field, { kind: "expression", text: value });
    return value;
  }
  const resolved = resolveValue(field, asFieldValue(field, value), "expression");
  if (resolved.kind === "remove") {
    throw new CodeFlowError("patch-unsupported", `"${field}" cannot be removed — it is required by the construct.`);
  }
  guard(field, resolved);
  return renderValue(resolved, undefined, { quote: '"', indent: "  ", eol: "\n", semicolons: true, trailingComma: false });
}

function planCondition(input: PlanInput): PatchPlan {
  const text = expressionText("$condition", input.changes["$condition"], scopeGuard(input));
  const owner = astNodeFor(input.sourceFile, input.node);
  const statement = Node.isLabeledStatement(owner) ? owner.getStatement() : owner;

  if (input.node.type === "condition" && Node.isIfStatement(statement)) {
    const expression = statement.getExpression();
    return { edits: [{ start: expression.getStart(), end: expression.getEnd(), newText: text }], diagnostics: [], removed: [] };
  }
  if (input.node.type === "loop" && Node.isWhileStatement(statement)) {
    const expression = statement.getExpression();
    return { edits: [{ start: expression.getStart(), end: expression.getEnd(), newText: text }], diagnostics: [], removed: [] };
  }
  throw new CodeFlowError(
    "patch-unsupported",
    `"${input.node.label}" has no condition expression — only \`if\` and \`while\` nodes do (06 §2).`,
  );
}

function planIterable(input: PlanInput): PatchPlan {
  const text = expressionText("$iterable", input.changes["$iterable"], scopeGuard(input));
  const owner = astNodeFor(input.sourceFile, input.node);
  const statement = Node.isLabeledStatement(owner) ? owner.getStatement() : owner;
  if (!Node.isForOfStatement(statement)) {
    throw new CodeFlowError(
      "patch-unsupported",
      `"${input.node.label}" has no iterable expression — only \`for…of\` nodes do (06 §2).`,
    );
  }
  const expression = statement.getExpression();
  return { edits: [{ start: expression.getStart(), end: expression.getEnd(), newText: text }], diagnostics: [], removed: [] };
}

/* -------------------------------------------------------------------------- */
/* opaque regions — 06 §2 (Monaco edits)                                       */
/* -------------------------------------------------------------------------- */

function planCode(input: PlanInput): PatchPlan {
  const text = input.changes["$code"];
  if (typeof text !== "string") {
    throw new CodeFlowError("patch-unsupported", "`$code` must be the replacement text as a string.");
  }
  const node = input.node;

  if (node.type === "code" || node.type === "unknown") {
    return {
      edits: [{ start: node.source.start.offset, end: node.source.end.offset, newText: text }],
      diagnostics: [],
      removed: [],
    };
  }

  // A local function node points at the *call*; "edit code" means its body
  // (06 §2 — the body is an opaque region, so the minimal patch is the whole of it).
  if (node.type === "function" && node.data["functionSource"] === "local") {
    const name = String(node.data["functionName"] ?? "");
    const declaration = input.sourceFile.getFunction(name);
    const body = declaration?.getBody();
    if (declaration === undefined || body === undefined || !Node.isBlock(body)) {
      throw new CodeFlowError(
        "patch-unsupported",
        `Local function "${name}" has no block body in this file — edit it in the code view (06 §2).`,
      );
    }
    const open = body.getFirstChildByKindOrThrow(SyntaxKind.OpenBraceToken);
    const close = body.getLastChildByKindOrThrow(SyntaxKind.CloseBraceToken);
    return {
      edits: [{ start: open.getEnd(), end: close.getStart(), newText: text }],
      diagnostics: [],
      removed: [],
    };
  }

  throw new CodeFlowError(
    "patch-unsupported",
    `"${node.label}" (${node.type}) has no opaque code region — \`$code\` applies to code nodes and local functions (06 §2).`,
  );
}

/* -------------------------------------------------------------------------- */
/* delete — 06 §2 (with dependency check)                                      */
/* -------------------------------------------------------------------------- */

/** Nodes whose source range is inside the deleted range — they go with it. */
function nodesInside(graph: WorkflowGraph, node: WorkflowNode): WorkflowNode[] {
  const start = node.source.start.offset;
  const end = node.source.end.offset;
  return graph.nodes.filter(
    (candidate) => candidate.source.start.offset >= start && candidate.source.end.offset <= end,
  );
}

function planDelete(input: PlanInput): PatchPlan {
  const { graph, node } = input;
  if (input.changes["$delete"] !== true) {
    throw new CodeFlowError("patch-unsupported", "`$delete` must be `true`.");
  }
  if (!node.capabilities.deletable) {
    throw new CodeFlowError(
      "patch-unsupported",
      `"${node.label}" is a synthetic node and has no statement of its own to delete (03 §4).`,
    );
  }

  const doomed = nodesInside(graph, node);
  const doomedIds = new Set(doomed.map((candidate) => candidate.id));
  const byId = new Map(graph.nodes.map((candidate) => [candidate.id, candidate]));

  // Dependency check (06 §2): an output binding still read downstream blocks the
  // delete, and the message names the node that depends on it.
  const blockers: string[] = [];
  for (const edge of graph.edges) {
    if (edge.kind !== "data") continue;
    if (!doomedIds.has(edge.source) || doomedIds.has(edge.target)) continue;
    const target = byId.get(edge.target);
    if (target === undefined) continue;
    const binding = edge.label ?? edge.sourcePort ?? "its output";
    const message = `"${target.label}" uses \`${binding}\``;
    if (!blockers.includes(message)) blockers.push(message);
  }
  if (blockers.length > 0) {
    throw new CodeFlowError(
      "patch-dependency",
      `Cannot delete "${node.label}": ${blockers.join(", ")} — delete or edit ${blockers.length === 1 ? "that node" : "those nodes"} first (06 §2).`,
    );
  }

  const edits = deleteStatementEdits(input, node.source.start.offset, node.source.end.offset);
  return { edits, diagnostics: [], removed: [...doomedIds] };
}

/**
 * Text edits that remove the statement a node owns.
 *
 * The one case that is not "remove the line": a statement that *is* the
 * brace-less body of an `if`/`else`/loop. Removing its text there hands the
 * body to the next statement — valid code that means something else. An empty
 * block keeps the meaning and matches what deleting the only statement of a
 * braced body already produces (`if (x) { }`).
 */
function deleteStatementEdits(input: PlanInput, start: number, end: number): TextEdit[] {
  const statement = statementAt(input.sourceFile, start, end);
  if (statement !== null && isUnbracedBody(statement)) {
    return [{ start, end, newText: "{ }" }];
  }
  return deleteRangeEdits(input.source, start, end);
}

/** The statement whose range is exactly `[start, end)`, if there is one. */
function statementAt(sourceFile: SourceFile, start: number, end: number): Node | null {
  let found: Node | null = null;
  const visit = (current: Node): void => {
    if (current.getEnd() < start || current.getStart() > end) return;
    if (Node.isStatement(current) && current.getStart() === start && current.getEnd() === end) {
      found = current;
      return;
    }
    current.forEachChild(visit);
  };
  visit(sourceFile);
  return found;
}

/* -------------------------------------------------------------------------- */
/* insert — 06 §2 (palette)                                                    */
/* -------------------------------------------------------------------------- */

export interface InsertSpec {
  /** Tool name, e.g. "slack.send". */
  tool?: string;
  /** Library or local function name. */
  function?: string;
  where?: InsertWhere;
  /** Which block to append to, for a container node. */
  slot?: "body" | "then" | "else" | "catch" | "finally";
  arguments?: Record<string, unknown>;
  /** Override the generated binding name. */
  variable?: string;
  /** Force a bare statement with no binding. */
  bind?: boolean;
  await?: boolean;
}

function schemaFieldType(schema: Schema | undefined, field: string): string | null {
  if (schema === undefined || isTsTypeRef(schema)) return null;
  if (isNamedFieldsSchema(schema)) {
    const value = schema[field];
    return value === undefined ? null : canonicalJson(value);
  }
  const properties = (schema as Record<string, unknown>)["properties"];
  if (typeof properties !== "object" || properties === null) return null;
  const value = (properties as Record<string, unknown>)[field];
  return value === undefined ? null : canonicalJson(value);
}

function defaultFor(schema: Schema | undefined, field: string): unknown {
  if (schema === undefined || isTsTypeRef(schema) || isNamedFieldsSchema(schema)) return undefined;
  const properties = (schema as Record<string, unknown>)["properties"];
  if (typeof properties !== "object" || properties === null) return undefined;
  const entry = (properties as Record<string, unknown>)[field];
  if (typeof entry !== "object" || entry === null) return undefined;
  return (entry as Record<string, unknown>)["default"];
}

/**
 * Argument object for an inserted call. Fields with a supplied value use it,
 * fields with a schema default use that, and anything else gets the explicit
 * placeholder `undefined` — the node comes up **needs-configuration** (06 §2):
 * the code still parses, the analyzer flags the placeholder on re-analyze, and
 * the inspector has something concrete to point at.
 */
function buildArguments(
  schema: Schema | undefined,
  supplied: Record<string, unknown>,
  style: SourceStyle,
  guard: ExpressionGuard,
): { text: string; placeholders: string[] } {
  const names = schema === undefined ? [] : (inputSchemaFieldNames(schema) ?? []);
  const ordered = [...names];
  for (const name of Object.keys(supplied)) if (!ordered.includes(name)) ordered.push(name);

  const parts: string[] = [];
  const placeholders: string[] = [];
  for (const name of ordered) {
    if (Object.prototype.hasOwnProperty.call(supplied, name)) {
      const value = resolveValue(name, asFieldValue(name, supplied[name]), "none");
      if (value.kind === "remove") continue;
      guard(name, value);
      parts.push(`${name}: ${renderValue(value, undefined, style)}`);
      continue;
    }
    const fallback = defaultFor(schema, name);
    if (fallback !== undefined) {
      const value = resolveValue(name, asFieldValue(name, fallback), "none");
      if (value.kind !== "remove") {
        parts.push(`${name}: ${renderValue(value, undefined, style)}`);
        continue;
      }
    }
    placeholders.push(name);
    parts.push(`${name}: undefined`);
  }
  return { text: parts.length === 0 ? "{}" : `{ ${parts.join(", ")} }`, placeholders };
}

function blockForSlot(node: WorkflowNode, statement: Node, slot: InsertSpec["slot"]): Block {
  const target = Node.isLabeledStatement(statement) ? statement.getStatement() : statement;
  const asBlock = (candidate: Node | undefined, what: string): Block => {
    if (candidate === undefined || !Node.isBlock(candidate)) {
      throw new CodeFlowError(
        "patch-unsupported",
        `"${node.label}" has no ${what} block to append to — add braces in the code view first (06 §2).`,
      );
    }
    return candidate;
  };

  if (Node.isIfStatement(target)) {
    if (slot === "else") return asBlock(target.getElseStatement(), "else");
    return asBlock(target.getThenStatement(), "then");
  }
  if (Node.isForOfStatement(target) || Node.isWhileStatement(target)) {
    return asBlock(target.getStatement(), "body");
  }
  if (Node.isTryStatement(target)) {
    if (slot === "catch") return asBlock(target.getCatchClause()?.getBlock(), "catch");
    if (slot === "finally") return asBlock(target.getFinallyBlock(), "finally");
    return asBlock(target.getTryBlock(), "body");
  }
  throw new CodeFlowError(
    "patch-unsupported",
    `"${node.label}" is not a container node — insert before or after it instead (06 §2).`,
  );
}

/** The flow body, for appending at the end of the flow (anchor: the trigger). */
function flowBodyFor(input: PlanInput): Block {
  const at = input.node.source.end.offset;
  for (const block of input.sourceFile.getDescendantsOfKind(SyntaxKind.Block)) {
    if (block.getStart() === at) return block;
  }
  throw new CodeFlowError("patch-conflict", "The flow body no longer starts where the trigger node says it does (06 §5).");
}

/**
 * Structural preconditions for an insert **relative to a statement** (06 §2).
 *
 * `insertStatementEdit` puts the new statement on its own line before or after
 * the anchor's line. That is right when the anchor is one statement of a block
 * and wrong in two ways when it is not — both of them the silent change of
 * meaning `isUnbracedBody` already guards on the delete path:
 *
 *  - the anchor **is** the brace-less body of an `if`/`else`/loop
 *    (`if (pr.draft) await tools.slack.send(…)`). The new line lands *after the
 *    whole `if`*, so a step the user aimed at "only for drafts" runs for every
 *    item. Putting it inside the branch instead is not available either: there
 *    is no block to put it in, and manufacturing one would rewrite a statement
 *    the user did not edit;
 *  - the anchor is a **terminal** statement — `break`/`continue`/`return`.
 *    Nothing runs after it. `where: "after"` either lands outside the branch
 *    (the jump case) or writes unreachable code (the `return` case).
 *
 * Both are refused by name, in the house style: say what cannot be done and
 * what to do instead, rather than approximate the gesture (07 §5). A refusal
 * throws before any edit exists, so the source is untouched by construction.
 */
function checkInsertAnchor(input: PlanInput, spec: InsertSpec): void {
  const where = spec.where ?? "after";
  if (where === "append") return;
  const node = input.node;

  if (where === "after" && (node.type === "jump" || node.type === "output")) {
    // The synthetic end-of-flow node has no statement to sit next to at all
    // (03 §4), so "insert before it" is not the way out there — appending to
    // the flow body is.
    const synthetic = node.type === "output" && node.data["explicit"] === false;
    const what =
      node.type === "jump"
        ? `\`${String(node.data["kind"] ?? "jump")}\` leaves this block`
        : synthetic
          ? "the flow ends here"
          : "a `return` leaves the flow";
    const instead = synthetic
      ? "Append to the end of the flow instead (`$insert` with `where: \"append\"` on the trigger)"
      : `Insert it *before* "${node.label}" instead`;
    throw new CodeFlowError(
      "patch-unsupported",
      `Nothing runs after "${node.label}" — ${what}, so a step inserted after it would never execute. ${instead} (06 §2).`,
    );
  }

  const statement = statementFor(input.sourceFile, node);
  if (isUnbracedBody(statement)) {
    throw new CodeFlowError(
      "patch-unsupported",
      `"${node.label}" is the entire brace-less body of the branch it sits in, so it has no block of its own to insert into — a statement placed ${where} it would land outside the branch and run every time. Add braces to the branch first, or insert relative to the enclosing \`if\`/loop instead (06 §2).`,
    );
  }
}

function planInsert(input: PlanInput): PatchPlan {
  const spec = input.changes["$insert"] as InsertSpec;
  if (typeof spec !== "object" || spec === null) {
    throw new CodeFlowError("patch-unsupported", "`$insert` must be an object describing the node to insert.");
  }
  checkInsertAnchor(input, spec);
  if ((spec.tool === undefined) === (spec.function === undefined)) {
    throw new CodeFlowError(
      "patch-unsupported",
      "`$insert` needs exactly one of `tool` or `function` — palette entries are one or the other (05 §1, §4).",
    );
  }

  const style = input.style;
  const diagnostics: Diagnostic[] = [];
  const edits: TextEdit[] = [];
  // An inserted call's arguments reference the *insertion site's* scope, not
  // the anchor node's own (03 §6, `insertGuard`).
  const guard = insertGuard(input, spec);

  let callText: string;
  let schema: Schema | undefined;
  let outputSchema: Schema | undefined;
  let callableName: string;
  let awaited: boolean;

  if (spec.tool !== undefined) {
    const tool = input.registry.getTool(spec.tool);
    if (tool === undefined) {
      throw new CodeFlowError(
        "patch-unsupported",
        `Tool "${spec.tool}" is not in the registry — nothing to insert (05 §1).`,
      );
    }
    const toolsBinding = toolsParameterName(input);
    schema = tool.inputSchema;
    outputSchema = tool.outputSchema;
    callableName = tool.name;
    awaited = spec.await ?? true;
    const args = buildArguments(schema, spec.arguments ?? {}, style, guard);
    if (args.placeholders.length > 0) {
      diagnostics.push({
        severity: "warning",
        code: "needs-configuration",
        message: `"${tool.label}" was inserted with placeholders for ${args.placeholders.join(", ")} — fill them in before running the flow (06 §2).`,
      });
    }
    callText = `${toolsBinding}.${tool.name}(${args.text})`;
  } else {
    const name = spec.function as string;
    const definition = input.registry.getFunction(name);
    if (definition === undefined) {
      throw new CodeFlowError(
        "patch-unsupported",
        `Function "${name}" is not in the library — nothing to insert (05 §4).`,
      );
    }
    schema = definition.inputSchema;
    outputSchema = definition.outputSchema;
    callableName = definition.name;
    awaited = spec.await ?? false;
    const args = buildArguments(schema, spec.arguments ?? {}, style, guard);
    // A library function takes positional parameters; the named schema is the
    // bridge between field names and positions (05 §4).
    const names = schema === undefined ? [] : (inputSchemaFieldNames(schema) ?? []);
    const positional = names.map((field) => {
      const supplied = (spec.arguments ?? {})[field];
      if (supplied === undefined) {
        args.placeholders.push(field);
        return "undefined";
      }
      const value = resolveValue(field, asFieldValue(field, supplied), "none");
      return value.kind === "remove" ? "undefined" : renderValue(value, undefined, style);
    });
    if (args.placeholders.length > 0) {
      diagnostics.push({
        severity: "warning",
        code: "needs-configuration",
        message: `"${definition.label}" was inserted with placeholders for ${[...new Set(args.placeholders)].join(", ")} — fill them in before running the flow (06 §2).`,
      });
    }
    callText = `${definition.name}(${positional.join(", ")})`;
    edits.push(
      ...ensureImportEdits(input.sourceFile, input.source, definition.modulePath, definition.name, style),
    );
  }

  // The callable's own name counts as taken even when the import that will
  // bring it in is part of this very patch — `const isAuthChange =
  // isAuthChange(files)` would shadow itself.
  const taken = new Set([...identifiersIn(input.sourceFile), callableName]);
  const bind = spec.bind ?? outputSchema !== undefined;
  const variable = bind ? (spec.variable ?? suggestVariableName(callableName, taken)) : null;
  const semicolon = style.semicolons ? ";" : "";
  const text = `${variable === null ? "" : `const ${variable} = `}${awaited ? "await " : ""}${callText}${semicolon}`;

  const where = spec.where ?? "after";
  if (where === "append") {
    const block =
      input.node.type === "trigger" ? flowBodyFor(input) : blockForSlot(input.node, astNodeFor(input.sourceFile, input.node), spec.slot);
    edits.push(appendToBlockEdit(input.source, block, text, style));
  } else {
    const statement: Statement = statementFor(input.sourceFile, input.node);
    edits.push(
      insertStatementEdit(
        input.source,
        { start: statement.getStart(), end: statement.getEnd() },
        where,
        text,
        style,
      ),
    );
  }

  return { edits, diagnostics, removed: [] };
}

/** Name of the flow's `tools` parameter — the binding tool calls are rooted at. */
function toolsParameterName(input: PlanInput): string {
  const flow = checkFlowContract(input.sourceFile, "").flow;
  const parameter = flow?.getParameters()[1];
  if (parameter !== undefined) return parameter.getName();
  throw new CodeFlowError(
    "patch-unsupported",
    "This flow has no `tools` parameter to root a tool call at (01 §1).",
  );
}

/* -------------------------------------------------------------------------- */
/* change tool — 06 §2                                                         */
/* -------------------------------------------------------------------------- */

function planToolChange(input: PlanInput, newPath: string): PatchPlan {
  const node = input.node;
  if (node.type !== "tool" && node.type !== "unknown") {
    throw new CodeFlowError(
      "patch-unsupported",
      `"${node.label}" is not a tool node — only tool calls can change their tool (06 §2).`,
    );
  }
  const target = input.registry.getTool(newPath);
  if (target === undefined) {
    throw new CodeFlowError(
      "patch-unsupported",
      `Tool "${newPath}" is not in the registry — pick a registered tool (05 §1).`,
    );
  }
  const currentPath = String(node.data["toolName"] ?? "");
  const current = input.registry.getTool(currentPath);

  const call = callExpressionFor(input.sourceFile, node);
  const edits: TextEdit[] = [retargetToolEdit(call, currentPath, newPath)];
  const diagnostics: Diagnostic[] = [];

  const object = argumentObjectFor(call, node.label);
  const targetFields = inputSchemaFieldNames(target.inputSchema) ?? [];
  const present = object
    .getProperties()
    .map((property) =>
      Node.isPropertyAssignment(property) || Node.isShorthandPropertyAssignment(property)
        ? property.getName()
        : null,
    )
    .filter((name): name is string => name !== null);

  // Compatible = same name AND same declared type; anything else is dropped
  // rather than reinterpreted under a new meaning (06 §2, I6).
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const name of present) {
    const sameName = targetFields.includes(name);
    const currentType = schemaFieldType(current?.inputSchema, name);
    const targetType = schemaFieldType(target.inputSchema, name);
    const sameType = currentType === null || targetType === null || currentType === targetType;
    if (sameName && sameType) kept.push(name);
    else dropped.push(name);
  }
  const missing = targetFields.filter((name) => !kept.includes(name));

  if (lastSpreadIndex(object) !== -1 && (dropped.length > 0 || missing.length > 0)) {
    throw new CodeFlowError(
      "patch-not-editable",
      `The argument of "${node.label}" spreads another object, so its fields cannot be reconciled with "${target.label}" — edit it in the code view (06 §1).`,
    );
  }

  if (kept.length === 0 && (dropped.length > 0 || missing.length > 0)) {
    // Nothing carries over: the whole argument literal is what changed, so it
    // is what gets replaced — in its own layout (06 §4).
    edits.push(
      ...replaceFieldsEdit(
        object,
        missing.map((name) => ({ name, value: { kind: "expression", text: "undefined" } as const })),
        input.style,
        input.source,
      ),
    );
  } else {
    for (const name of dropped) {
      edits.push(...removePropertyEdits(object, name, input.style, input.source));
    }
    // Anchor new fields on the last *surviving* property so an addition never
    // lands inside a range this same patch removes.
    const anchorName = kept[kept.length - 1];
    const anchor = anchorName === undefined ? undefined : findProperty(object, anchorName)?.property;
    for (const name of missing) {
      edits.push(
        ...addPropertyEdit(
          object,
          name,
          { kind: "expression", text: "undefined" },
          input.style,
          input.source,
          anchor,
        ),
      );
    }
  }

  if (dropped.length > 0 || missing.length > 0) {
    diagnostics.push({
      severity: "warning",
      code: "tool-replace-reconfigure",
      message: `"${current?.label ?? currentPath}" was replaced by "${target.label}", which is not argument-compatible${dropped.length > 0 ? `: ${dropped.join(", ")} did not carry over` : ""}${missing.length > 0 ? `${dropped.length > 0 ? "; " : ": "}${missing.join(", ")} still needs configuration` : ""} (06 §2).`,
      source: node.source,
    });
  }

  const outputChanged =
    canonicalJson(current?.outputSchema ?? null) !== canonicalJson(target.outputSchema ?? null);
  const hasReaders = input.graph.edges.some((edge) => edge.kind === "data" && edge.source === node.id);
  if (outputChanged && hasReaders) {
    diagnostics.push({
      severity: "warning",
      code: "output-type-changed",
      message: `The output of "${target.label}" has a different type than "${current?.label ?? currentPath}" and is read downstream — check the nodes that use it (06 §2).`,
      source: node.source,
    });
  }

  return { edits, diagnostics, removed: [] };
}
