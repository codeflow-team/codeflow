/**
 * The library functions, compiled and then actually run.
 *
 * A `FunctionDefinition.code` is not documentation: the demo runner writes every
 * function of the chosen registry into one `lib.ts` next to the flow and repoints
 * `@flows/lib` at it (`apps/demo/server/runner.ts`), so what is written here is
 * what executes in a run. Three things follow, and this file checks all three.
 *
 *  1. **It has to compile — together.** One file per registry, not one per
 *     function, so a helper two definitions apart with the same name is a real
 *     collision. Checked with the real compiler under `strict`.
 *  2. **The schema has to describe the signature.** A function's `inputSchema` is
 *     a named-fields map whose key *order* is parameter order (05 §4) — that is
 *     the bridge the inspector uses to edit positional argument #2. If the two
 *     drift, the node edits the wrong argument, and nothing else would notice.
 *  3. **It has to do what it says.** Every function of the `common` registry is
 *     executed here, including the paths where it fails: a library function that
 *     is never run is a library function that does not work.
 *
 * The compile deliberately includes `lib.dom.d.ts` alongside ES2022: `waitMs`
 * uses `setTimeout`, which is a host API rather than a language one, and the
 * host it runs on (a Node worker thread) has it.
 */

import { describe, expect, it } from "vitest";
import ts from "typescript";

import { REGISTRIES } from "../src/index.js";
import type { ExampleRegistry } from "../src/types.js";

/* -------------------------------------------------------------------------- */
/* building the module the runner would build                                  */
/* -------------------------------------------------------------------------- */

/** Exactly what `writeModule` in `apps/demo/server/runner.ts` writes to `lib.ts`. */
function libSourceFor(registry: ExampleRegistry): string {
  const bodies = registry.functions
    .map((fn) => fn.code.trim())
    .filter((code) => code.length > 0)
    .map((code) => (code.startsWith("export ") ? code : `export ${code}`));
  return `/* Library functions, from the registry (05 §4). Real code, really run. */\n${bodies.join("\n\n")}\n`;
}

const LIB_FILE = "/virtual/lib.ts";

const OPTIONS: ts.CompilerOptions = {
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  types: [],
  skipLibCheck: true,
  // A library function may take a parameter it only forwards, and the demo's
  // `lib.ts` is a leaf module nobody imports selectively.
  noUnusedLocals: false,
  noUnusedParameters: false,
};

function programFor(source: string): ts.Program {
  const file = ts.createSourceFile(LIB_FILE, source, ts.ScriptTarget.ES2022, true);
  const host = ts.createCompilerHost(OPTIONS, true);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (name, ...rest) => (name === LIB_FILE ? file : original(name, ...rest));
  host.fileExists = (name) => name === LIB_FILE || ts.sys.fileExists(name);
  host.readFile = (name) => (name === LIB_FILE ? source : ts.sys.readFile(name));
  host.directoryExists = (name) => name.startsWith("/virtual") || ts.sys.directoryExists(name);
  host.getCurrentDirectory = () => "/virtual";
  return ts.createProgram([LIB_FILE], OPTIONS, host);
}

