/**
 * The `input` a run starts from.
 *
 * A flow's first parameter is a plain TypeScript type — `{ packageName: string;
 * sourceRoot: string; prune: boolean }` — and nobody wants to hand-write a JSON
 * object before they can press Run. So one is derived from that type, with two
 * rules that make the difference between a run that does something and a run
 * that immediately fails:
 *
 *  - anything that reads like a **path** (`path`, `dir`, `root`, `folder`) is
 *    pointed at the run's scratch directory. A filesystem MCP server rooted
 *    there refuses everything else, so this is not a nicety;
 *  - names that carry an obvious convention (`repo`, `channel`, `query`, `url`)
 *    get a value of that shape, so a stub's arguments read like arguments.
 *
 * Anything the caller supplies wins over all of it — the endpoint takes an
 * `input` and this is only the default.
 */

import ts from "typescript";

export interface InputContext {
  /** Absolute path of the run's scratch directory. */
  scratch: string;
}

/** `sourceRoot` → `["source", "root"]`, so a suffix can be recognised. */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.toLowerCase());
}

const DIRISH = new Set(["dir", "directory", "root", "folder", "cwd", "workspace", "tree"]);
const FILEISH = new Set(["file", "manifest", "doc", "readme", "config", "plan"]);
/** Names that read as somewhere to *write*, which must be a fresh path. */
const OUTISH = new Set(["out", "output", "dest", "destination", "target", "ledger", "rejects", "report", "result", "summary", "artifact"]);

/**
 * A path-shaped name gets a real path — and the distinction between a
 * *directory* and a *file* is not cosmetic. `manifestPath` pointed at the
 * scratch directory made the first real MCP call in `doc-freshness-audit` fail
 * with `EISDIR` before the flow could do anything, which looked like a broken
 * flow and was a broken default.
 */
function stringFor(name: string, context: InputContext): string {
  const parts = words(name);
  const lower = name.toLowerCase();
  if (parts.some((word) => DIRISH.has(word))) return context.scratch;

  // A path the flow *writes* must not be a path it also reads: pointing
  // `ledgerPath` at README.md would have a run quietly overwrite the workspace
  // it was reading from.
  if (parts.some((word) => OUTISH.has(word))) {
    const extension = parts.includes("json") ? "json" : parts.includes("md") ? "md" : "txt";
    return `${context.scratch}/${parts.join("-")}.${extension}`;
  }

  if (parts.some((word) => FILEISH.has(word))) {
    const json = parts.some((word) => word === "manifest" || word === "package" || word === "json" || word === "plan");
    return `${context.scratch}/${json ? "package.json" : "README.md"}`;
  }
  if (parts.includes("path")) return `${context.scratch}/README.md`;
  if (parts.some((word) => word === "delimiter" || word === "separator")) return ",";
  if (lower.includes("repo")) return "modelcontextprotocol/servers";
  if (lower.includes("channel")) return "#demo";
  if (lower.includes("url") || lower.includes("href")) return "https://example.invalid/demo";
  if (lower.includes("query") || lower.includes("search")) return "model context protocol";
  if (lower.includes("package")) return "@codeflow/demo";
  if (lower.includes("branch")) return "main";
  if (lower.includes("pattern") || lower.includes("glob")) return "*.txt";
  if (lower.includes("email")) return "demo@example.invalid";
  return `demo ${name}`;
}

function valueForType(type: ts.TypeNode | undefined, name: string, context: InputContext, depth = 0): unknown {
  if (type === undefined || depth > 5) return `demo ${name}`;

  switch (type.kind) {
    case ts.SyntaxKind.StringKeyword:
      return stringFor(name, context);
    case ts.SyntaxKind.NumberKeyword:
      return /count|limit|max|top|n$/i.test(name) ? 3 : 1;
    case ts.SyntaxKind.BooleanKeyword:
      // `false` for anything that sounds destructive, so a default run is a
      // read-only one wherever the flow offers the choice.
      return !/prune|delete|remove|force|overwrite|dry/i.test(name);
    case ts.SyntaxKind.AnyKeyword:
    case ts.SyntaxKind.UnknownKeyword:
      return null;
    default:
      break;
  }

  if (ts.isArrayTypeNode(type)) return [valueForType(type.elementType, name, context, depth + 1)];
  if (ts.isLiteralTypeNode(type)) {
    const literal = type.literal;
    if (ts.isStringLiteral(literal)) return literal.text;
    if (ts.isNumericLiteral(literal)) return Number(literal.text);
    if (literal.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (literal.kind === ts.SyntaxKind.FalseKeyword) return false;
    return null;
  }
  if (ts.isUnionTypeNode(type)) {
    const first = type.types.find((member) => member.kind !== ts.SyntaxKind.UndefinedKeyword) ?? type.types[0];
    return valueForType(first, name, context, depth + 1);
  }
  if (ts.isTypeLiteralNode(type)) {
    const out: Record<string, unknown> = {};
    for (const member of type.members) {
      if (!ts.isPropertySignature(member) || member.name === undefined) continue;
      const key = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null;
      if (key === null) continue;
      out[key] = valueForType(member.type, key, context, depth + 1);
    }
    return out;
  }
  return null;
}

/** The default-exported flow function, if the file has one. */
function flowFunction(file: ts.SourceFile): ts.FunctionDeclaration | null {
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement)) continue;
    const modifiers = ts.getModifiers(statement) ?? [];
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) return statement;
  }
  return null;
}

/**
 * A plausible `input` for `source`, or `{}` when the flow declares none.
 *
 * Never throws: an unparseable file is the analyzer's problem to report, not
 * something that should stop the Run button from explaining itself.
 */
export function synthesizeInput(source: string, context: InputContext): Record<string, unknown> {
  try {
    const file = ts.createSourceFile("flow.ts", source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
    const flow = flowFunction(file);
    const parameter = flow?.parameters[0];
    if (parameter === undefined) return {};
    const value = valueForType(parameter.type, "input", context);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
