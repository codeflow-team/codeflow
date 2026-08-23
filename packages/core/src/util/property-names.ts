/**
 * The name a property of an object literal actually binds.
 *
 * `ts-morph`'s `getName()` returns the *text* of the name node, so a key written
 * `"channel"` comes back as `"channel"` **with the quotes** and `1` as `"1"`.
 * That text is not the property name JavaScript ends up with, and using it as
 * one is a correctness bug in both directions:
 *
 *  - the analyzer would show a field called `"channel"` (quotes and all) on the
 *    inspector, which matches no field of the tool's input schema;
 *  - the patcher would fail to find the property it is asked to edit and append
 *    a *second* `channel` next to the visible one — silently changing behaviour
 *    while leaving the value the user is looking at untouched (I6).
 *
 * So: resolve the key statically where JavaScript's own rules make that
 * possible, and return `null` where they do not (a computed key that is not a
 * plain literal). `null` means "this object has a key nobody can name" — the
 * callers treat that the way 06 §1 treats a spread: existing named properties
 * stay editable, but nothing new is ever inserted next to it.
 */

import { Node } from "ts-morph";

/**
 * The static key of an object-literal member, or `null` when it cannot be known
 * without running code.
 */
export function staticPropertyName(property: Node): string | null {
  if (Node.isSpreadAssignment(property)) return null;
  if (
    !Node.isPropertyAssignment(property) &&
    !Node.isShorthandPropertyAssignment(property) &&
    !Node.isMethodDeclaration(property) &&
    !Node.isGetAccessorDeclaration(property) &&
    !Node.isSetAccessorDeclaration(property)
  ) {
    return null;
  }
  return staticNameOf(property.getNameNode());
}

/** The static name of a property-name node (identifier, literal, computed). */
export function staticNameOf(nameNode: Node): string | null {
  if (Node.isIdentifier(nameNode) || Node.isPrivateIdentifier(nameNode)) return nameNode.getText();
  if (Node.isStringLiteral(nameNode) || Node.isNoSubstitutionTemplateLiteral(nameNode)) {
    return nameNode.getLiteralText();
  }
  // `{ 1: x }` binds the key "1"; `{ 1.50: x }` binds "1.5" — the number's own
  // string form, exactly as the language defines it.
  if (Node.isNumericLiteral(nameNode)) return String(nameNode.getLiteralValue());
  if (Node.isComputedPropertyName(nameNode)) {
    const expression = nameNode.getExpression();
    // `{ ["channel"]: x }` is a literal key written the long way — knowable.
    // `{ ["chan" + "nel"]: x }` is not, and guessing is how a patch overrides a
    // value the user cannot see.
    if (Node.isStringLiteral(expression) || Node.isNoSubstitutionTemplateLiteral(expression)) {
      return expression.getLiteralText();
    }
    if (Node.isNumericLiteral(expression)) return String(expression.getLiteralValue());
    return null;
  }
  return null;
}
