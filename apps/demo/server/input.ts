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

/**
 * The stand-in for "the run's scratch directory", used when a default is
 * synthesized *before* a run exists.
 *
 * The scratch directory is `mkdtemp`'d per run and deleted at the end of it, so
 * a default shown in the browser — or remembered in `localStorage` from
 * yesterday — cannot contain a real one: the path it names is already gone.
 * Synthesizing against this token and expanding it in `startRun` keeps a
 * remembered input pointing at *this* run's folder instead of a dead one, and
 * gives the UI something it can name in words rather than an opaque
 * `/var/folders/...`.
 */
export const WORKSPACE_TOKEN = "{{workspace}}";

/** Every `{{workspace}}` in `input`, replaced with the run's real directory. */
export function resolveWorkspaceToken(input: unknown, workspace: string): unknown {
  if (typeof input === "string") return input.split(WORKSPACE_TOKEN).join(workspace);
  if (Array.isArray(input)) return input.map((item) => resolveWorkspaceToken(item, workspace));
  if (typeof input === "object" && input !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      out[key] = resolveWorkspaceToken(value, workspace);
    }
    return out;
  }
  return input;
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
 * Documents the scratch workspace is seeded with, matchable by their own name.
 *
 * `seedWorkspace` in `runner.ts` writes these; the list is here because this is
 * the module that has to decide what `ticketsPath` means, and a rule that
 * pointed it at `README.md` is why a flow whose whole job is reading tickets
 * answered `status: "unreadable"` on its first run — honestly, and uselessly.
 *
 * `test/workspace-seed.test.ts` requires every name here to be a file the
 * runner actually creates, so the two cannot drift into a default that names a
 * document nobody wrote.
 */
export const WORKSPACE_DOCUMENTS = ["orders.json", "tickets.json"];

/**
 * The seeded document a parameter name is asking for, if it names one.
 *
 * Matched on the file's own stem, in singular or plural, so `ticketsPath`,
 * `ticketPath` and `tickets` all reach `tickets.json` while `summaryPath` — a
 * file to write — reaches none of them.
 */
function documentFor(parts: readonly string[]): string | undefined {
  return WORKSPACE_DOCUMENTS.find((file) => {
    const stem = file.slice(0, file.lastIndexOf("."));
    return parts.some((word) => word === stem || `${word}s` === stem);
  });
}

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

  // A name that says which document it wants gets that document. `ticketsPath`
  // means `tickets.json`, not "some file that exists".
  const document = documentFor(parts);
  if (document !== undefined) return `${context.scratch}/${document}`;

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
  // A flow that filters on a status wants a status something in the workspace
  // actually has. `demo status` matched nothing, so the digest flow read four
  // orders, kept none, and reported `no-totals` — true, and a demonstration of
  // nothing.
  if (lower.includes("status")) return "paid";
  if (lower.includes("package")) return "@codeflow/demo";
  if (lower.includes("branch")) return "main";
  if (lower.includes("pattern") || lower.includes("glob")) return "*.txt";
  if (lower.includes("email")) return "demo@example.invalid";
  return `demo ${name}`;
}

/**
 * Why `stringFor`/`valueForType` chose what they chose, in one sentence.
 *
 * A guess a visitor cannot see is a guess they cannot judge, and 07 §5 does not
 * allow the UI to approximate without saying so. `sourceRoot` being
 * `/var/folders/…` looks arbitrary right up until someone says *why*, so the
 * reasons live here, next to the rules that produce them — one function, so a
 * rule and its explanation cannot drift apart.
 *
 * `null` for anything that has no rule behind it: the fallback `demo <name>` is
 * not a guess about the field, it is the absence of one, and dressing it up as
 * reasoning would be the same lie in a different place.
 */
export function explainDefault(name: string, kind: "string" | "number" | "boolean"): string | null {
  const parts = words(name);
  const lower = name.toLowerCase();

  if (kind === "number") {
    return /count|limit|max|top|n$/i.test(name)
      ? "a small count, so a demo run does a few of whatever this bounds rather than all of it"
      : null;
  }
  if (kind === "boolean") {
    return /prune|delete|remove|force|overwrite|dry/i.test(name)
      ? "false, because the name sounds destructive and a run nobody asked for should be read-only"
      : null;
  }

  if (parts.some((word) => DIRISH.has(word))) {
    return "pointed at the run's scratch folder, because the filesystem MCP server is rooted there and refuses every path outside it";
  }
  if (parts.some((word) => OUTISH.has(word))) {
    return "a fresh file inside the run's scratch folder, because the name reads as somewhere to write — and a path the flow writes must not be one it also reads";
  }
  const document = documentFor(parts);
  if (document !== undefined) {
    return `\`${document}\` in the run's scratch folder, because the name asks for that document and the folder is seeded with one`;
  }
  if (parts.some((word) => FILEISH.has(word)) || parts.includes("path")) {
    return "a file the scratch folder is seeded with, because the name reads as a file and a first tool call on a missing one fails before the flow does anything";
  }
  if (parts.some((word) => word === "delimiter" || word === "separator")) return "the most common delimiter";
  if (lower.includes("repo")) return "a real public repository, so a GitHub-shaped argument reads like one";
  if (lower.includes("channel")) return "a channel-shaped name";
  if (lower.includes("url") || lower.includes("href")) return "a URL on the reserved `.invalid` domain, which cannot resolve to anyone's real host";
  if (lower.includes("query") || lower.includes("search")) return "a search phrase with results in the seeded workspace";
  if (lower.includes("status")) return "a status the seeded orders document actually uses, so a filter on it keeps something";
  if (lower.includes("package")) return "this workspace's own package name";
  if (lower.includes("branch")) return "the usual default branch";
  if (lower.includes("pattern") || lower.includes("glob")) return "a glob that matches the seeded files";
  if (lower.includes("email")) return "an address on the reserved `.invalid` domain, which cannot reach anyone";
  return null;
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
export function flowFunction(file: ts.SourceFile): ts.FunctionDeclaration | null {
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
