/**
 * I7 — **No execution** (11-testing.md §2, 00-overview.md §5 non-goal 1).
 *
 * > core không bao giờ execute code input — enforce bằng lint rule (cấm `eval`,
 * > `new Function`, dynamic import của user source trong core) + test.
 *
 * This is that test. It exists because the invariant is the kind that decays
 * quietly: nothing in core's own test suite would go red if somebody reached
 * for `new Function` to "just evaluate this one condition", and by the time
 * anyone noticed, a library that promises it never runs your code would have
 * been running it for months.
 *
 * The rule is a text scan over `src/**`, and it is deliberately blunt. A more
 * clever check (parse, resolve, follow aliases) would be a check somebody can
 * argue with; this one cannot be argued with, only deleted — and deleting it is
 * a visible act in a diff, which is the whole point.
 *
 * Execution of a CodeFlow flow belongs to a runtime outside this library
 * (09 §1). The demo in `apps/demo` has one, in a worker thread, and that is
 * where it stays: `apps/**` is not scanned here, `packages/core/src/**` is.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Every `.ts` file under `packages/core/src`, path relative to that root. */
function sourceFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full, `${prefix}${entry}/`));
    } else if (entry.endsWith(".ts")) {
      out.push(`${prefix}${entry}`);
    }
  }
  return out;
}

const FILES = sourceFiles(SRC);

/**
 * Comment-stripped source.
 *
 * The prose in this codebase talks about `eval` and `new Function` on purpose —
 * that is how a reader learns what core refuses to do — so a scan that counted
 * the documentation would be unusable, and a scan nobody can keep green gets
 * turned off. Strings are *not* stripped: a `"eval("` in a string literal is
 * still worth a second look.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** Things that would make core an executor. Each one is banned outright. */
const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  { pattern: /\beval\s*\(/, why: "eval() — I7 forbids executing input in core" },
  { pattern: /\bnew\s+Function\b/, why: "new Function — an eval by another name" },
  { pattern: /\bFunction\s*\(\s*['"`]/, why: "Function(<string>) — an eval by another name" },
  { pattern: /["']node:vm["']/, why: "node:vm — execution belongs to the runtime, not core" },
  { pattern: /\brequire\s*\(\s*['"`]vm['"`]\s*\)/, why: "require('vm')" },
  {
    pattern: /["']node:worker_threads["']/,
    why: "node:worker_threads — core is browser-safe and never spawns execution",
  },
  {
    pattern: /["']node:child_process["']/,
    why: "node:child_process — core never spawns a process",
  },
  { pattern: /\bexecSync\b|\bspawnSync\b|\bspawn\s*\(/, why: "process spawning" },
  { pattern: /["']node:worker_threads|worker_threads["']/, why: "worker_threads" },
];

describe("I7 — core never executes", () => {
  it("scans a non-trivial number of files (the scan itself must not silently empty out)", () => {
    expect(FILES.length).toBeGreaterThan(30);
  });

  it.each(FORBIDDEN)("no $why anywhere in packages/core/src", ({ pattern, why }) => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = stripComments(readFileSync(join(SRC, file), "utf8"));
      for (const [index, line] of text.split("\n").entries()) {
        if (pattern.test(line)) offenders.push(`src/${file}:${String(index + 1)}: ${line.trim()}`);
      }
    }
    expect(offenders, `${why}\n${offenders.join("\n")}`).toEqual([]);
  });

  /**
   * A dynamic `import()` of anything the caller supplied is the subtle version
   * of `eval`: it takes a path from user data and runs whatever is there.
   *
   * Static `import` declarations are fine — those are core's own modules,
   * fixed at build time and reviewable. So the scan looks only for the call
   * form, and only in `src`.
   *
   * TypeScript's *import type* — `import("ts-morph").ParenthesizedExpression` —
   * shares the spelling and is erased before a single byte of JavaScript
   * exists, so it is excluded by shape: a literal specifier immediately
   * followed by a property access is a type, never a load.
   */
  it("no dynamic import() of user-supplied source", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = stripComments(readFileSync(join(SRC, file), "utf8"))
        .replace(/import\s*\(\s*["'][^"']+["']\s*\)\s*\./g, "__importType__.");
      for (const [index, line] of text.split("\n").entries()) {
        // `import(` preceded by anything other than the start of an import
        // *declaration*. `import type … from` and `import … from` never have a
        // parenthesis after the keyword.
        if (/(^|[^.\w])import\s*\(/.test(line)) {
          offenders.push(`src/${file}:${String(index + 1)}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `dynamic import() in core\n${offenders.join("\n")}`).toEqual([]);
  });

  /**
   * Core is browser-safe by construction (`src/index.ts` says so) — no Node
   * built-in at all. That is a stronger statement than "no execution", and it
   * is the reason a runtime could never accidentally be added *here*: there is
   * nothing in scope to run anything with.
   */
  it("imports no node: built-in", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const text = stripComments(readFileSync(join(SRC, file), "utf8"));
      for (const [index, line] of text.split("\n").entries()) {
        const match = /from\s+["'](node:[^"']+)["']/.exec(line);
        if (match !== null) offenders.push(`src/${file}:${String(index + 1)}: ${match[1]}`);
      }
    }
    expect(offenders, `node built-in imported in core\n${offenders.join("\n")}`).toEqual([]);
  });

  /**
   * Self-test: a checker that cannot fail is not a checker (the same argument
   * `harness-selftest.test.ts` makes about the invariant harness). These assert
   * the patterns actually match the thing they are supposed to catch.
   */
  describe("the scan can fail", () => {
    const samples = [
      "const result = eval(userSource);",
      "const fn = new Function('a', userSource);",
      'import vm from "node:vm";',
      'import { Worker } from "node:worker_threads";',
      'import { spawn } from "node:child_process";',
    ];
    it.each(samples)("flags %s", (sample) => {
      expect(FORBIDDEN.some(({ pattern }) => pattern.test(sample))).toBe(true);
    });

    it("flags a dynamic import of user source", () => {
      expect(/(^|[^.\w])import\s*\(/.test("const mod = await import(userPath);")).toBe(true);
    });

    it("does not flag a normal import declaration", () => {
      expect(/(^|[^.\w])import\s*\(/.test('import { Node } from "ts-morph";')).toBe(false);
    });

    it("does not flag a TypeScript import type", () => {
      const line = 'const x = (y as import("ts-morph").Expression).getText();'.replace(
        /import\s*\(\s*["'][^"']+["']\s*\)\s*\./g,
        "__importType__.",
      );
      expect(/(^|[^.\w])import\s*\(/.test(line)).toBe(false);
    });

    it("does not flag prose about eval in a comment", () => {
      const prose = "/** core never calls eval() on input. */\nexport const X = 1;\n";
      expect(FORBIDDEN.some(({ pattern }) => pattern.test(stripComments(prose)))).toBe(false);
    });
  });
});