function diagnosticsOf(program: ts.Program): string[] {
  return [...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].map(
    (diagnostic) => {
      const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
      const line = (position?.line ?? -1) + 1;
      return `line ${String(line)}: TS${String(diagnostic.code)} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
    },
  );
}

/** Exported function declarations of a `lib.ts`, with their parameter names in order. */
function declarationsOf(program: ts.Program): Map<string, string[]> {
  const file = program.getSourceFile(LIB_FILE);
  const found = new Map<string, string[]>();
  for (const statement of file?.statements ?? []) {
    if (!ts.isFunctionDeclaration(statement)) continue;
    const name = statement.name?.text;
    if (name === undefined) continue;
    found.set(
      name,
      statement.parameters.map((parameter) =>
        ts.isIdentifier(parameter.name) ? parameter.name.text : "<destructured>",
      ),
    );
  }
  return found;
}

const REGISTRY_LIST = Object.values(REGISTRIES);

/* -------------------------------------------------------------------------- */
/* 1 — every registry's library compiles as one module                          */
/* -------------------------------------------------------------------------- */

describe.each(REGISTRY_LIST.map((registry) => [registry.id, registry] as const))(
  "%s",
  (id, registry) => {
    const source = libSourceFor(registry);
    const program = programFor(source);

    it("compiles as the single `lib.ts` the runner writes", () => {
      const problems = diagnosticsOf(program);
      expect(problems, `${id}:\n${problems.join("\n")}`).toEqual([]);
    });

    it("declares each registered function, with the parameters its schema names", () => {
      const declared = declarationsOf(program);
      for (const fn of registry.functions) {
        const parameters = declared.get(fn.name);
        expect(parameters, `${id}: \`export function ${fn.name}\` is missing from its own code`).toBeDefined();
        // 05 §4: key order in the named-fields schema *is* parameter order — the
        // patcher edits argument #n by looking the name up at that index.
        expect(Object.keys(fn.inputSchema as Record<string, unknown>), `${id}: ${fn.name}`).toEqual(
          parameters,
        );
      }
    });

    it("does not open its code with a comment, which the runner cannot survive", () => {
      // `writeModule` (apps/demo/server/runner.ts) prepends `export ` to any
      // body that does not already begin with it — a rule written for bodies
      // that start with `const` or `export function`. A body that starts with a
      // doc comment becomes `export /** … */ export function …`, which does not
      // parse, and takes the *whole registry's* `lib.ts` down with it. The
      // compile above catches it; this says what to do about it. (Documentation
      // belongs inside the function body until the runner trims comments too.)
      for (const fn of registry.functions) {
        const opening = fn.code.trim().slice(0, 2);
        expect(opening === "/*" || opening === "//", `${id}: ${fn.name} opens with a comment`).toBe(
          false,
        );
      }
    });

    it("has no two functions fighting over the same top-level name", () => {
      const declared = [...declarationsOf(program).keys()];
      expect(new Set(declared).size, id).toBe(declared.length);
    });

    it("declares an output schema and an icon for every function", () => {
      for (const fn of registry.functions) {
        expect(fn.outputSchema, `${id}: ${fn.name}`).toBeDefined();
        expect(fn.icon?.length ?? 0, `${id}: ${fn.name} has no icon`).toBeGreaterThan(0);
        expect((fn.description ?? "").length, `${id}: ${fn.name}`).toBeGreaterThan(20);
      }
    });

    it("only makes fields editable that the input schema actually names", () => {
      const editors = new Set(["text", "expression", "select", "code"]);
      for (const fn of registry.functions) {
        const keys = new Set(Object.keys(fn.inputSchema as Record<string, unknown>));
        for (const field of fn.editableFields ?? []) {
          const normalized = typeof field === "string" ? { name: field } : field;
          expect(keys.has(normalized.name), `${id}: ${fn.name}.${normalized.name}`).toBe(true);
          if (normalized.editor !== undefined) {
            expect(editors, `${id}: ${fn.name}.${normalized.name}`).toContain(normalized.editor);
          }
          if (normalized.editor === "select") {
            // A select with nothing to select from is a text box that lies.
            expect(normalized.options?.length ?? 0, `${id}: ${fn.name}.${normalized.name}`).toBeGreaterThan(1);
          }
        }
      }
    });
  },
);

/* -------------------------------------------------------------------------- */
/* 2 — the `common` registry's config surface                                   */
/* -------------------------------------------------------------------------- */

const COMMON = REGISTRIES["common"];

