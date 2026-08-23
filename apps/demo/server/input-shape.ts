/**
 * The trigger's input, described well enough to build a form out of.
 *
 * `input.ts` answers "what should this run start from" with a value. This
 * answers the other half — "what *shape* is allowed" — because a value alone
 * cannot tell a UI that `depth` is a number, that `suite` is one of three
 * strings, or that `roots` is a list you can add a row to. Per 01 §1 the flow's
 * first parameter type *is* the trigger, so this reads exactly that type and
 * nothing else.
 *
 * It runs on the server for one reason: the rules it describes are the rules in
 * `input.ts`, and `input.ts` needs the TypeScript parser. Duplicating either
 * half in the browser would give the demo two answers to the same question and
 * eventually two different ones.
 *
 * ## What it refuses to do
 *
 * Every shape it cannot express as a control comes back as `kind: "json"` **with
 * the reason written out** — a union of object shapes, a `Record`, a generic, an
 * `unknown`, a named type this module will not resolve. 07 §5: never approximate
 * without saying so. Dropping such a field from the form would be the worst of
 * the three options, because the run would still be given a value for it and
 * nobody would have seen what it was.
 */

import ts from "typescript";

import { explainDefault, flowFunction, synthesizeInput, WORKSPACE_TOKEN, type InputContext } from "./input.ts";

/** A control the form can render, or an escape hatch that says why it cannot. */
export type FieldKind = "string" | "number" | "boolean" | "enum" | "array" | "object" | "json";

export interface EnumOption {
  value: string | number;
  label: string;
}

export interface FieldSpec {
  /** Property name as written in the type. */
  name: string;
  /** Dotted path from the root of the input — `roots`, `limits.maxFiles`. */
  path: string;
  kind: FieldKind;
  /** The type as the flow's author wrote it, for the "what does it want" line. */
  typeText: string;
  /** `foo?: string` or `string | undefined`. */
  optional: boolean;
  /** `kind: "enum"` — the literal members, in source order. */
  options?: EnumOption[];
  /** `kind: "array"` — what one row is. Never itself an array or object. */
  item?: { kind: "string" | "number" | "boolean" | "enum"; typeText: string; options?: EnumOption[] };
  /** `kind: "object"` — one level of nesting, each leaf a control of its own. */
  fields?: FieldSpec[];
  /** `kind: "json"` — the sentence explaining why there is no control for this. */
  reason?: string;
  /** Why the synthesized default is what it is; absent when there is no rule behind it. */
  why?: string;
}

export type TriggerInputSpec =
  | {
      /** The flow declares no first parameter: there is nothing to fill in. */
      kind: "none";
      paramName: null;
      typeText: null;
      fields: [];
      suggested: Record<string, never>;
      workspaceToken: string;
    }
  | {
      /** A form: every top-level property got a control (some of them JSON ones). */
      kind: "object";
      paramName: string;
      typeText: string;
      fields: FieldSpec[];
      suggested: Record<string, unknown>;
      workspaceToken: string;
    }
  | {
      /** No form at all — the whole input is edited as JSON, and `reason` says why. */
      kind: "json";
      paramName: string;
      typeText: string | null;
      reason: string;
      fields: [];
      suggested: Record<string, unknown>;
      workspaceToken: string;
    };

/* -------------------------------------------------------------------------- */
/* reading a type node                                                         */
/* -------------------------------------------------------------------------- */

function text(node: ts.Node): string {
  return node.getText().replace(/\s+/g, " ").trim();
}

/** `T | undefined` → `[T, true]`; anything else → `[node, false]`. */
function unwrapOptional(type: ts.TypeNode): { type: ts.TypeNode; optional: boolean } {
  if (!ts.isUnionTypeNode(type)) return { type, optional: false };
  const defined = type.types.filter(
    (member) =>
      member.kind !== ts.SyntaxKind.UndefinedKeyword &&
      !(ts.isLiteralTypeNode(member) && member.literal.kind === ts.SyntaxKind.NullKeyword),
  );
  if (defined.length === type.types.length) return { type, optional: false };
  if (defined.length === 1 && defined[0] !== undefined) return { type: defined[0], optional: true };
  return { type: ts.factory.createUnionTypeNode(defined), optional: true };
}

