/**
 * The adapter and the codegen, run against schemas nobody on this side wrote.
 *
 * `test/real-schemas/*.json` are verbatim `tools/list` payloads captured from
 * real MCP servers over stdio (`scripts/dump-real-schemas.mjs`). Hand-written
 * fixtures agree with the code that reads them, because the same person wrote
 * both; these do not. They carry the things a mock never thinks to include —
 * a description documenting a glob as `'**` + `/*.ext'`, `anyOf` branches,
 * arrays of objects three levels deep, `additionalProperties: false`, enums,
 * tools with no `outputSchema`, tool names that are not identifiers.
 *
 * The assertion that matters is not "the string looks right" but **the emitted
 * `.d.ts` compiles**: `generated/tools.d.ts` is what the AI reads and what the
 * analyzer resolves symbols against (05 §2), so a file TypeScript rejects is a
 * broken build, not a cosmetic defect.
 *
 * Re-capture with:
 *   node packages/mcp/scripts/dump-real-schemas.mjs
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import ts from "typescript";
import { createRegistry, generateToolsDts, schemaToTs } from "@codeflow/core";

import { mcpToolsToDefinitions, mcpToolToDefinition } from "../src/adapter.js";
import { slugifyNamespace } from "../src/names.js";
import type { McpTool } from "../src/types.js";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "real-schemas");

interface Capture {
  server: string;
  command: string;
  toolCount: number;
  tools: McpTool[];
}

const captures: Capture[] = readdirSync(SCHEMA_DIR)
  .filter((file) => file.endsWith(".json") && !file.startsWith("_"))
  .sort()
  .map((file) => JSON.parse(readFileSync(join(SCHEMA_DIR, file), "utf8")) as Capture);

/**
 * Type-check a generated `.d.ts` with the real compiler.
 *
 * Syntactic diagnostics catch a description that closed the JSDoc block early;
 * semantic ones catch a type name the file never declares (an unresolved `$ref`
 * used to emit a bare `Issue`). Both produce a file that *looks* fine in a
 * string assertion.
 */
function diagnose(source: string): string[] {
  const fileName = "/virtual/tools.d.ts";
  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    types: [],
  };
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.ES2022, true);
  host.getSourceFile = (name, ...rest) =>
    name === fileName ? sourceFile : originalGetSourceFile(name, ...rest);
  host.fileExists = (name) => name === fileName || ts.sys.fileExists(name);
  host.readFile = (name) => (name === fileName ? source : ts.sys.readFile(name));

  const program = ts.createProgram([fileName], options, host);
  return [
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ].map((d) => {
    const at =
      d.start === undefined
        ? ""
        : ` (line ${sourceFile.getLineAndCharacterOfPosition(d.start).line + 1})`;
    return `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}${at}`;
  });
}

function namespaceFor(capture: Capture): string {
  return capture.server.replace(/-/g, "_");
}

function registryFor(capture: Capture) {
  const registry = createRegistry();
  for (const definition of mcpToolsToDefinitions(capture.tools, {
    namespace: namespaceFor(capture),
    server: capture.server,
  })) {
    registry.registerTool(definition);
  }
  return registry;
}

describe("real MCP captures", () => {
  it("captured several servers, not one", () => {
    // A single server proves nothing about schema variety.
    expect(captures.length).toBeGreaterThanOrEqual(5);
    expect(captures.reduce((n, c) => n + c.tools.length, 0)).toBeGreaterThanOrEqual(40);
  });

  it("every capture is a well-formed tools/list payload", () => {
    for (const capture of captures) {
      expect(capture.tools.length, capture.server).toBe(capture.toolCount);
      for (const tool of capture.tools) expect(typeof tool.name, capture.server).toBe("string");
    }
  });
});

