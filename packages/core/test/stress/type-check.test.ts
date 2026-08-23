/**
 * Every example, put through the real TypeScript compiler against the
 * `tools.d.ts` and `lib.d.ts` its own registry generates.
 *
 * This is the check that makes the corpus worth anything. A flow is only
 * "written against real MCP schemas" if the schemas actually accept it: a
 * missing required field, an enum value the server never declared, a property
 * read off a result the server returns as `void` — none of that shows up in a
 * graph assertion, because the analyzer resolves by binding and never type
 * checks (04 §1.2). The compiler is the only thing that can tell the difference
 * between "written against the schema" and "written next to the schema".
 *
 * The degradation examples are checked too, in the opposite direction: they
 * must *fail*, and fail on the calls they were written to fail on. A
 * degradation example that quietly started compiling would mean the registry
 * had grown a tool the example assumed nobody had.
 */

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { EXAMPLES, exampleById, registryOf, type FlowExample } from "./helpers.js";
import { generateLibDts } from "../../src/codegen/lib-dts.js";
import { generateToolsDts } from "../../src/codegen/tools-dts.js";

const FLOW_DIR = "/virtual/flows";
const GENERATED_DIR = "/virtual/generated";

interface Diagnostic {
  code: number;
  message: string;
  line: number;
  text: string;
}

/**
 * Compile one flow with the two generated artifacts as its only ambient
 * declarations, exactly the layout `codeflow generate` produces (05 §2).
 */
function check(example: FlowExample): Diagnostic[] {
  const registry = registryOf(example);
  const files: Record<string, string> = {
    [`${FLOW_DIR}/${example.id}.flow.ts`]: example.source,
    [`${GENERATED_DIR}/tools.d.ts`]: generateToolsDts(registry),
    // `declare module "@flows/lib"` — an ambient declaration, so the file has
    // to be in the program even though nothing imports it by path.
    [`${GENERATED_DIR}/lib.d.ts`]: generateLibDts(registry),
  };

  const options: ts.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    lib: ["lib.es2022.d.ts"],
    types: [],
    skipLibCheck: true,
    // A flow may legitimately ignore a tool's result — several of the real MCP
    // servers declare no output schema at all, so the call is `Promise<void>`
    // and the binding exists to give the canvas a data edge, not a reader.
    noUnusedLocals: false,
    noUnusedParameters: false,
  };

  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const sourceFiles = new Map<string, ts.SourceFile>();
  for (const [name, text] of Object.entries(files)) {
    sourceFiles.set(name, ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true));
  }
  host.getSourceFile = (name, ...rest) => sourceFiles.get(name) ?? originalGetSourceFile(name, ...rest);
  host.fileExists = (name) => files[name] !== undefined || ts.sys.fileExists(name);
  host.readFile = (name) => files[name] ?? ts.sys.readFile(name);
  // Bundler resolution probes the directory before the file; without this the
  // virtual `generated/` looks empty and `../generated/tools` resolves to
  // nothing — which makes every downstream expression `any` and the whole
  // check vacuous.
  host.directoryExists = (name) => name.startsWith("/virtual") || ts.sys.directoryExists(name);
  host.getCurrentDirectory = () => "/virtual";

  const program = ts.createProgram(Object.keys(files), options, host);

  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map(
    (diagnostic): Diagnostic => {
      const file = diagnostic.file;
      const start = diagnostic.start ?? 0;
      const position = file?.getLineAndCharacterOfPosition(start);
      const lineText =
        file === undefined || position === undefined
          ? ""
          : file.text.split("\n")[position.line].trim();
      return {
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        line: (position?.line ?? -1) + 1,
        text: lineText,
      };
    },
  );
}

function render(diagnostics: Diagnostic[]): string {
  return diagnostics
    .map((diagnostic) => `  line ${String(diagnostic.line)}: TS${String(diagnostic.code)} ${diagnostic.message}\n    ${diagnostic.text}`)
    .join("\n");
}

const CLEAN = EXAMPLES.filter((example) => example.category !== "degradation");
const DEGRADED = EXAMPLES.filter((example) => example.category === "degradation");

describe.each(CLEAN.map((example) => [example.id, example] as const))("%s", (id, example) => {
  it("type-checks against the tools.d.ts its registry generates", () => {
    const diagnostics = check(example);
    expect(diagnostics, `${id}:\n${render(diagnostics)}`).toEqual([]);
  });
});

describe("the generated artifacts themselves", () => {
  it("every registry produces a tools.d.ts the compiler accepts", () => {
    // Checked once per *example* above; this checks the registries that back
    // them, including the ones only reachable through a degradation example.
    for (const example of EXAMPLES) {
      const registry = registryOf(example);
      const dts = generateToolsDts(registry);
      expect(dts, example.registryId).toContain("export interface Tools {");
      expect(dts.length, example.registryId).toBeGreaterThan(200);
    }
  });

  it("names every real MCP namespace the corpus uses", () => {
    const namespaces = new Set<string>();
    for (const example of EXAMPLES) {
      for (const tool of registryOf(example).listTools()) {
        namespaces.add(tool.name.slice(0, tool.name.indexOf(".")));
      }
    }
    // Eight captured servers plus the specs' own github/slack/payment registry.
    expect([...namespaces].sort()).toEqual([
      "browser",
      "context7",
      "deepwiki",
      "everything",
      "fs",
      "github",
      "memory",
      "payment",
      "reasoning",
      "search",
      "slack",
    ]);
  });
});

describe("the degradation examples do not type-check, and that is the point", () => {
  it.each(DEGRADED.map((example) => [example.id, example] as const))(
    "%s fails on the calls it was written to fail on",
    (id, example) => {
      const diagnostics = check(example);
      expect(diagnostics.length, `${id} unexpectedly compiled`).toBeGreaterThan(0);

      // The failures are about tools that are genuinely not in the registry —
      // not about the flow contract, and not about anything else.
      const unresolved = diagnostics.filter((diagnostic) =>
        /does not exist on type|Property .* does not exist/.test(diagnostic.message),
      );
      expect(unresolved.length, `${id}:\n${render(diagnostics)}`).toBeGreaterThan(0);
    },
  );

  it("degradation-showcase fails on exactly the two tools nobody registered", () => {
    const diagnostics = check(exampleById("degradation-showcase"));
    const lines = diagnostics.map((diagnostic) => diagnostic.text);
    expect(lines.some((line) => line.includes("gitBlameEveryLine"))).toBe(true);
    expect(lines.some((line) => line.includes("tools.github.openIssue"))).toBe(true);
  });
});
