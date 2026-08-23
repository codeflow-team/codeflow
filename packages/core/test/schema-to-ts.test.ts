/** Schema → TypeScript conversion — 03-data-model.md §11 (all three shapes). */

import { describe, expect, it } from "vitest";

import { schemaToTs } from "../src/codegen/schema-to-ts.js";
import { isJsonSchema, isNamedFieldsSchema, isTsTypeRef } from "../src/model/schema.js";

describe("shape discrimination", () => {
  it('reads { files: "File[]" } as a named-fields map', () => {
    expect(isNamedFieldsSchema({ files: "File[]" })).toBe(true);
    expect(isJsonSchema({ files: "File[]" })).toBe(false);
  });

  it("reads a record carrying JSON Schema keywords as a JSON Schema", () => {
    expect(isJsonSchema({ type: "object", properties: {} })).toBe(true);
    expect(isNamedFieldsSchema({ type: "object" })).toBe(false);
  });

  it("reads a string as a TS type ref", () => {
    expect(isTsTypeRef("File[]")).toBe(true);
  });
});

describe("shape 2 — TS type ref used verbatim", () => {
  it("passes the reference straight through", () => {
    expect(schemaToTs("File[]")).toBe("File[]");
    expect(schemaToTs("boolean")).toBe("boolean");
    expect(schemaToTs("Record<string, PullRequest>")).toBe("Record<string, PullRequest>");
  });
});

describe("shape 3 — named-fields map becomes an object type", () => {
  it("converts every field as required, in declaration order", () => {
    expect(schemaToTs({ channel: "string", message: "string" })).toBe(
      "{ channel: string; message: string }",
    );
  });

  it("supports JSON Schema values inside the map", () => {
    expect(schemaToTs({ count: { type: "integer" }, tags: { type: "array", items: { type: "string" } } })).toBe(
      "{ count: number; tags: string[] }",
    );
  });

  it("quotes keys that are not identifiers", () => {
    expect(schemaToTs({ "content-type": "string" })).toBe('{ "content-type": string }');
  });

  it("renders an empty map as {}", () => {
    expect(schemaToTs({})).toBe("{}");
  });
});

describe("shape 1 — JSON Schema", () => {
  it("converts primitives", () => {
    expect(schemaToTs({ type: "string" })).toBe("string");
    expect(schemaToTs({ type: "number" })).toBe("number");
    expect(schemaToTs({ type: "integer" })).toBe("number");
    expect(schemaToTs({ type: "boolean" })).toBe("boolean");
    expect(schemaToTs({ type: "null" })).toBe("null");
  });

  it("converts objects, marking non-required properties optional", () => {
    expect(
      schemaToTs({
        type: "object",
        properties: { channel: { type: "string" }, thread: { type: "string" } },
        required: ["channel"],
      }),
    ).toBe("{ channel: string; thread?: string }");
  });

  it("converts an object with no properties to an index signature", () => {
    expect(schemaToTs({ type: "object" })).toBe("Record<string, unknown>");
    expect(schemaToTs({ type: "object", additionalProperties: { type: "number" } })).toBe(
      "Record<string, number>",
    );
  });

  it("converts arrays", () => {
    expect(schemaToTs({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(schemaToTs({ type: "array" })).toBe("unknown[]");
    expect(
      schemaToTs({ type: "array", items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } }),
    ).toBe("{ id: string }[]");
  });

  it("converts enum and const to literal types", () => {
    expect(schemaToTs({ enum: ["open", "closed"] })).toBe('"open" | "closed"');
    expect(schemaToTs({ const: 7 })).toBe("7");
  });

  it("converts unions and intersections", () => {
    expect(schemaToTs({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe("string | number");
    expect(schemaToTs({ oneOf: [{ type: "string" }, { type: "null" }] })).toBe("string | null");
    expect(schemaToTs({ type: ["string", "null"] })).toBe("string | null");
    expect(schemaToTs({ type: "string", nullable: true })).toBe("string | null");
    expect(
      schemaToTs({ allOf: [{ type: "object" }, { anyOf: [{ type: "string" }, { type: "number" }] }] }),
    ).toBe("Record<string, unknown> & (string | number)");
  });

  it("parenthesizes a union before applying []", () => {
    expect(schemaToTs({ type: "array", items: { type: ["string", "number"] } })).toBe(
      "(string | number)[]",
    );
  });

  it("expands a $ref inline against $defs", () => {
    // A bare `PullRequest` would be a name the generated .d.ts never declares —
    // a file that does not compile. The definition is inlined instead.
    expect(
      schemaToTs({
        $ref: "#/$defs/PullRequest",
        $defs: { PullRequest: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
      }),
    ).toBe("{ id: number }");
  });

  it("expands a $ref against draft-07 `definitions` too", () => {
    expect(
      schemaToTs({ $ref: "#/definitions/Name", definitions: { Name: { type: "string" } } }),
    ).toBe("string");
  });

  it("resolves $defs declared at the root from a nested position", () => {
    expect(
      schemaToTs({
        type: "object",
        properties: { labels: { type: "array", items: { $ref: "#/$defs/Label" } } },
        required: ["labels"],
        $defs: { Label: { type: "string" } },
      }),
    ).toBe("{ labels: string[] }");
  });

  it("widens an unresolvable $ref to unknown rather than emitting a dangling name", () => {
    expect(schemaToTs({ $ref: "#/$defs/PullRequest" })).toBe("unknown");
    expect(schemaToTs({ $ref: "https://example.com/schema.json#/$defs/X" })).toBe("unknown");
    expect(schemaToTs({ $ref: "#/components/schemas/X" })).toBe("unknown");
  });

  it("breaks a $ref cycle instead of recursing forever", () => {
    // An inline expansion of a self-referential type has no fixed point.
    expect(
      schemaToTs({
        $ref: "#/$defs/Node",
        $defs: {
          Node: {
            type: "object",
            properties: { value: { type: "string" }, next: { $ref: "#/$defs/Node" } },
            required: ["value"],
          },
        },
      }),
    ).toBe("{ value: string; next?: unknown }");
  });

  it("falls back to unknown for an unrecognised type", () => {
    expect(schemaToTs({ type: "weird" })).toBe("unknown");
    expect(schemaToTs({ type: "object", description: "annotated" })).toBe("Record<string, unknown>");
  });

  it("resolves the documented ambiguity in favour of JSON Schema", () => {
    // A record whose keys are all non-keywords is a named-fields map…
    expect(schemaToTs({ description: "string" })).toBe("{ description: string }");
    // …but one JSON Schema keyword makes the whole record a JSON Schema.
    expect(schemaToTs({ type: "string", description: "annotated" })).toBe("string");
  });
});
