/**
 * Statement-level edits — delete, insert, retarget, replace opaque regions
 * (06 §2, §4).
 *
 * Every one of these is still a text replacement of the smallest affected range:
 * deleting takes the statement's own line (and a comment sitting on it),
 * inserting adds one line at a block boundary with the indentation already in
 * use there, retargeting a tool rewrites only the call path after the `tools`
 * binding. Nothing here reprints a parent node.
 */

import { Node, SyntaxKind } from "ts-morph";
import type { Block, SourceFile } from "ts-morph";
import { CodeFlowError } from "../errors.js";
import type { TextEdit } from "./edits.js";
import { indentAt, lineEndOf, lineStartOf, startsLine, type SourceStyle } from "./style.js";

/** A statement's line, plus a trailing same-line comment, may go with it. */
const TAIL = /^[ \t]*(\/\/[^\n]*|\/\*(?:[^*]|\*(?!\/))*\*\/[ \t]*)?\r?\n$/;

/**
 * Remove a statement span. When the statement owns its line, the line goes with
 * it (including a comment on that line, 06 §4); otherwise only the statement
 * text is removed, so neighbours on the same line survive untouched.
 */
export function deleteRangeEdits(source: string, start: number, end: number): TextEdit[] {
  if (startsLine(source, start)) {
    const lineEnd = lineEndOf(source, end);
    const tail = source.slice(end, lineEnd);
    if (TAIL.test(tail) || (lineEnd === source.length && tail.trim().length === 0)) {
      return [{ start: lineStartOf(source, start), end: lineEnd, newText: "" }];
    }
  }
  // The statement shares its line with something else: take the separating
  // spaces with it so the neighbour does not drift right.
  let cut = end;
  while (cut < source.length && (source[cut] === " " || source[cut] === "\t")) cut += 1;
  return [{ start, end: cut, newText: "" }];
}

/**
 * True when `statement` is the *entire* brace-less body of an enclosing
 * construct: `if (x) continue;`, `else return 1;`, `for (…) doIt();`.
 *
 * Deleting the text of such a statement does not delete a step — it promotes
 * whatever comes next into the body:
 *
 *     if (pr.draft) continue;          →   if (pr.draft)
 *     await tools.slack.send(…);            await tools.slack.send(…);
 *
 * which still parses, still type-checks, and now sends the message only for
 * draft PRs. A silent change of meaning is the worst outcome the patch engine
 * has (I6, and O2's "only the region the user edited changes"), so the caller
 * leaves an empty block behind instead — the same thing the braced form
 * already produces when its only statement is deleted.
 */
export function isUnbracedBody(statement: Node): boolean {
  if (Node.isBlock(statement)) return false;
  const parent = statement.getParent();
  if (parent === undefined) return false;
  if (Node.isIfStatement(parent)) {
    return parent.getThenStatement() === statement || parent.getElseStatement() === statement;
  }
  if (
    Node.isForStatement(parent) ||
    Node.isForOfStatement(parent) ||
    Node.isForInStatement(parent) ||
    Node.isWhileStatement(parent) ||
    Node.isDoStatement(parent) ||
    Node.isLabeledStatement(parent) ||
    Node.isWithStatement(parent)
  ) {
    return parent.getStatement() === statement;
  }
  return false;
}

export type InsertWhere = "before" | "after" | "append";

/** Insert a statement as its own line, indented like its new neighbours. */
export function insertStatementEdit(
  source: string,
  anchor: { start: number; end: number },
  where: Exclude<InsertWhere, "append">,
  text: string,
  style: SourceStyle,
): TextEdit {
  const indent = indentAt(source, anchor.start);
  const at = where === "before" ? lineStartOf(source, anchor.start) : lineEndOf(source, anchor.end);
  return { start: at, end: at, newText: `${indent}${text}${style.eol}` };
}

/** Append a statement at the end of a block, before its closing brace. */
export function appendToBlockEdit(
  source: string,
  block: Block,
  text: string,
  style: SourceStyle,
): TextEdit {
  const statements = block.getStatements();
  const closeBrace = block.getLastChildByKindOrThrow(SyntaxKind.CloseBraceToken);
  const indent =
    statements.length > 0
      ? indentAt(source, statements[statements.length - 1].getStart())
      : indentAt(source, closeBrace.getStart()) + style.indent;
  const at = lineStartOf(source, closeBrace.getStart());
  return { start: at, end: at, newText: `${indent}${text}${style.eol}` };
}

