/**
 * Editing properties of an argument object literal — 06 §2, §4.
 *
 * Three operations, all expressed as replacements of the smallest affected
 * range: change a property's value, add a property, remove a property. The
 * shape of the surrounding literal is read from the source, never imposed:
 *
 *  - a shorthand property becomes longhand when its value changes (06 §1 —
 *    defined as the correct behaviour, with the data edge disappearing);
 *  - removing a property removes its whole line together with a comment on that
 *    line, and fixes the neighbouring comma to match the style already in use;
 *  - adding a property follows the literal's own layout (single- vs multi-line,
 *    its indentation, its trailing-comma habit).
 */

import { Node, SyntaxKind } from "ts-morph";
import type { ObjectLiteralExpression } from "ts-morph";
import type { TextEdit } from "./edits.js";
import { hasTrailingComma, indentAt, lineEndOf, lineStartOf, startsLine, type SourceStyle } from "./style.js";
import { formOf, renderValue, resolveValue, type FieldValue } from "./values.js";
import { findProperty, type PropertyLocation } from "./locate.js";

function syntaxChildren(object: ObjectLiteralExpression): Node[] {
  const list = object.getChildSyntaxList();
  return list === undefined ? [] : list.getChildren();
}

function commaAfter(object: ObjectLiteralExpression, property: Node): Node | null {
  const children = syntaxChildren(object);
  const index = children.findIndex((child) => child === property);
  if (index === -1) return null;
  const next = children[index + 1];
  return next !== undefined && next.getKind() === SyntaxKind.CommaToken ? next : null;
}

function commaBefore(object: ObjectLiteralExpression, property: Node): Node | null {
  const children = syntaxChildren(object);
  const index = children.findIndex((child) => child === property);
  if (index <= 0) return null;
  const previous = children[index - 1];
  return previous.getKind() === SyntaxKind.CommaToken ? previous : null;
}

function isMultiline(object: ObjectLiteralExpression): boolean {
  return object.getText().includes("\n");
}

/** Trailing-comma habit of *this* literal, falling back to the file's (06 §4). */
function trailingCommaOf(object: ObjectLiteralExpression, style: SourceStyle): boolean {
  const own = hasTrailingComma(object);
  return own ?? style.trailingComma;
}

/* -------------------------------------------------------------------------- */
/* set                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Change the value of an existing property. The edit covers the initializer
 * only — the property name, the comma and everything around it stay untouched
 * byte for byte. A shorthand property is the one exception: it is rewritten in
 * full, because `{ channel }` has no value range to replace (06 §1).
 */
export function setPropertyEdit(
  object: ObjectLiteralExpression,
  location: PropertyLocation,
  name: string,
  value: FieldValue,
  style: SourceStyle,
  source: string,
): TextEdit[] {
  if (location.shorthand) {
    const resolved = resolveValue(name, value, "none");
    if (resolved.kind === "remove") return removePropertyEditsIn(object, location, style, source);
    const text = renderValue(resolved, undefined, style);
    return [
      { start: location.property.getStart(), end: location.property.getEnd(), newText: `${name}: ${text}` },
    ];
  }

  const original = location.value;
  const resolved = resolveValue(name, value, formOf(original));
  if (resolved.kind === "remove") return removePropertyEditsIn(object, location, style, source);
  if (original === undefined) return [];
  const text = renderValue(resolved, original, style);
  return [{ start: original.getStart(), end: original.getEnd(), newText: text }];
}

/* -------------------------------------------------------------------------- */
/* add                                                                         */
/* -------------------------------------------------------------------------- */

export function addPropertyEdit(
  object: ObjectLiteralExpression,
  name: string,
  value: FieldValue,
  style: SourceStyle,
  source: string,
  /**
   * Anchor the insertion after this property instead of the last one — used
   * when a patch also removes properties, so the new text never lands inside a
   * range the same patch deletes.
   */
  after?: Node,
): TextEdit[] {
  const resolved = resolveValue(name, value, "none");
  if (resolved.kind === "remove") return [];
  const text = `${name}: ${renderValue(resolved, undefined, style)}`;

  const properties = after === undefined ? object.getProperties() : [after];
  const openBrace = object.getFirstChildByKindOrThrow(SyntaxKind.OpenBraceToken);
  const closeBrace = object.getLastChildByKindOrThrow(SyntaxKind.CloseBraceToken);
  const multiline = isMultiline(object);

  if (properties.length === 0) {
    if (!multiline) {
      return [{ start: openBrace.getEnd(), end: closeBrace.getStart(), newText: ` ${text} ` }];
    }
    const indent = indentAt(source, closeBrace.getStart()) + style.indent;
    const comma = trailingCommaOf(object, style) ? "," : "";
    return [
      {
        start: openBrace.getEnd(),
        end: closeBrace.getStart(),
        newText: `${style.eol}${indent}${text}${comma}${style.eol}${indentAt(source, closeBrace.getStart())}`,
      },
    ];
  }

  const last = properties[properties.length - 1];
  const comma = commaAfter(object, last);

  if (!multiline) {
    // Reuse the separator the literal already uses between its properties.
    const separator =
      properties.length > 1
        ? source.slice(properties[properties.length - 2].getEnd(), last.getStart())
        : ", ";
    if (comma !== null) return [{ start: comma.getEnd(), end: comma.getEnd(), newText: ` ${text}` }];
    return [{ start: last.getEnd(), end: last.getEnd(), newText: `${separator}${text}` }];
  }

  const indent = indentAt(source, last.getStart());
  if (comma !== null) {
    return [
      { start: comma.getEnd(), end: comma.getEnd(), newText: `${style.eol}${indent}${text},` },
    ];
  }
  return [{ start: last.getEnd(), end: last.getEnd(), newText: `,${style.eol}${indent}${text}` }];
}