describe.each(captures.map((c) => [c.server, c] as const))("%s", (server, capture) => {
  it("maps every tool without throwing", () => {
    const definitions = mcpToolsToDefinitions(capture.tools, { namespace: namespaceFor(capture) });
    expect(definitions).toHaveLength(capture.tools.length);
    for (const definition of definitions) {
      // The MCP identity survives the slug — otherwise nothing could invoke it.
      expect(definition.mcp.toolName).toBeTruthy();
      // The namespace is slugged too: `sequential_thinking` → `sequentialThinking`.
      expect(definition.name).toBe(
        `${slugifyNamespace(namespaceFor(capture))}.${definition.mcp.method}`,
      );
    }
  });

  it("registers every tool without throwing", () => {
    expect(() => registryFor(capture)).not.toThrow();
    expect(registryFor(capture).listTools()).toHaveLength(capture.tools.length);
  });

  it("generates a tools.d.ts the TypeScript compiler accepts", () => {
    const diagnostics = diagnose(generateToolsDts(registryFor(capture)));
    expect(diagnostics, `${server}:\n${diagnostics.join("\n")}`).toEqual([]);
  });

  it("gives every tool a callable signature", () => {
    const dts = generateToolsDts(registryFor(capture));
    for (const definition of mcpToolsToDefinitions(capture.tools, {
      namespace: namespaceFor(capture),
    })) {
      expect(dts, definition.name).toContain(`${definition.mcp.method}(input: `);
    }
  });
});

describe("all real servers in one registry", () => {
  function combined() {
    const registry = createRegistry();
    for (const capture of captures) {
      for (const definition of mcpToolsToDefinitions(capture.tools, {
        namespace: namespaceFor(capture),
        server: capture.server,
      })) {
        registry.registerTool(definition);
      }
    }
    return registry;
  }

  it("registers ~65 real tools across ~8 namespaces without a collision", () => {
    const registry = combined();
    expect(registry.listTools().length).toBe(
      captures.reduce((n, c) => n + c.tools.length, 0),
    );
    const namespaces = new Set(registry.listTools().map((t) => t.name.split(".")[0]));
    expect(namespaces.size).toBe(captures.length);
  });

  it("compiles as one tools.d.ts", () => {
    const diagnostics = diagnose(generateToolsDts(combined()));
    expect(diagnostics, diagnostics.join("\n")).toEqual([]);
  });

  it("stays within a sane AI-context budget (10 §4)", () => {
    // 05 §2 sells "the whole API in ~1k tokens". 65 real tools is not the MVP
    // registry, but it should still be scopeable rather than hopeless.
    const dts = generateToolsDts(combined());
    expect(Math.ceil(dts.length / 4)).toBeLessThan(20_000);
    // Namespace scoping must actually shrink it.
    const scoped = generateToolsDts(combined(), { namespaces: ["memory"] });
    expect(scoped.length).toBeLessThan(dts.length / 3);
  });
});

/**
 * The specific dirty shapes the real captures contain, pinned individually so a
 * regression names the property that broke rather than "some server fails".
 */