/* -------------------------------------------------------------------------- */
/* retarget a tool call — 06 §2                                                */
/* -------------------------------------------------------------------------- */

/**
 * Point a call at another tool, rewriting only the path after the `tools`
 * binding. Refused when the call goes through an alias (`const gh = tools.github`),
 * because the text after the root no longer *is* the tool path — rewriting it
 * would silently produce a different call (I6).
 */
export function retargetToolEdit(call: Node, currentPath: string, newPath: string): TextEdit {
  if (!Node.isCallExpression(call)) {
    throw new CodeFlowError("patch-unsupported", "Only a call expression can change its tool.");
  }
  const callee = call.getExpression();
  let root: Node = callee;
  while (Node.isPropertyAccessExpression(root)) root = root.getExpression();
  if (!Node.isIdentifier(root)) {
    throw new CodeFlowError(
      "patch-unsupported",
      "This call is not a plain `tools.<ns>.<fn>` chain — change the tool in the code view (06 §2).",
    );
  }
  if (callee.getText() !== `${root.getText()}.${currentPath}`) {
    throw new CodeFlowError(
      "patch-unsupported",
      `\`${callee.getText()}\` reaches \`${currentPath}\` through an alias — changing the tool here would rewrite a path that is not spelled out in the source. Edit it in the code view (06 §2).`,
    );
  }
  return { start: root.getEnd(), end: callee.getEnd(), newText: `.${newPath}` };
}

/* -------------------------------------------------------------------------- */
/* imports — 06 §2 (palette insert of a library function)                      */
/* -------------------------------------------------------------------------- */

/**
 * Make sure `name` is imported from `modulePath`, adding it to an existing
 * import of that module when there is one — a second import of the same module
 * would be redundant, and duplicate specifiers would not compile.
 */
export function ensureImportEdits(
  sourceFile: SourceFile,
  source: string,
  modulePath: string,
  name: string,
  style: SourceStyle,
): TextEdit[] {
  const imports = sourceFile.getImportDeclarations();
  const semicolon = style.semicolons ? ";" : "";

  for (const declaration of imports) {
    if (declaration.getModuleSpecifierValue() !== modulePath) continue;
    if (declaration.isTypeOnly()) continue;
    const named = declaration.getNamedImports();
    if (named.some((specifier) => (specifier.getAliasNode()?.getText() ?? specifier.getName()) === name)) {
      return [];
    }
    if (named.length === 0) continue;
    const last = named[named.length - 1];
    return [{ start: last.getEnd(), end: last.getEnd(), newText: `, ${name}` }];
  }

  const text = `import { ${name} } from ${style.quote}${modulePath}${style.quote}${semicolon}`;
  if (imports.length === 0) return [{ start: 0, end: 0, newText: `${text}${style.eol}` }];
  const last = imports[imports.length - 1];
  const at = lineEndOf(source, last.getEnd());
  return [{ start: at, end: at, newText: `${text}${style.eol}` }];
}

/* -------------------------------------------------------------------------- */
/* variable naming — 06 §2                                                     */
/* -------------------------------------------------------------------------- */

const VERB_PREFIXES = ["get", "fetch", "list", "load", "read", "find", "query"];

/**
 * Name for the binding of an inserted node: camelCase from the callable's name,
 * with a numeric suffix when the name is already taken (`files`, `files2` —
 * 06 §2).
 */
export function suggestVariableName(callable: string, taken: ReadonlySet<string>): string {
  const method = callable.includes(".") ? callable.slice(callable.lastIndexOf(".") + 1) : callable;
  let base = method;
  for (const prefix of VERB_PREFIXES) {
    if (base.length > prefix.length && base.startsWith(prefix) && /[A-Z]/.test(base[prefix.length])) {
      base = base.slice(prefix.length);
      break;
    }
  }
  base = base.charAt(0).toLowerCase() + base.slice(1);
  if (base.length === 0 || /^[0-9]/.test(base)) base = `result${base}`;
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}${String(index)}`)) index += 1;
  return `${base}${String(index)}`;
}

/** Every identifier spelled in the file — an over-approximation, on purpose. */
export function identifiersIn(sourceFile: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const identifier of sourceFile.getDescendantsOfKind(SyntaxKind.Identifier)) {
    names.add(identifier.getText());
  }
  return names;
}
