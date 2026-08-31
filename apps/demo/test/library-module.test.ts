/**
 * `lib.ts` is one file for a whole registry, so one broken function is not one
 * broken step — it is every flow in that registry failing to start.
 *
 * The runner writes the registry's library functions (05 §4) into a single
 * module beside the flow and repoints `@flows/lib` at it. Each body has to end
 * up exported, and the rule that decides how used to be
 * `code.startsWith("export ")`. A doc comment in front of the function — the
 * first thing anyone writing one reaches for — defeats both of that rule's
 * branches at once, and the result does not parse.
 *
 * These cases are the shapes a person actually writes, checked by parsing what
 * would be written to disk rather than by eyeballing the string.
 */

import { describe, expect, it } from "vitest";
import ts from "typescript";
import { EXAMPLES, registryFor } from "@codeflow-team/examples";

import { exported } from "../server/runner.ts";

/** Parse as a module and return the syntax errors, if any. */
function syntaxErrors(code: string): string[] {
  const file = ts.createSourceFile("lib.ts", code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  // `parseDiagnostics` is internal but is the only way to see a *parse* error
  // without a whole program; transpiling is the public cross-check below.
  const diagnostics = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  }).diagnostics ?? [];
  expect(file.statements.length).toBeGreaterThan(0);
  return diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
}

/** The names a module actually exports, which is the point of the exercise. */
function exportsOf(code: string): string[] {
  const file = ts.createSourceFile("lib.ts", code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  const names: string[] = [];
  for (const statement of file.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    if (!modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (ts.isFunctionDeclaration(statement) && statement.name !== undefined) names.push(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    }
  }
  return names;
}

const CASES: { name: string; code: string; exports: string[] }[] = [
  {
    name: "a bare function declaration gets the keyword",
    code: `function isAuthChange(path: string) {\n  return path.includes("auth");\n}`,
    exports: ["isAuthChange"],
  },
  {
    name: "a function that already exports itself is left alone",
    code: `export function isAuthChange(path: string) {\n  return path.includes("auth");\n}`,
    exports: ["isAuthChange"],
  },
  {
    // The bug. `export ` was prepended in front of the comment, producing
    // `export /** … */ export function`, and `lib.ts` stopped parsing.
    name: "a doc comment in front of an already-exported function",
    code: `/**\n * Whether a changed file touches authentication code.\n */\nexport function isAuthChange(path: string) {\n  return path.includes("auth");\n}`,
    exports: ["isAuthChange"],
  },
  {
    // The bug's other half: the keyword *is* needed, but in front of the
    // declaration — not in front of the comment, where it modifies nothing.
    name: "a doc comment in front of a function that still needs exporting",
    code: `/**\n * Whether a changed file touches authentication code.\n */\nfunction isAuthChange(path: string) {\n  return path.includes("auth");\n}`,
    exports: ["isAuthChange"],
  },
  {
    name: "a line comment in front of the declaration",
    code: `// One line of why.\nfunction total(items: number[]) {\n  return items.length;\n}`,
    exports: ["total"],
  },
  {
    name: "several comments and blank lines, as a person actually writes them",
    code: `\n// why this exists\n\n/* and a second thought */\n/** and the doc block */\nfunction total(items: number[]) {\n  return items.length;\n}`,
    exports: ["total"],
  },
  {
    name: "a helper constant before the function — the registry really has these",
    code: `const SKIP = /node_modules/;\n\nexport function keep(path: string) {\n  return !SKIP.test(path);\n}`,
    exports: ["SKIP"],
  },
  {
    name: "`export` with no space after it",
    code: `export{ nothing };\nfunction nothing() { return 1; }`,
    exports: [],
  },
];

describe("library functions are exported without being mangled", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const result = exported(testCase.code);
      expect(syntaxErrors(result)).toEqual([]);
      for (const name of testCase.exports) expect(exportsOf(result)).toContain(name);
      // The author's own text is preserved exactly: the only edit is a single
      // inserted keyword, so a comment stays where it was written. Take that
      // one keyword back out and the original has to come back byte for byte.
      const inserted = result.length - testCase.code.length;
      expect([0, "export ".length]).toContain(inserted);
      if (inserted > 0) {
        const at = result.indexOf("export ");
        expect(result.slice(0, at) + result.slice(at + "export ".length)).toBe(testCase.code);
      }
    });
  }

  it("never writes `export` twice in a row", () => {
    for (const testCase of CASES) {
      expect(exported(testCase.code)).not.toMatch(/export\s+\/\*/);
      expect(exported(exported(testCase.code))).toBe(exported(testCase.code));
    }
  });

  /*
   * The same check against the real thing.
   *
   * The cases above are shapes; this is the data. Every published example's
   * registry is turned into the `lib.ts` the runner would write and required to
   * parse — which is what "one broken function stops every flow in the
   * registry" means in practice, and the only way a doc comment added to a
   * library function months from now gets caught before a user runs into it.
   */
  it("writes a parseable lib.ts for every published example's registry", () => {
    for (const example of EXAMPLES) {
      const { functions } = registryFor(example);
      const bodies = functions
        .map((fn) => fn.code?.trim())
        .filter((code): code is string => code !== undefined && code.length > 0)
        .map(exported);
      if (bodies.length === 0) continue;
      const lib = `/* Library functions, from the registry (05 §4). */\n${bodies.join("\n\n")}\n`;
      expect(syntaxErrors(lib), `${example.id} produced a lib.ts that does not parse`).toEqual([]);
      // Every function the registry names is actually reachable through the
      // import — an unexported one is a `ReferenceError` at the first call.
      for (const fn of functions) {
        if (fn.code === undefined || fn.code.trim().length === 0) continue;
        expect(exportsOf(lib), `${example.id}: ${fn.name} is not exported`).toContain(fn.name);
      }
    }
  });

  it("leaves something that is only a comment alone", () => {
    // Nothing to export, and inventing a declaration to hang the keyword on
    // would be this runner writing the user's code for them.
    expect(exported("// nothing here yet")).toBe("// nothing here yet");
    expect(exported("/* unterminated")).toBe("/* unterminated");
  });
});