describe("the common registry", () => {
  it("carries the twelve everyday steps", () => {
    expect(COMMON.functions.map((fn) => fn.name).sort()).toEqual([
      "aggregateRecords",
      "dateTimeStep",
      "dedupeRecords",
      "extractJson",
      "filterRecords",
      "formatText",
      "limitRecords",
      "runAgentStep",
      "setFields",
      "sortRecords",
      "splitOutField",
      "waitMs",
    ]);
  });

  it("exercises every editor kind the patch engine defines (06 §1)", () => {
    const used = new Set<string>();
    for (const fn of COMMON.functions) {
      for (const field of fn.editableFields ?? []) {
        if (typeof field !== "string" && field.editor !== undefined) used.add(field.editor);
      }
    }
    expect([...used].sort()).toEqual(["code", "expression", "select", "text"]);
  });

  it("offers real OpenRouter model ids on the agent step", () => {
    const model = COMMON.functions
      .find((fn) => fn.name === "runAgentStep")
      ?.editableFields?.find((field) => typeof field !== "string" && field.name === "model");
    const options = (typeof model === "string" ? [] : (model?.options ?? [])) as string[];
    expect(options.length).toBeGreaterThan(3);
    for (const option of options) expect(option).toMatch(/^[a-z0-9-]+\/[A-Za-z0-9.-]+$/);
  });

  it("says in the definition itself that the agent calls no model", () => {
    const agent = COMMON.functions.find((fn) => fn.name === "runAgentStep")!;
    // Not only in a comment: the label and the description are what the palette
    // and the inspector render, so the claim reaches the UI.
    expect(agent.label.toLowerCase()).toContain("no model");
    expect(agent.description?.toLowerCase()).toContain("stand-in");
  });
});

/* -------------------------------------------------------------------------- */
/* 3 — running them                                                            */
/* -------------------------------------------------------------------------- */

interface CommonLib {
  runAgentStep(
    model: string,
    system: string,
    prompt: string,
    temperature: number,
    maxTokens: number,
  ): {
    simulated: boolean;
    model: string;
    text: string;
    note: string;
    promptWords: number;
    fingerprint: string;
    temperature: number;
  };
  setFields(
    input: Record<string, unknown>,
    assignments: Record<string, unknown>,
    mode: "merge" | "replace",
  ): Record<string, unknown>;
  filterRecords(
    records: Record<string, unknown>[],
    predicate: (record: Record<string, unknown>) => boolean,
  ): Record<string, unknown>[];
  sortRecords(
    records: Record<string, unknown>[],
    key: string,
    direction: "ascending" | "descending",
  ): Record<string, unknown>[];
  limitRecords(
    records: Record<string, unknown>[],
    count: number,
    keep: "first" | "last",
  ): Record<string, unknown>[];
  dedupeRecords(records: Record<string, unknown>[], key: string): Record<string, unknown>[];
  splitOutField(records: Record<string, unknown>[], field: string): Record<string, unknown>[];
  aggregateRecords(
    records: Record<string, unknown>[],
    key: string,
    operation: "count" | "sum" | "min" | "max" | "join",
  ): { operation: string; key: string; count: number; value: number | string; ok: boolean; reason: string };
  formatText(template: string, values: Record<string, unknown>): string;
  dateTimeStep(
    timestamp: string,
    operation: "add" | "subtract" | "startOf" | "format",
    amount: number,
    unit: "seconds" | "minutes" | "hours" | "days" | "weeks",
  ): { ok: boolean; reason: string; iso: string; formatted: string; epochMs: number };
  waitMs(ms: number): Promise<{ requestedMs: number; waitedMs: number; clamped: boolean }>;
  extractJson(raw: string): { ok: boolean; reason: string; data: Record<string, unknown> };
}

/**
 * Load the registry's library the way the worker does: transpile the same text,
 * evaluate it, take the exports. No mocks and no re-implementation — if the
 * string in the registry is wrong, every assertion below fails.
 */
function loadCommonLib(): CommonLib {
  const transpiled = ts.transpileModule(libSourceFor(COMMON), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: "lib.ts",
  });
  const exported: Record<string, unknown> = {};
  const module = { exports: exported };
  const load = (specifier: string): never => {
    throw new Error(`lib.ts must not import anything, but it asked for "${specifier}".`);
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("exports", "require", "module", transpiled.outputText)(exported, load, module);
  return exported as unknown as CommonLib;
}

