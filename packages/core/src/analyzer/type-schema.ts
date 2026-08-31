/**
 * Named fields read out of a type **node** — 03 §11 (the schema union).
 *
 * A parameter's declared type reaches the graph as a `TsTypeRef` string, and a
 * string is a name, not a shape: the UI can print `{ ticketsPath: string; … }`
 * but it cannot offer `input.ticketsPath` as a row to drag, because walking a
 * name needs a type checker and the analyzer deliberately runs without one
 * (04 §1.2). An **object type literal** is the one case where no checker is
 * needed — its members are right there in the syntax tree — so it resolves to a
 * `NamedFieldsSchema` that `childrenOf` can walk.
 *
 * Scoped exactly like `itemSchemaOf` in emit.ts, and for the same reason: a
 * missing schema costs the user a tree they can still reach by typing, a wrong
 * one costs them a field that does not exist (I6). So only what the syntax says
 * outright resolves:
 *
 *  - `{ a: string; b: number }` → `{ a: "string", b: "number" }`;
 *  - a nested literal recurses — `{ user: { id: string } }` → a nested map;
 *  - an optional member is still a member — `{ a?: string }` → `{ a: "string" }`
 *    (the union has no way to spell "optional", and dropping the field would
 *    hide a name the user can legitimately reach);
 *  - a bare type **name** (`Ticket`, `File[]`, an imported interface) → nothing.
 *    Its members live in another file, behind a checker;
 *  - an intersection, union, mapped or conditional type → nothing. Each of them
 *    *has* an answer, and none of them has one this module can compute without
 *    reimplementing the checker; a partial answer would be a wrong one;
 *  - a member this module cannot read — an index signature, a method, a call
 *    signature, a name that needs code to know (`[key]: string`), a member with
 *    no type at all — makes the **whole** literal resolve to nothing rather than
 *    a subset. Listing three of four members invites the reader to believe that
 *    is all there is.
 *
 * One more refusal, and it is the schema union's own ambiguity rather than the
 * syntax's: a map that `isJsonSchema` would claim (a literal with a member
 * literally named `type`, `properties`, `enum`, …) is dropped. Emitting it would
 * make every consumer read `{ type: string; name: string }` as a JSON Schema of
 * type `"string"` — a name mapped to a wrong meaning, which is exactly I6.
 */

import { Node } from "ts-morph";
import type { NamedFieldsSchema } from "../model/index.js";
import { isJsonSchema } from "../model/schema.js";
import { staticNameOf } from "../util/property-names.js";

/**
 * The named-fields shape of a type node, or `undefined` when the node is not an
 * object type literal this module can read in full.
 */
export function namedFieldsFromTypeNode(typeNode: Node | undefined): NamedFieldsSchema | undefined {
  if (typeNode === undefined || !Node.isTypeLiteral(typeNode)) return undefined;

  const fields: NamedFieldsSchema = {};
  for (const member of typeNode.getMembers()) {
    if (!Node.isPropertySignature(member)) return undefined;
    const name = staticNameOf(member.getNameNode());
    if (name === null) return undefined;
    const memberType = member.getTypeNode();
    if (memberType === undefined) return undefined;
    // A nested literal is a shape; anything else is carried as the type text it
    // is written as, which is what a `TsTypeRef` is for.
    fields[name] = namedFieldsFromTypeNode(memberType) ?? memberType.getText();
  }

  // `{}` resolves to an empty map: "an object with no members" is a fact the
  // syntax states, not an absence of information.
  return isJsonSchema(fields) ? undefined : fields;
}