function literalOption(member: ts.TypeNode): EnumOption | null {
  if (!ts.isLiteralTypeNode(member)) return null;
  const literal = member.literal;
  if (ts.isStringLiteral(literal)) return { value: literal.text, label: literal.text };
  if (ts.isNumericLiteral(literal)) return { value: Number(literal.text), label: literal.text };
  return null;
}

/** Every member a literal → a select; otherwise `null` and the caller explains. */
function enumOptions(type: ts.TypeNode): EnumOption[] | null {
  if (!ts.isUnionTypeNode(type)) return null;
  const options: EnumOption[] = [];
  for (const member of type.types) {
    const option = literalOption(member);
    if (option === null) return null;
    options.push(option);
  }
  return options.length > 0 ? options : null;
}

const PRIMITIVE: Partial<Record<ts.SyntaxKind, "string" | "number" | "boolean">> = {
  [ts.SyntaxKind.StringKeyword]: "string",
  [ts.SyntaxKind.NumberKeyword]: "number",
  [ts.SyntaxKind.BooleanKeyword]: "boolean",
};

/**
 * Why a type gets the JSON editor instead of a control.
 *
 * Written as a sentence a reader who is not holding the TypeScript spec can act
 * on — "this is a union of object shapes, and the form cannot know which one you
 * mean" tells you to go write the object; "no control for `Widget`" does not.
 */
function whyNoControl(type: ts.TypeNode, depth: number): string {
  const shown = text(type);
  if (type.kind === ts.SyntaxKind.UnknownKeyword || type.kind === ts.SyntaxKind.AnyKeyword) {
    return `\`${shown}\` says nothing about what a value would look like, so there is no control to offer — write it as JSON.`;
  }
  if (ts.isUnionTypeNode(type)) {
    return `\`${shown}\` is a union whose members are not all literals, so a select would have to guess which one you mean — write it as JSON.`;
  }
  if (ts.isTypeReferenceNode(type)) {
    const name = text(type.typeName);
    return type.typeArguments === undefined
      ? `\`${shown}\` is a named type. The demo reads this flow's text and nothing else, so it never sees what \`${name}\` resolves to — write it as JSON.`
      : `\`${shown}\` is a generic type with no fixed set of properties, so there is no field list to build — write it as JSON.`;
  }
  if (ts.isTypeLiteralNode(type) && depth > 0) {
    return `\`${shown}\` is nested more than one level deep. The form stops at one level so it stays readable — write this one as JSON.`;
  }
  if (ts.isArrayTypeNode(type) || ts.isTupleTypeNode(type)) {
    return `\`${shown}\` is a list of things that are not plain values, so there is no single row control — write it as JSON.`;
  }
  if (ts.isFunctionTypeNode(type)) {
    return `\`${shown}\` is a function. A trigger payload arrives as JSON and cannot carry one.`;
  }
  return `\`${shown}\` is not a shape this form can express — write it as JSON.`;
}

