/**
 * The one type check this demo can honestly make.
 *
 * QA BUG-3: the model was asked to set `width` — schema `number` — to the text
 * `"extra-wide"`. It did, validation passed, Apply succeeded, and the issues
 * button said **No issues**. The panel had been promising that answers are
 * "checked against the flow contract", and a reader could only conclude that
 * `width: "extra-wide"` is fine. It is not; nothing was checking.
 *
 * Core deliberately has no type checker — it parses with `noLib`/`noResolve` so
 * analysis stays browser-safe (02 §3), and 10 §5 makes the type-check pass
 * conditional on "the validate environment having one". This module is the
 * narrow, real version of that pass for a browser: for every argument written as
 * a **literal**, compare the literal's kind against the registry schema for that
 * property. It is deliberately incomplete —
 *
 *   - an argument written as an expression (`row.width`, `count()`, a variable)
 *     is skipped, because knowing its type needs a real checker;
 *   - only tools and library functions with a schema are covered.
 *
 * — and everything it does report is certain. That asymmetry is the point: a
 * check that never guesses can be shown to the user as fact, and the UI can say
 * exactly what it covers instead of implying it covers everything (07 §5).
 */

import type {
  Diagnostic,
  RegistryLookup,
  Schema,
  SourceMapping,
  WorkflowGraph,
  WorkflowNode,
} from "@codeflow/core";

/** What a literal argument is, judged from its source text alone. */
type LiteralKind = "string" | "number" | "boolean" | "null" | "array" | "object";

export interface ArgumentTypeProblem {
  nodeId: string;
  nodeLabel: string;
  field: string;
  expected: string;
  found: LiteralKind;
  raw: string;
  message: string;
  /** Where the step lives, so the diagnostics panel can navigate to it. */
  source?: SourceMapping;
}

const STRING = /^(?:'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)$/s;
const NUMBER = /^[+-]?(?:\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?|0[xX][\dA-Fa-f_]+|\.\d[\d_]*)$/;

/** `null` when the text is not a literal — i.e. when this module must stay quiet. */
function literalKind(raw: string): LiteralKind | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  if (STRING.test(text)) return "string";
  if (NUMBER.test(text)) return "number";
  if (text === "true" || text === "false") return "boolean";
  if (text === "null") return "null";
  // A bracket/brace *opening* the text is only an array/object literal if it
  // also closes it; `[a, b].map(…)` is an expression, and expressions are out
  // of scope.
  if (text.startsWith("[") && text.endsWith("]")) return "array";
  if (text.startsWith("{") && text.endsWith("}")) return "object";
  return null;
}

/** JSON Schema `type` (or a TS type ref), normalised to the names above. */
function expectedKinds(schema: unknown): { kinds: Set<LiteralKind>; label: string } | null {
  if (typeof schema === "string") {
    const ref = schema.trim();
    if (ref === "number") return { kinds: new Set<LiteralKind>(["number"]), label: "number" };
    if (ref === "boolean") return { kinds: new Set<LiteralKind>(["boolean"]), label: "boolean" };
    if (ref === "string") return { kinds: new Set<LiteralKind>(["string"]), label: "string" };
    return null;
  }
  if (typeof schema !== "object" || schema === null) return null;

  const record = schema as Record<string, unknown>;
  // A union, a `$ref`, a composed schema — too many ways to be right for a
  // check that is only allowed to speak when it is certain.
  if (record["oneOf"] !== undefined || record["anyOf"] !== undefined || record["allOf"] !== undefined) return null;
  if (record["$ref"] !== undefined) return null;

  const declared = record["type"];
  const names = typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : [];
  if (names.length === 0) return null;

  const kinds = new Set<LiteralKind>();
  for (const name of names) {
    if (name === "string") kinds.add("string");
    else if (name === "number" || name === "integer") kinds.add("number");
    else if (name === "boolean") kinds.add("boolean");
    else if (name === "null") kinds.add("null");
    else if (name === "array") kinds.add("array");
    else if (name === "object") kinds.add("object");
    else return null;
  }
  if (record["nullable"] === true) kinds.add("null");
  return { kinds, label: names.join(" or ") };
}

function propertySchema(input: Schema | undefined, field: string): unknown {
  if (input === undefined || typeof input === "string") return undefined;
  const record = input as Record<string, unknown>;
  const properties = record["properties"];
  if (properties !== undefined && typeof properties === "object" && properties !== null) {
    return (properties as Record<string, unknown>)[field];
  }
  // Named-fields shorthand (03 §11 shape 3): the map *is* the properties.
  return record[field];
}