const lib = loadCommonLib();

const ORDERS: Record<string, unknown>[] = [
  { id: "A-1", customer: "Acme", status: "paid", total: 1200 },
  { id: "A-2", customer: "Beta", status: "open", total: 300 },
  { id: "A-3", customer: "Acme", status: "paid", total: 450 },
  { id: "A-4", customer: "Gamma", status: "paid", total: 450 },
];

describe("runAgentStep", () => {
  const answer = lib.runAgentStep(
    "anthropic/claude-3.5-sonnet",
    "You are a triage assistant.",
    "Summarise this incident report about the checkout service timing out.",
    0.2,
    400,
  );

  it("says, in its own answer, that no model was called", () => {
    expect(answer.simulated).toBe(true);
    expect(answer.text).toContain("[SIMULATED — no model was called]");
    expect(answer.text).toContain("No model was called");
    expect(answer.note).toContain("no network");
  });

  it("echoes the configuration it was given rather than inventing one", () => {
    expect(answer.model).toBe("anthropic/claude-3.5-sonnet");
    expect(answer.temperature).toBe(0.2);
    expect(answer.text).toContain("temperature 0.2");
    expect(answer.text).toContain("System prompt accepted (27 characters) but not sent.");
  });

  it("is deterministic — the same prompt gives the same fingerprint and text", () => {
    const again = lib.runAgentStep(
      "anthropic/claude-3.5-sonnet",
      "You are a triage assistant.",
      "Summarise this incident report about the checkout service timing out.",
      0.2,
      400,
    );
    expect(again.fingerprint).toBe(answer.fingerprint);
    expect(again.text).toBe(answer.text);
    expect(answer.fingerprint).toMatch(/^[0-9a-f]{8}$/);
  });

  it("gives a different fingerprint to a different prompt", () => {
    const other = lib.runAgentStep("openai/gpt-4o-mini", "", "A different question entirely.", 0.9, 64);
    expect(other.fingerprint).not.toBe(answer.fingerprint);
    expect(other.text).toContain("No system prompt was set.");
  });

  it("handles an empty prompt without pretending it summarised one", () => {
    const empty = lib.runAgentStep("openai/gpt-4o-mini", "", "   ", 0.1, 100);
    expect(empty.promptWords).toBe(0);
    expect(empty.text).toContain("The prompt was empty");
  });
});

describe("setFields", () => {
  it("merges the assignments onto the record it was given", () => {
    expect(lib.setFields({ id: "A-1", total: 10 }, { total: 20, region: "east" }, "merge")).toEqual({
      id: "A-1",
      total: 20,
      region: "east",
    });
  });

  it("keeps only the assignments in replace mode", () => {
    expect(lib.setFields({ id: "A-1", total: 10 }, { label: "kept" }, "replace")).toEqual({
      label: "kept",
    });
  });

  it("skips a field whose value is undefined instead of writing a hole", () => {
    const out = lib.setFields({ id: "A-1" }, { note: undefined, ok: true }, "merge");
    expect(Object.keys(out).sort()).toEqual(["id", "ok"]);
  });

  it("does not mutate its input", () => {
    const input = { id: "A-1" };
    lib.setFields(input, { id: "changed" }, "merge");
    expect(input).toEqual({ id: "A-1" });
  });
});

describe("filterRecords", () => {
  it("keeps the records the condition is true for", () => {
    const paid = lib.filterRecords(ORDERS, (order) => order["status"] === "paid");
    expect(paid.map((order) => order["id"])).toEqual(["A-1", "A-3", "A-4"]);
  });

  it("returns an empty list rather than the input when nothing matches", () => {
    expect(lib.filterRecords(ORDERS, () => false)).toEqual([]);
  });

  it("lets a broken condition surface instead of silently dropping records", () => {
    expect(() =>
      lib.filterRecords(ORDERS, () => {
        throw new Error("bad condition");
      }),
    ).toThrow(/bad condition/);
  });
});