function describeField(name: string, path: string, declared: ts.TypeNode | undefined, depth: number): FieldSpec {
  if (declared === undefined) {
    return {
      name,
      path,
      kind: "json",
      typeText: "unknown",
      optional: false,
      reason: `\`${name}\` has no type written on it, so there is nothing to build a control from — write it as JSON.`,
    };
  }

  const typeText = text(declared);
  const { type, optional } = unwrapOptional(declared);
  const base = { name, path, typeText, optional };

  const primitive = PRIMITIVE[type.kind];
  if (primitive !== undefined) {
    const why = explainDefault(name, primitive);
    return { ...base, kind: primitive, ...(why === null ? {} : { why }) };
  }

  const options = enumOptions(type);
  if (options !== null) return { ...base, kind: "enum", options };

  if (ts.isArrayTypeNode(type)) {
    const element = type.elementType;
    const elementPrimitive = PRIMITIVE[element.kind];
    if (elementPrimitive !== undefined) {
      const why = explainDefault(name, elementPrimitive);
      return {
        ...base,
        kind: "array",
        item: { kind: elementPrimitive, typeText: text(element) },
        ...(why === null ? {} : { why }),
      };
    }
    const elementOptions = enumOptions(element);
    if (elementOptions !== null) {
      return { ...base, kind: "array", item: { kind: "enum", typeText: text(element), options: elementOptions } };
    }
    return { ...base, kind: "json", reason: whyNoControl(type, depth) };
  }

  if (ts.isTypeLiteralNode(type) && depth === 0) {
    return { ...base, kind: "object", fields: describeMembers(type, path, depth + 1) };
  }

  return { ...base, kind: "json", reason: whyNoControl(type, depth) };
}

function describeMembers(type: ts.TypeLiteralNode, prefix: string, depth: number): FieldSpec[] {
  const fields: FieldSpec[] = [];
  for (const member of type.members) {
    if (!ts.isPropertySignature(member) || member.name === undefined) {
      // An index signature, a call signature, a method — none of which is a
      // property anyone can type a value into, and all of which the run would
      // still be handed a value for if this quietly ignored them.
      fields.push({
        name: text(member),
        path: prefix === "" ? text(member) : `${prefix}.${text(member)}`,
        kind: "json",
        typeText: text(member),
        optional: false,
        reason: `\`${text(member)}\` is not a plain property, so it has no single control — the whole object is written as JSON instead.`,
      });
      continue;
    }
    const key = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
    if (key === null) continue;
    const path = prefix === "" ? key : `${prefix}.${key}`;
    const spec = describeField(key, path, member.type, depth);
    fields.push(member.questionToken === undefined ? spec : { ...spec, optional: true });
  }
  return fields;
}

/* -------------------------------------------------------------------------- */
/* the entry point                                                             */
/* -------------------------------------------------------------------------- */

/**
 * What the trigger of `source` takes, and what a run would start from.
 *
 * `suggested` is `synthesizeInput`'s answer, synthesized against
 * `WORKSPACE_TOKEN` rather than a real directory — see the token's own docs for
 * why. Never throws: a file that will not parse is the analyzer's story to tell
 * on the canvas, not a reason for the Run button to go quiet.
 */
export function describeTriggerInput(source: string): TriggerInputSpec {
  const context: InputContext = { scratch: WORKSPACE_TOKEN };
  const suggested = synthesizeInput(source, context);

  let parameter: ts.ParameterDeclaration | undefined;
  try {
    const file = ts.createSourceFile("flow.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    parameter = flowFunction(file)?.parameters[0];
  } catch {
    parameter = undefined;
  }

  if (parameter === undefined) {
    return { kind: "none", paramName: null, typeText: null, fields: [], suggested: {}, workspaceToken: WORKSPACE_TOKEN };
  }

  const paramName = parameter.name.getText();
  const declared = parameter.type;

  if (declared === undefined) {
    return {
      kind: "json",
      paramName,
      typeText: null,
      reason: `\`${paramName}\` has no type written on it, so the trigger declares nothing about what it takes. Whatever you put here is passed through as-is.`,
      fields: [],
      suggested,
      workspaceToken: WORKSPACE_TOKEN,
    };
  }

  const { type } = unwrapOptional(declared);
  if (!ts.isTypeLiteralNode(type)) {
    return {
      kind: "json",
      paramName,
      typeText: text(declared),
      reason: whyNoControl(type, 0),
      fields: [],
      suggested,
      workspaceToken: WORKSPACE_TOKEN,
    };
  }

  return {
    kind: "object",
    paramName,
    typeText: text(declared),
    fields: describeMembers(type, "", 0),
    suggested,
    workspaceToken: WORKSPACE_TOKEN,
  };
}