describe("dirty shapes found in the real captures", () => {
  function toolNamed(server: string, name: string): McpTool {
    const capture = captures.find((c) => c.server === server);
    const tool = capture?.tools.find((t) => t.name === name);
    if (tool === undefined) throw new Error(`missing capture ${server}/${name}`);
    return tool;
  }

  it("a description containing a comment terminator does not break the file", () => {
    // @modelcontextprotocol/server-filesystem, search_files:
    //   "Use pattern like '*.ext' … and '**" + "/*.ext' to match files in all
    //    subdirectories."
    const tool = toolNamed("filesystem", "search_files");
    expect(tool.description).toContain(`**${"/"}*.ext`);

    const registry = createRegistry();
    registry.registerTool(mcpToolToDefinition(tool, { namespace: "fs" }));
    const dts = generateToolsDts(registry);

    expect(diagnose(dts)).toEqual([]);
    expect(dts).toContain(`'**\\${"/"}*.ext'`);
  });

  it("an array of objects nested three deep becomes a nested TS type", () => {
    // memory/create_entities: entities[] → { name, entityType, observations[] }
    const tool = toolNamed("memory", "create_entities");
    expect(schemaToTs(tool.inputSchema as never)).toBe(
      "{ entities: { name: string; entityType: string; observations: string[] }[] }",
    );
  });

  it("an edit-list tool keeps its nested oldText/newText shape", () => {
    // filesystem/edit_file: edits[] → { oldText, newText } — the shape the
    // analyzer's nested-field patch test edits.
    expect(schemaToTs(toolNamed("filesystem", "edit_file").inputSchema as never)).toContain(
      "edits: { oldText: string; newText: string }[]",
    );
  });

  it("an anyOf becomes a union", () => {
    // filesystem/read_media_file declares its result as
    // `{ anyOf: [ {…image…}, {…audio…} ] }` on the OUTPUT side.
    const withAnyOf = captures.flatMap((capture) =>
      capture.tools
        .flatMap((tool) => [tool.inputSchema, tool.outputSchema])
        .filter((schema) => schema !== undefined && JSON.stringify(schema).includes('"anyOf"')),
    );
    expect(withAnyOf.length).toBeGreaterThan(0);
    for (const schema of withAnyOf) {
      expect(schemaToTs(schema as never)).toContain("|");
    }
  });

  it("an enum becomes a literal union", () => {
    // everything/get-structured-content: location enum of three cities.
    expect(schemaToTs(toolNamed("everything", "get-structured-content").inputSchema as never)).toBe(
      '{ location: "New York" | "Chicago" | "Los Angeles" }',
    );
  });

  it("a tool with no outputSchema returns Promise<void>, not Promise<unknown>", () => {
    const tool = toolNamed("playwright", "browser_close");
    expect(tool.outputSchema).toBeUndefined();
    const registry = createRegistry();
    registry.registerTool(mcpToolToDefinition(tool, { namespace: "pw" }));
    expect(generateToolsDts(registry)).toContain("browserClose(input: Record<string, unknown>): Promise<void>;");
  });

  it("an object schema with no properties widens to Record<string, unknown>", () => {
    // memory/read_graph — `{ type: "object", properties: {} }`.
    const tool = toolNamed("memory", "read_graph");
    const definition = mcpToolToDefinition(tool, { namespace: "mem" });
    expect(definition.editableFields).toBeUndefined();
    expect(schemaToTs(definition.inputSchema)).toBe("Record<string, unknown>");
  });

  it("kebab and snake tool names both slug to the same camelCase identifier", () => {
    expect(mcpToolToDefinition(toolNamed("everything", "get-sum"), { namespace: "e" }).name).toBe(
      "e.getSum",
    );
    expect(
      mcpToolToDefinition(toolNamed("memory", "create_entities"), { namespace: "m" }).name,
    ).toBe("m.createEntities");
  });

  it("derives editable fields in the order the server declared them", () => {
    const tool = toolNamed("filesystem", "edit_file");
    const definition = mcpToolToDefinition(tool, { namespace: "fs" });
    expect(definition.editableFields).toEqual(["path", "edits", "dryRun"]);
  });
});

/**
 * Reviewed snapshots (11 §3.2 — snapshots are reviewed, never blind).
 *
 * Checked in so a change to the codegen shows up as a diff of real generated
 * output rather than as a passing test. Regenerate with
 * `node scripts/dump-real-schemas.mjs` + `UPDATE_EXPECTED=1 vitest run`.
 */
describe("reviewed .d.ts snapshots", () => {
  const SNAPSHOT_SERVERS = ["everything", "filesystem", "memory"] as const;

  it.each(SNAPSHOT_SERVERS)("%s matches its reviewed .d.ts", (server) => {
    const capture = captures.find((c) => c.server === server)!;
    const actual = generateToolsDts(registryFor(capture));
    const file = join(SCHEMA_DIR, "expected", `${server}.d.ts`);
    if (process.env["UPDATE_EXPECTED"] === "1") {
      writeFileSync(file, actual);
    }
    expect(actual).toBe(readFileSync(file, "utf8"));
  });
});

/**
 * Shapes real servers *do* produce that the eight captured here happen not to.
 * Anything zod-backed (`zod-to-json-schema`) emits `$ref`/`$defs`; anything
 * hand-written eventually emits a name that is not an identifier.
 */