describe("sortRecords", () => {
  it("orders numbers as numbers, not as strings", () => {
    const rows = [{ n: 9 }, { n: 10 }, { n: 100 }];
    expect(lib.sortRecords(rows, "n", "ascending").map((row) => row["n"])).toEqual([9, 10, 100]);
    expect(lib.sortRecords(rows, "n", "descending").map((row) => row["n"])).toEqual([100, 10, 9]);
  });

  it("is stable — equal keys keep the order they arrived in", () => {
    const sorted = lib.sortRecords(ORDERS, "total", "descending");
    expect(sorted.map((order) => order["id"])).toEqual(["A-1", "A-3", "A-4", "A-2"]);
  });

  it("falls back to string order for a mixed column, deterministically", () => {
    const mixed = [{ v: 2 }, { v: "apple" }, { v: 10 }, { v: undefined }];
    const once = lib.sortRecords(mixed, "v", "ascending");
    const twice = lib.sortRecords(mixed, "v", "ascending");
    expect(once).toEqual(twice);
    expect(once[0]["v"]).toBeUndefined();
  });

  it("does not mutate its input", () => {
    const rows = [{ n: 2 }, { n: 1 }];
    lib.sortRecords(rows, "n", "ascending");
    expect(rows.map((row) => row.n)).toEqual([2, 1]);
  });
});

describe("limitRecords", () => {
  it("keeps the first N", () => {
    expect(lib.limitRecords(ORDERS, 2, "first").map((order) => order["id"])).toEqual(["A-1", "A-2"]);
  });

  it("keeps the last N", () => {
    expect(lib.limitRecords(ORDERS, 2, "last").map((order) => order["id"])).toEqual(["A-3", "A-4"]);
  });

  it("treats a negative or fractional count as a whole, non-negative number of records", () => {
    expect(lib.limitRecords(ORDERS, -5, "first")).toEqual([]);
    expect(lib.limitRecords(ORDERS, 2.9, "first")).toHaveLength(2);
    expect(lib.limitRecords(ORDERS, Number.NaN, "first")).toEqual([]);
  });

  it("returns a copy, never the caller's array, when the limit is not reached", () => {
    const out = lib.limitRecords(ORDERS, 99, "first");
    expect(out).toEqual(ORDERS);
    expect(out).not.toBe(ORDERS);
  });
});

describe("dedupeRecords", () => {
  it("keeps the first record for each distinct value", () => {
    expect(lib.dedupeRecords(ORDERS, "customer").map((order) => order["id"])).toEqual([
      "A-1",
      "A-2",
      "A-4",
    ]);
  });

  it("does not conflate 1 and \"1\"", () => {
    expect(lib.dedupeRecords([{ k: 1 }, { k: "1" }], "k")).toHaveLength(2);
  });

  it("treats records with no value under the key as one group", () => {
    expect(lib.dedupeRecords([{ k: "a" }, {}, {}], "k")).toHaveLength(2);
  });
});

describe("splitOutField", () => {
  it("turns one document's array field into the list of records", () => {
    const document = { orders: ORDERS };
    expect(lib.splitOutField([document], "orders")).toEqual(ORDERS);
  });

  it("wraps a scalar element so the output is always a list of records", () => {
    expect(lib.splitOutField([{ tags: ["a", "b"] }], "tags")).toEqual([{ tags: "a" }, { tags: "b" }]);
  });

  it("contributes nothing for a record that has no such field", () => {
    expect(lib.splitOutField([{ other: 1 }], "orders")).toEqual([]);
  });

  it("takes a single non-array value as one record", () => {
    expect(lib.splitOutField([{ order: { id: "A-9" } }], "order")).toEqual([{ id: "A-9" }]);
  });
});