/**
 * Replace *all* fields of a literal, keeping its layout (single- or multi-line,
 * its indentation, its trailing-comma habit).
 *
 * Used only when no property survives the edit — changing a tool to one with a
 * completely different input schema (06 §2). The affected AST node really is
 * the whole literal there, so replacing it is still the minimal patch; every
 * line around it stays byte-identical.
 */
export function replaceFieldsEdit(
  object: ObjectLiteralExpression,
  fields: ReadonlyArray<{ name: string; value: FieldValue }>,
  style: SourceStyle,
  source: string,
): TextEdit[] {
  const openBrace = object.getFirstChildByKindOrThrow(SyntaxKind.OpenBraceToken);
  const closeBrace = object.getLastChildByKindOrThrow(SyntaxKind.CloseBraceToken);
  const rendered = fields.map(({ name, value }) => {
    const resolved = resolveValue(name, value, "none");
    return resolved.kind === "remove" ? null : `${name}: ${renderValue(resolved, undefined, style)}`;
  });
  const parts = rendered.filter((entry): entry is string => entry !== null);
  if (parts.length === 0) {
    return [{ start: openBrace.getEnd(), end: closeBrace.getStart(), newText: "" }];
  }

  if (!isMultiline(object)) {
    return [{ start: openBrace.getEnd(), end: closeBrace.getStart(), newText: ` ${parts.join(", ")} ` }];
  }

  const properties = object.getProperties();
  const closeIndent = indentAt(source, closeBrace.getStart());
  const indent = properties.length > 0 ? indentAt(source, properties[0].getStart()) : closeIndent + style.indent;
  const trailing = trailingCommaOf(object, style) ? "," : "";
  const body = parts.map((part) => `${indent}${part}`).join(`,${style.eol}`);
  return [
    {
      start: openBrace.getEnd(),
      end: closeBrace.getStart(),
      newText: `${style.eol}${body}${trailing}${style.eol}${closeIndent}`,
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* remove                                                                      */
/* -------------------------------------------------------------------------- */

/** Trailing text of a line that a removed property may take with it (06 §4). */
const TAIL_WITH_LINE_COMMENT = /^[ \t]*(\/\/[^\n]*|\/\*(?:[^*]|\*(?!\/))*\*\/[ \t]*)?\r?\n$/;

export function removePropertyEdits(
  object: ObjectLiteralExpression,
  name: string,
  style: SourceStyle,
  source: string,
): TextEdit[] {
  const location = findProperty(object, name);
  if (location === null) return [];
  return removePropertyEditsIn(object, location, style, source);
}

function removePropertyEditsIn(
  object: ObjectLiteralExpression,
  location: PropertyLocation,
  style: SourceStyle,
  source: string,
): TextEdit[] {
  const property = location.property;
  const properties = object.getProperties();
  const after = commaAfter(object, property);
  const before = commaBefore(object, property);
  const propertyStart = property.getStart();
  const propertyEnd = property.getEnd();

  // Sole property: empty the literal rather than leaving stray whitespace.
  if (properties.length === 1) {
    const openBrace = object.getFirstChildByKindOrThrow(SyntaxKind.OpenBraceToken);
    const closeBrace = object.getLastChildByKindOrThrow(SyntaxKind.CloseBraceToken);
    return [{ start: openBrace.getEnd(), end: closeBrace.getStart(), newText: "" }];
  }

  if (startsLine(source, propertyStart)) {
    const cutStart = lineStartOf(source, propertyStart);
    const afterEnd = after === null ? propertyEnd : after.getEnd();
    const lineEnd = lineEndOf(source, afterEnd);
    const tail = source.slice(afterEnd, lineEnd);
    if (TAIL_WITH_LINE_COMMENT.test(tail) || (lineEnd === source.length && tail.trim().length === 0)) {
      const edits: TextEdit[] = [{ start: cutStart, end: lineEnd, newText: "" }];
      // Last property with no comma of its own: the comma of the property above
      // has to go, or the literal ends with a trailing comma it did not have.
      // The literal's own habit decides, not the file's average.
      if (after === null && before !== null && !trailingCommaOf(object, style)) {
        edits.push({ start: before.getStart(), end: before.getEnd(), newText: "" });
      }
      return edits;
    }
    return [{ start: propertyStart, end: afterEnd, newText: "" }];
  }

  // Single-line literal: take the property plus exactly one separator.
  if (after !== null) {
    let end = after.getEnd();
    while (end < source.length && (source[end] === " " || source[end] === "\t")) end += 1;
    return [{ start: propertyStart, end, newText: "" }];
  }
  const start = before === null ? propertyStart : before.getStart();
  return [{ start, end: propertyEnd, newText: "" }];
}