describe("dirty shapes the captures do not cover", () => {
  function dtsFor(tools: McpTool[]): string {
    const registry = createRegistry();
    for (const definition of mcpToolsToDefinitions(tools, { namespace: "srv" })) {
      registry.registerTool(definition);
    }
    return generateToolsDts(registry);
  }

  it("expands $ref/$defs inline instead of emitting an undeclared name", () => {
    const dts = dtsFor([
      {
        name: "create_issue",
        inputSchema: {
          type: "object",
          properties: {
            issue: { $ref: "#/$defs/Issue" },
            labels: { type: "array", items: { $ref: "#/$defs/Label" } },
          },
          required: ["issue"],
          $defs: {
            Issue: { type: "object", properties: { title: { type: "string" } }, required: ["title"] },
            Label: { type: "string" },
          },
        },
      },
    ]);
    expect(dts).toContain("{ issue: { title: string }; labels?: string[] }");
    expect(diagnose(dts)).toEqual([]);
  });

  it("survives a self-referential $ref", () => {
    const dts = dtsFor([
      {
        name: "walk",
        inputSchema: {
          $ref: "#/$defs/Node",
          $defs: {
            Node: {
              type: "object",
              properties: { value: { type: "string" }, next: { $ref: "#/$defs/Node" } },
              required: ["value"],
            },
          },
        },
      },
    ]);
    expect(dts).toContain("{ value: string; next?: unknown }");
    expect(diagnose(dts)).toEqual([]);
  });

  it("quotes property names that are not TypeScript identifiers", () => {
    const dts = dtsFor([
      {
        name: "call",
        inputSchema: {
          type: "object",
          properties: {
            "x-api-key": { type: "string" },
            "2fa": { type: "boolean" },
            "a b": { type: "number" },
            "": { type: "string" },
          },
          required: ["x-api-key"],
        },
      },
    ]);
    expect(dts).toContain('"x-api-key": string');
    expect(dts).toContain('"2fa"?: boolean');
    expect(dts).toContain('""?: string');
    expect(diagnose(dts)).toEqual([]);
  });

  it("keeps tools reachable when their names slug alike", () => {
    const dts = dtsFor([
      { name: "get-issue", inputSchema: { type: "object" } },
      { name: "get_issue", inputSchema: { type: "object" } },
      { name: "GET ISSUE", inputSchema: { type: "object" } },
    ]);
    expect(dts).toContain("getIssue(");
    expect(dts).toContain("getIssue2(");
    expect(dts).toContain("getIssue3(");
    expect(diagnose(dts)).toEqual([]);
  });

  it("handles a tool with no inputSchema at all", () => {
    const dts = dtsFor([{ name: "ping" }]);
    expect(dts).toContain("ping(input: Record<string, unknown>): Promise<void>;");
    expect(diagnose(dts)).toEqual([]);
  });

  it("handles a reserved word as a tool name", () => {
    const dts = dtsFor([{ name: "delete", inputSchema: { type: "object" } }]);
    expect(dts).toContain("delete_(input:");
    expect(diagnose(dts)).toEqual([]);
  });

  it("escapes a description that is hostile in several ways at once", () => {
    const dts = dtsFor([
      {
        name: "nasty",
        description: `closes ${"*"}${"/"} early\nhas \`backticks\` and <html> and a \\ backslash\r\nand a trailing star *`,
        inputSchema: { type: "object" },
      },
    ]);
    expect(diagnose(dts)).toEqual([]);
    expect(dts).not.toContain("\r");
  });

  it("renders oneOf, anyOf and allOf", () => {
    const dts = dtsFor([
      {
        name: "poly",
        inputSchema: {
          type: "object",
          properties: {
            a: { oneOf: [{ type: "string" }, { type: "number" }] },
            b: { anyOf: [{ type: "object", properties: { x: { type: "string" } }, required: ["x"] }, { type: "null" }] },
            c: {
              allOf: [
                { type: "object", properties: { p: { type: "string" } }, required: ["p"] },
                { type: "object", properties: { q: { type: "number" } }, required: ["q"] },
              ],
            },
          },
        },
      },
    ]);
    expect(dts).toContain("a?: string | number");
    expect(dts).toContain("b?: { x: string } | null");
    expect(dts).toContain("c?: { p: string } & { q: number }");
    expect(diagnose(dts)).toEqual([]);
  });
});