describe("aggregateRecords", () => {
  it("counts the records that carry the key", () => {
    expect(lib.aggregateRecords([{ t: 1 }, { t: null }, {}], "t", "count")).toMatchObject({
      ok: true,
      count: 1,
      value: 1,
    });
  });

  it("sums, mins and maxes a numeric column", () => {
    expect(lib.aggregateRecords(ORDERS, "total", "sum").value).toBe(2400);
    expect(lib.aggregateRecords(ORDERS, "total", "min").value).toBe(300);
    expect(lib.aggregateRecords(ORDERS, "total", "max").value).toBe(1200);
  });

  it("joins a text column", () => {
    expect(lib.aggregateRecords(ORDERS, "customer", "join").value).toBe("Acme, Beta, Acme, Gamma");
  });

  it("says there was nothing to add rather than answering zero", () => {
    const result = lib.aggregateRecords(ORDERS, "missing", "sum");
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("nothing to sum");
    expect(result.reason).toContain("missing");
  });
});

describe("formatText", () => {
  it("fills the placeholders it has values for", () => {
    expect(lib.formatText("{{ count }} of {{total}} — {{ label }}", { count: 3, total: 9, label: "paid" })).toBe(
      "3 of 9 — paid",
    );
  });

  it("leaves a placeholder standing when the value is missing", () => {
    expect(lib.formatText("Hello {{ name }}", {})).toBe("Hello {{ name }}");
  });

  it("renders null as nothing and an object as JSON", () => {
    expect(lib.formatText("[{{ a }}][{{ b }}]", { a: null, b: { x: 1 } })).toBe('[][{"x":1}]');
  });

  it("leaves text with no placeholders alone", () => {
    expect(lib.formatText("nothing to fill", { a: 1 })).toBe("nothing to fill");
  });
});

describe("dateTimeStep", () => {
  it("adds and subtracts in UTC", () => {
    expect(lib.dateTimeStep("2026-01-31T09:00:00Z", "add", 2, "days").iso).toBe("2026-02-02T09:00:00.000Z");
    expect(lib.dateTimeStep("2026-01-31T09:00:00Z", "subtract", 90, "minutes").iso).toBe(
      "2026-01-31T07:30:00.000Z",
    );
  });

  it("truncates to the start of a unit", () => {
    expect(lib.dateTimeStep("2026-01-31T09:41:17Z", "startOf", 0, "hours").iso).toBe(
      "2026-01-31T09:00:00.000Z",
    );
  });

  it("formats without shifting", () => {
    const result = lib.dateTimeStep("2026-01-31T09:41:17Z", "format", 5, "days");
    expect(result.ok).toBe(true);
    expect(result.formatted).toBe("2026-01-31 09:41:17 UTC");
    expect(result.epochMs).toBe(Date.parse("2026-01-31T09:41:17Z"));
  });

  it("reports an unreadable timestamp instead of producing an Invalid Date", () => {
    const result = lib.dateTimeStep("last tuesday", "add", 1, "days");
    expect(result.ok).toBe(false);
    expect(result.iso).toBe("");
    expect(result.reason).toContain("last tuesday");
    expect(result.reason).toContain("ISO 8601");
  });

  it("reports a unit it does not know", () => {
    const result = lib.dateTimeStep(
      "2026-01-31T09:00:00Z",
      "add",
      1,
      "fortnights" as "days",
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("fortnights");
  });
});

describe("waitMs", () => {
  it("waits, and reports how long it actually waited", async () => {
    const before = Date.now();
    const result = await lib.waitMs(30);
    expect(Date.now() - before).toBeGreaterThanOrEqual(25);
    expect(result).toEqual({ requestedMs: 30, waitedMs: 30, clamped: false });
  });

  it("caps a delay that would hang a demo run, and says it capped it", async () => {
    const before = Date.now();
    const result = await lib.waitMs(300_000);
    expect(result.requestedMs).toBe(300_000);
    expect(result.waitedMs).toBe(2000);
    expect(result.clamped).toBe(true);
    // The cap is a real cap, not a claim: five minutes were asked for and two
    // seconds elapsed.
    expect(Date.now() - before).toBeLessThan(10_000);
  }, 15_000);

  it("treats a nonsense delay as no delay", async () => {
    expect(await lib.waitMs(Number.NaN)).toEqual({ requestedMs: 0, waitedMs: 0, clamped: false });
    expect(await lib.waitMs(-40)).toEqual({ requestedMs: 0, waitedMs: 0, clamped: false });
  });
});

describe("extractJson", () => {
  it("parses an object", () => {
    const result = lib.extractJson('{"orders":[{"id":"A-1"}]}');
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ orders: [{ id: "A-1" }] });
    expect(result.reason).toBe("");
  });

  it("reports invalid JSON in the parser's own words", () => {
    const result = lib.extractJson("{ nope }");
    expect(result.ok).toBe(false);
    expect(result.reason.startsWith("not valid JSON — ")).toBe(true);
    expect(result.data).toEqual({});
  });

  it("reports an empty input as such", () => {
    expect(lib.extractJson("   ").reason).toContain("nothing to parse");
  });

  it("refuses valid JSON that is not an object, and says which shape it got", () => {
    expect(lib.extractJson("[1,2,3]").reason).toContain("an array of 3 item(s)");
    expect(lib.extractJson("42").reason).toContain("number");
    expect(lib.extractJson("null").reason).toContain("null");
    expect(lib.extractJson('"text"').reason).toContain("string");
  });
});