function schemaFor(node: WorkflowNode, registry: RegistryLookup): Schema | undefined {
  const toolName = node.data["toolName"];
  if (typeof toolName === "string") return registry.getTool(toolName)?.inputSchema;
  const functionName = node.data["functionName"];
  if (typeof functionName === "string") return registry.getFunction(functionName)?.inputSchema;
  return undefined;
}

const ARTICLE: Record<LiteralKind, string> = {
  string: "a piece of text",
  number: "a number",
  boolean: "true/false",
  null: "null",
  array: "a list",
  object: "an object",
};

const WANTED: Record<string, string> = {
  string: "a piece of text",
  number: "a number",
  integer: "a whole number",
  boolean: "true/false",
  array: "a list",
  object: "an object",
};

function wanted(label: string): string {
  return label
    .split(" or ")
    .map((name) => WANTED[name] ?? name)
    .join(" or ");
}

/**
 * The same vocabulary, for anything else in this app that has to tell someone
 * their value is the wrong kind.
 *
 * The trigger-input panel makes exactly this complaint about exactly this
 * mistake — a piece of text where the type says number — and two different
 * phrasings for one error would read as two different errors. `wanted` takes a
 * schema/type name; `describeValue` takes a value that already exists, which is
 * the one thing this module never had (it judges source text, not runtime
 * values).
 */
export function describeExpectedType(name: string): string {
  return wanted(name);
}

export function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "nothing";
  if (Array.isArray(value)) return "a list";
  switch (typeof value) {
    case "string":
      return "a piece of text";
    case "number":
      return Number.isFinite(value) ? "a number" : "not a number";
    case "boolean":
      return "true/false";
    case "object":
      return "an object";
    default:
      return `a ${typeof value}`;
  }
}

/**
 * Every literal argument in `graph` whose kind contradicts its schema.
 *
 * Pure, synchronous and cheap — it reads `node.data.arguments`, which the
 * analyzer already produced, and never re-parses.
 */
export function argumentTypeProblems(
  graph: WorkflowGraph,
  registry: RegistryLookup,
): ArgumentTypeProblem[] {
  const problems: ArgumentTypeProblem[] = [];

  for (const node of graph.nodes) {
    if (node.type !== "tool" && node.type !== "function") continue;
    const args = node.data["arguments"];
    if (args === null || typeof args !== "object") continue;
    const schema = schemaFor(node, registry);
    if (schema === undefined) continue;

    for (const [field, value] of Object.entries(args as Record<string, unknown>)) {
      const raw = typeof value === "string" ? value : String(value);
      const found = literalKind(raw);
      if (found === null) continue;

      const expected = expectedKinds(propertySchema(schema, field));
      if (expected === null) continue;
      if (expected.kinds.has(found)) continue;

      problems.push({
        nodeId: node.id,
        nodeLabel: node.label,
        field,
        expected: expected.label,
        found,
        raw: raw.length > 40 ? `${raw.slice(0, 39)}…` : raw,
        ...(node.source === undefined ? {} : { source: node.source }),
        message: `“${node.label}” · ${field} wants ${wanted(expected.label)}, but this is ${ARTICLE[found]} (${
          raw.length > 40 ? `${raw.slice(0, 39)}…` : raw
        }).`,
      });
    }
  }

  return problems;
}

/** The same findings, in the shape every diagnostics list already renders. */
export function argumentTypeDiagnostics(
  graph: WorkflowGraph,
  registry: RegistryLookup,
): Diagnostic[] {
  return argumentTypeProblems(graph, registry).map(toDiagnostic);
}

export function toDiagnostic(problem: ArgumentTypeProblem): Diagnostic {
  return {
    severity: "error",
    code: "argument-type-mismatch",
    message: `${problem.message} The flow would fail the moment it ran.`,
    ...(problem.source === undefined ? {} : { source: problem.source }),
  };
}

/**
 * `graph` with the argument-type findings folded into its diagnostics.
 *
 * The panel on the canvas reads `graph.diagnostics` and nothing else, which is
 * why a flow with `width: "extra-wide"` in it could be applied and still be
 * announced as **No issues** (BUG-3). The host owns the graph it renders, so it
 * is the host's job to add the checks its environment can make.
 */
export function withArgumentTypes(graph: WorkflowGraph, registry: RegistryLookup): WorkflowGraph {
  const extra = argumentTypeDiagnostics(graph, registry);
  if (extra.length === 0) return graph;
  return { ...graph, diagnostics: [...graph.diagnostics, ...extra] };
}