/**
 * Known gaps — 03 §11 calls the JSON Schema conversion "deliberately basic"
 * ("not a full JSON Schema compiler"), so these are *choices*, not defects. They
 * are pinned anyway: an active test so the current behaviour cannot drift
 * silently, and an `it.todo` next to it naming what a better conversion would
 * produce, so the debt stays visible instead of being rediscovered.
 *
 * None of the eight captured servers exercises any of these; that is exactly why
 * they need writing down rather than trusting.
 */
describe("known gaps in schema → TypeScript (03 §11)", () => {
  it("widens a 2020-12 tuple (prefixItems) to unknown[]", () => {
    expect(schemaToTs({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] })).toBe(
      "unknown[]",
    );
  });
  it.todo("should render prefixItems as a tuple type [string, number]");

  it("widens a draft-07 tuple (array-form `items`) to unknown[]", () => {
    expect(schemaToTs({ type: "array", items: [{ type: "string" }, { type: "number" }] })).toBe(
      "unknown[]",
    );
  });
  it.todo("should render array-form `items` as a tuple type [string, number]");

  it("drops `additionalProperties` when `properties` is also present", () => {
    expect(
      schemaToTs({
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
        additionalProperties: { type: "number" },
      }),
    ).toBe("{ a: string }");
  });
  it.todo(
    "should emit `{ a: string } & Record<string, number>` when both properties and additionalProperties are given",
  );

  it("loses the object shape when a schema carries BOTH `properties` and `oneOf`", () => {
    // The branch keywords short-circuit before `type` is read, so a schema that
    // says "an object with these fields, and exactly one of these constraints"
    // reaches the AI as `input: unknown` — it cannot tell what to pass.
    // No captured server does this today; a hand-written one eventually will.
    expect(
      schemaToTs({
        type: "object",
        properties: { a: { type: "string" }, b: { type: "string" } },
        oneOf: [{ required: ["a"] }, { required: ["b"] }],
      }),
    ).toBe("unknown");
  });
  it.todo(
    "should intersect the base object type with the branch union instead of discarding it",
  );

  it("ignores `not`", () => {
    expect(schemaToTs({ not: { type: "string" } })).toBe("unknown");
  });
  it.todo("should render `not` as Exclude<…> where TypeScript can express it");

  it("drops validation constraints that TypeScript cannot express", () => {
    // format/minLength/pattern have no type-level equivalent; the inspector
    // validates against the JSON Schema itself (03 §11), so nothing is lost —
    // it just is not lost *here*.
    expect(schemaToTs({ type: "string", format: "uri", minLength: 3, pattern: "^h" })).toBe("string");
    expect(schemaToTs({ type: "integer", minimum: 0 })).toBe("number");
  });

  it("treats a literally empty schema as the empty object type, not Record", () => {
    // `{}` carries no JSON Schema keyword, so it reads as a named-fields map of
    // zero fields (03 §11 shape 3) rather than as `{ type: "object" }`. The
    // adapter never produces this — it substitutes `{ type: "object" }` for a
    // missing inputSchema — but a server may send `{}` verbatim.
    expect(schemaToTs({})).toBe("{}");
    expect(schemaToTs({ type: "object" })).toBe("Record<string, unknown>");
  });
  it.todo("should treat a bare `{}` schema the same as `{ type: \"object\" }`");

  it("resolves only $defs/definitions pointers, not arbitrary JSON pointers", () => {
    expect(schemaToTs({ $ref: "#/properties/foo", properties: { foo: { type: "string" } } })).toBe(
      "unknown",
    );
  });
  it.todo("should resolve any local JSON pointer, not just the definition buckets");

  it("keeps nesting five levels deep intact", () => {
    // Not a gap — pinned because it is the property most likely to regress when
    // the conversion is made smarter.
    expect(
      schemaToTs({
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: {
              b: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    c: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: { d: { type: "string" } },
                        required: ["d"],
                      },
                    },
                  },
                  required: ["c"],
                },
              },
            },
            required: ["b"],
          },
        },
        required: ["a"],
      }),
    ).toBe("{ a: { b: { c: { d: string }[] }[] } }");
  });
});