/* -------------------------------------------------------------------------- */
/* 4 — the chain the example flows actually walk                               */
/* -------------------------------------------------------------------------- */

describe("the steps compose the way the example flows compose them", () => {
  it("parse → split out → filter → sort → limit → aggregate → format", () => {
    const parsed = lib.extractJson(JSON.stringify({ orders: ORDERS }));
    expect(parsed.ok).toBe(true);

    const orders = lib.splitOutField([parsed.data], "orders");
    const paid = lib.filterRecords(orders, (order) => order["status"] === "paid");
    const ranked = lib.sortRecords(paid, "total", "descending");
    const top = lib.limitRecords(ranked, 2, "first");
    const revenue = lib.aggregateRecords(paid, "total", "sum");
    const names = lib.aggregateRecords(top, "customer", "join");

    const report = lib.formatText("{{ count }} paid, {{ revenue }} total. Top: {{ names }}.", {
      count: paid.length,
      revenue: revenue.value,
      names: names.value,
    });

    expect(report).toBe("3 paid, 2100 total. Top: Acme, Acme.");
  });

  it("dedupe → per-item set + format + agent, the shape the loop example uses", () => {
    const tickets = lib.dedupeRecords(
      [
        { id: "T-1", customer: "Acme", plan: "enterprise", openedAt: "2026-01-30T08:00:00Z", body: "checkout fails" },
        { id: "T-1", customer: "Acme", plan: "enterprise", openedAt: "2026-01-30T08:00:00Z", body: "checkout fails" },
        { id: "T-2", customer: "Beta", plan: "free", openedAt: "2026-01-29T08:00:00Z", body: "slow search" },
      ],
      "id",
    );
    expect(tickets).toHaveLength(2);

    const triaged = tickets.map((ticket) => {
      const due = lib.dateTimeStep(String(ticket["openedAt"]), "add", 2, "days");
      const prompt = lib.formatText("Ticket {{ id }} ({{ plan }}): {{ body }}", {
        id: ticket["id"],
        plan: ticket["plan"],
        body: ticket["body"],
      });
      const verdict = lib.runAgentStep("openai/gpt-4o-mini", "Triage.", prompt, 0.2, 200);
      return lib.setFields(ticket, { dueAt: due.iso, triage: verdict.text, simulated: verdict.simulated }, "merge");
    });

    expect(triaged[0]["dueAt"]).toBe("2026-02-01T08:00:00.000Z");
    expect(triaged[1]["simulated"]).toBe(true);
    for (const record of triaged) {
      expect(String(record["triage"])).toContain("no model was called");
    }
  });
});
