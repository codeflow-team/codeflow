/**
 * The offline half of the generate → validate → **run** eval.
 *
 * Layer 6 is never a CI gate (11 §4), so — like `large-scale.test.ts` — this
 * file asserts everything that can be asserted without a token or a network,
 * and leaves the live sequence to `scripts/generate-and-run-eval.mjs`.
 *
 * There is more to assert here than in the static evals, and it matters more.
 * This suite makes a claim of the form "the flow really ran and really wrote
 * this file", and a measuring harness that is wrong flatters or maligns the
 * model. Two families of test defend that claim:
 *
 *  - **the harness agrees with the runner it drives** — the namespaces are the
 *    ones `apps/demo/server/mcp-servers.ts` will really start, and the workspace
 *    the briefs describe is the one `seedWorkspace()` really creates. Both are
 *    prose in this package and code in another; when they drift, the eval starts
 *    lying, so the drift is a test failure;
 *  - **the measurements measure what they say** — effect checks, memory parsing
 *    and error classification are exercised against fixtures whose answer is
 *    known.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as cf from "@codeflow-team/core";
import * as adapter from "../../src/adapter.js";

import {
  GENERATE_AND_RUN_EVAL_VERSION,
  RUNNABLE_SERVERS,
  RUN_INTENTS,
  SEEDED_FILES,
  WORKSPACE_BRIEF,
  checkEffects,
  classifyRuntimeError,
  coveredConstructs,
  createRunnableRegistry,
  errorClassHistogram,
  extractFlowSource,
  graphShape,
  readMemoryGraph,
  renderRuntimeFeedback,
  runRates,
  type GenerateAndRunResult,
  type RunOutcome,
} from "./generate-and-run-suite.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const RUNNER_SOURCE = readFileSync(join(REPO_ROOT, "apps", "demo", "server", "runner.ts"), "utf8");
const SERVERS_SOURCE = readFileSync(join(REPO_ROOT, "apps", "demo", "server", "mcp-servers.ts"), "utf8");

/** A blank outcome, so each test can name only the field it is about. */
function outcome(overrides: Partial<RunOutcome> = {}): RunOutcome {
  return {
    status: "ok",
    ms: 10,
    stepsRun: 5,
    stepsTotal: 5,
    mcpCalls: 3,
    mcpCallsOk: 3,
    stubCalls: 0,
    toolsCalled: ["fs.readTextFile"],
    failedCalls: [],
    failedSteps: [],
    error: null,
    result: null,
    workspace: "/tmp/x",
    input: { root: "/tmp/x" },
    effects: { checks: [], ok: true, newFiles: [], memoryEntities: 0, memoryRelations: 0, evidence: [] },
    passed: true,
    ...overrides,
  };
}

describe("the harness agrees with the runner it drives", () => {
  it("only mounts namespaces the demo runner will really start", () => {
    // `RUNNABLE_SERVERS` in `mcp-servers.ts` is the allowlist; anything outside
    // it is answered from a sample, and "it ran" would then mean nothing.
    for (const server of RUNNABLE_SERVERS) {
      expect(SERVERS_SOURCE).toContain(`namespace: "${server.namespace}"`);
    }
  });

  it("does not mount a namespace the runner stubs", () => {
    const stubbed = ["browser", "search", "deepwiki", "context7", "github", "slack", "payment"];
    const mounted = RUNNABLE_SERVERS.map((server) => server.namespace);
    for (const namespace of stubbed) expect(mounted).not.toContain(namespace);
  });

  it("builds a registry whose every tool is under a runnable namespace", () => {
    const registry = createRunnableRegistry(cf, adapter);
    const namespaces = new Set<string>(RUNNABLE_SERVERS.map((server) => server.namespace));
    const tools = registry.listTools();
    expect(tools.length).toBeGreaterThan(30);
    for (const tool of tools) {
      expect(namespaces.has(tool.name.split(".")[0]!)).toBe(true);
    }
  });

  it("renames sequentialthinking the way the runner does", () => {
    const registry = createRunnableRegistry(cf, adapter);
    expect(registry.listTools().map((tool) => tool.name)).toContain("reasoning.sequentialThinking");
    // `mcp-servers.ts` has to undo the same rename to route the call back.
    expect(SERVERS_SOURCE).toContain("sequentialthinking: \"sequentialThinking\"");
  });

  it("describes the workspace the runner actually seeds", () => {
    // Every file the briefs promise is a file `seedWorkspace()` writes …
    for (const file of SEEDED_FILES) {
      expect(RUNNER_SOURCE).toContain(`"${file}"`);
      expect(WORKSPACE_BRIEF).toContain(file);
    }
    // … and the 400-day-old doc the freshness brief depends on is real.
    expect(RUNNER_SOURCE).toContain("400 * 24 * 60 * 60 * 1000");
    expect(RUNNER_SOURCE).toContain('utimesSync(join(workspace, "docs/orders.md")');
  });

  it("does not promise a file the runner never writes", () => {
    // The brief tells the model `docs/session.md` is absent, and
    // `resilient-reader` is built on that being true.
    expect(RUNNER_SOURCE).not.toContain('"docs/session.md"');
    expect(WORKSPACE_BRIEF).toContain("There is no `docs/session.md`");
  });
});

describe("the briefs", () => {
  it("are unique, sized, and each ask for something checkable", () => {
    expect(RUN_INTENTS.length).toBeGreaterThanOrEqual(6);
    const ids = RUN_INTENTS.map((intent) => intent.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const intent of RUN_INTENTS) {
      expect(intent.covers.length).toBeGreaterThan(2);
      expect(intent.targetLines).toBeGreaterThan(50);
      // An intent with no expectation could never fail the "did it do anything"
      // half of this eval, which is the half that is new.
      const checks = (intent.expect.files ?? []).length + (intent.expect.memory === undefined ? 0 : 1);
      expect(checks).toBeGreaterThan(0);
      // The input parameter type is dictated because `apps/demo/server/input.ts`
      // synthesizes the run's input from it.
      expect(intent.prompt).toContain("input parameter type must be exactly");
      expect(intent.prompt).toContain("root: string");
    }
  });

  it("cover every construct the brief for this task listed", () => {
    const asked = new Set(RUN_INTENTS.flatMap((intent) => intent.covers));
    for (const construct of ["nested-loop", "try", "early-return", "parallel", "while-loop", "jump"]) {
      expect(asked.has(construct as never)).toBe(true);
    }
  });

  it("never asks for a file outside the workspace root", () => {
    for (const intent of RUN_INTENTS) {
      for (const file of intent.expect.files ?? []) {
        expect(file.path.startsWith("/")).toBe(false);
        expect(file.path).not.toContain("..");
      }
    }
  });
});

describe("effect checking", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), "cf-effects-"));
    mkdirSync(join(workspace, "docs"), { recursive: true });
    for (const file of SEEDED_FILES) {
      mkdirSync(dirname(join(workspace, file)), { recursive: true });
      writeFileSync(join(workspace, file), "seeded\n", "utf8");
    }
  });

  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("fails when the flow wrote nothing", () => {
    const report = checkEffects(workspace, { files: [{ path: "ledger.md" }] });
    expect(report.ok).toBe(false);
    expect(report.newFiles).toEqual([]);
    expect(report.checks[0]!.detail).toContain("no new files at all");
  });

  it("fails an empty file — writing zero bytes is not an effect", () => {
    writeFileSync(join(workspace, "ledger.md"), "", "utf8");
    const report = checkEffects(workspace, { files: [{ path: "ledger.md" }] });
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toContain("only 0 bytes");
  });

  it("fails a file that is written but does not say what it was asked to say", () => {
    writeFileSync(join(workspace, "ledger.md"), "# Ledger\n", "utf8");
    const report = checkEffects(workspace, { files: [{ path: "ledger.md", contains: ["east"] }] });
    expect(report.ok).toBe(false);
    expect(report.checks[0]!.detail).toContain("does not mention: east");
  });

  it("passes, quotes the evidence, and does not count seeded files as new", () => {
    writeFileSync(join(workspace, "ledger.md"), "# Ledger\n- east: 2080.5\n- west: 2290.1\n", "utf8");
    const report = checkEffects(workspace, {
      files: [{ path: "ledger.md", contains: ["east", "WEST"] }],
    });
    expect(report.ok).toBe(true);
    expect(report.newFiles.map((file) => file.path)).toEqual(["ledger.md"]);
    expect(report.evidence[0]!.head).toContain("east: 2080.5");
  });

  it("reads the memory server's line-delimited graph, and ignores it as an artefact", () => {
    writeFileSync(
      join(workspace, "memory.json"),
      [
        JSON.stringify({ type: "entity", name: "orders.ts", entityType: "module", observations: ["12 lines"] }),
        JSON.stringify({ type: "entity", name: "docs/orders.md", entityType: "stale-doc", observations: [] }),
        JSON.stringify({ type: "relation", from: "orders.ts", to: "repo", relationType: "part-of" }),
        "{ not json",
      ].join("\n"),
      "utf8",
    );
    const graph = readMemoryGraph(workspace);
    expect(graph.entities).toHaveLength(2);
    expect(graph.relations).toHaveLength(1);

    const report = checkEffects(workspace, {
      memory: { minEntities: 2, entityTypes: ["stale-doc"], minRelations: 1 },
    });
    expect(report.ok).toBe(true);
    expect(report.newFiles.map((file) => file.path)).not.toContain("memory.json");

    const short = checkEffects(workspace, { memory: { entityTypes: ["note"] } });
    expect(short.ok).toBe(false);
    expect(short.checks[0]!.detail).toContain("types present: module, stale-doc");
  });

  it("survives a workspace with no memory file at all", () => {
    const empty = mkdtempSync(join(tmpdir(), "cf-effects-empty-"));
    expect(readMemoryGraph(empty).entities).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });
});

describe("runtime error classification", () => {
  it("calls a clean run with the required effects `none`", () => {
    expect(classifyRuntimeError(outcome()).klass).toBe("none");
  });

  it("calls a clean run that left nothing behind `no-effect`", () => {
    const report = classifyRuntimeError(
      outcome({
        passed: false,
        effects: {
          checks: [{ label: "file ledger.md", ok: false, detail: "not written" }],
          ok: false,
          newFiles: [],
          memoryEntities: 0,
          memoryRelations: 0,
          evidence: [],
        },
      }),
    );
    expect(report.klass).toBe("no-effect");
    expect(report.reason).toContain("ledger.md");
  });

  it("separates a server rejecting the arguments from the model's own logic", () => {
    const schema = classifyRuntimeError(
      outcome({
        status: "failed",
        passed: false,
        error: { message: "MCP error: Invalid arguments for tool read_multiple_files: paths is required" },
      }),
    );
    expect(schema.klass).toBe("tool-schema");

    const logic = classifyRuntimeError(
      outcome({
        status: "failed",
        passed: false,
        error: { message: "listing.content.split is not a function" },
      }),
    );
    expect(logic.klass).toBe("logic");
  });

  it("calls a path the server refuses a schema problem, not a logic one", () => {
    const report = classifyRuntimeError(
      outcome({
        status: "failed",
        passed: false,
        failedCalls: [{ tool: "fs.writeFile", detail: "Access denied - path outside allowed directories" }],
      }),
    );
    expect(report.klass).toBe("tool-schema");
  });

  it("does not blame a completed run for the errors it was asked to survive", () => {
    // `resilient-reader` and `csv-ledger` both *require* failing reads. Reading
    // a handled ENOENT as the diagnosis would score obedience as a defect.
    const report = classifyRuntimeError(
      outcome({
        status: "ok",
        passed: false,
        failedCalls: [{ tool: "fs.readTextFile", detail: "read_text_file: ENOENT drop-north.csv" }],
        effects: {
          checks: [{ label: "memory entityType \"stale-doc\"", ok: false, detail: "none" }],
          ok: false,
          newFiles: [{ path: "freshness.md", bytes: 345 }],
          memoryEntities: 0,
          memoryRelations: 0,
          evidence: [],
        },
      }),
    );
    expect(report.klass).toBe("no-effect");
    expect(report.reason).toContain("stale-doc");
  });

  it("blames the environment for a timeout and the runner for an unbound tool", () => {
    expect(classifyRuntimeError(outcome({ status: "timeout", passed: false })).klass).toBe("environment");
    expect(
      classifyRuntimeError(
        outcome({
          status: "failed",
          passed: false,
          error: { message: "tools.fs.gitBlame is not in the registry this flow was analyzed against" },
        }),
      ).klass,
    ).toBe("runner");
  });
});

describe("the feedback the model gets is facts, not advice", () => {
  const intent = RUN_INTENTS[0]!;
  const text = renderRuntimeFeedback(
    outcome({
      status: "failed",
      passed: false,
      stepsRun: 4,
      stepsTotal: 31,
      error: { message: "rows.forEach is not a function" },
      failedCalls: [{ tool: "fs.readTextFile", detail: "read_text_file: ENOENT drop-north.csv" }],
      failedSteps: [{ nodeId: "n1", label: "Read Text File", line: 22, message: "ENOENT" }],
      effects: {
        checks: [{ label: "file ledger.md", ok: false, detail: "not written" }],
        ok: false,
        newFiles: [{ path: "notes.md", bytes: 12 }],
        memoryEntities: 0,
        memoryRelations: 0,
        evidence: [],
      },
    }),
    intent,
  );

  it("reports the status, the progress and the server's own message", () => {
    expect(text).toContain("status: **failed**");
    expect(text).toContain("4 of 31");
    expect(text).toContain("read_text_file: ENOENT drop-north.csv");
    expect(text).toContain("Read Text File (line 22)");
  });

  it("reports the effects that are missing and the files that are there", () => {
    expect(text).toContain("file ledger.md — not written");
    expect(text).toContain("`notes.md` (12 B)");
  });

  it("never tells the model how to fix it", () => {
    for (const leak of ["you should", "instead of", "use `", "try using", "the correct"]) {
      expect(text.toLowerCase()).not.toContain(leak);
    }
  });
});

describe("aggregation", () => {
  const result = (over: Partial<GenerateAndRunResult>): GenerateAndRunResult =>
    ({
      intent: "x",
      repetition: 1,
      toolCount: 37,
      systemPromptTokens: 5000,
      targetLines: 100,
      covers: [],
      attempts: [],
      firstLevel: "L2",
      firstRunPassed: false,
      finalLevel: "L2",
      finalRunPassed: false,
      staticRetries: 0,
      runtimeRetries: 0,
      totalMs: 1,
      ...over,
    }) as GenerateAndRunResult;

  it("measures the gap between looking right and running right", () => {
    const rates = runRates([
      result({ firstLevel: "L2", firstRunPassed: true, finalRunPassed: true }),
      result({ firstLevel: "L2", firstRunPassed: false, finalRunPassed: true }),
      result({ firstLevel: "L2", firstRunPassed: false, finalRunPassed: false }),
      result({ firstLevel: "L1", firstRunPassed: false, finalRunPassed: false }),
    ]);
    expect(rates.total).toBe(4);
    expect(rates.l2First).toBe(3);
    expect(rates.ranFirst).toBe(1);
    expect(rates.l2ButNotRunnable).toBe(2);
    expect(rates.l2ButNotRunnableRate).toBeCloseTo(2 / 3);
    expect(rates.fixedByRuntimeFeedback).toBe(1);
    expect(rates.neverRan).toBe(2);
  });

  it("counts error classes over the first attempt and over every attempt", () => {
    const withAttempts = result({
      attempts: [
        { errorClass: "logic" },
        { errorClass: "tool-schema" },
        { errorClass: "none" },
      ] as GenerateAndRunResult["attempts"],
    });
    expect(errorClassHistogram([withAttempts], "first")).toEqual({ logic: 1 });
    expect(errorClassHistogram([withAttempts], "all")).toEqual({ logic: 1, "tool-schema": 1, none: 1 });
  });
});

describe("shape measurements", () => {
  const SHAPED = `import type { Tools } from "../generated/tools";

function grade(size: number) {
  return size > 200 ? "large" : "small";
}

function toLines(text: string) {
  return text.split("\\n");
}

export default async function flow(
  input: { root: string; maxModules: number },
  tools: Tools
) {
  const listing = await tools.fs.listDirectory({ path: input.root });

  if (listing === undefined) {
    return { audited: 0 };
  }

  const names = toLines(listing.content);
  let audited = 0;

  for (const name of names) {
    for (const suffix of [".ts", ".md"]) {
      if (!name.endsWith(suffix)) {
        continue;
      }
      try {
        const info = await tools.fs.getFileInfo({ path: name });
        const verdict = grade(info.content.length);
        await tools.memory.createEntities({
          entities: [{ name, entityType: "module", observations: [verdict] }]
        });
      } catch (error) {
        await tools.fs.writeFile({ path: "errors.log", content: String(error) });
      }
      audited += 1;
    }
  }

  const [tree, allowed] = await Promise.all([
    tools.fs.directoryTree({ path: input.root }),
    tools.fs.listAllowedDirectories({})
  ]);

  return { audited, tree, allowed };
}
`;

  it("sees every construct the briefs ask about in a flow known to contain them", async () => {
    const registry = createRunnableRegistry(cf, adapter);
    const session = cf.createCodeFlow({ registry });
    const graph = await session.analyze(SHAPED, { file: "shaped.flow.ts" });
    const covered = coveredConstructs(graph);
    for (const construct of ["loop", "nested-loop", "condition", "try", "parallel", "jump", "early-return", "function"]) {
      expect(covered).toContain(construct);
    }
    // A `while` is not in this flow, so the measurement must not claim one.
    expect(covered).not.toContain("while-loop");

    const shape = graphShape(graph);
    expect(shape.nodes).toBeGreaterThan(10);
    expect(shape.toolCalls).toBeGreaterThan(3);
    expect(shape.meaningfulRatio).toBeGreaterThan(0.5);
  });

  it("reaches L2 on that flow, so a run failure is never a style failure in disguise", async () => {
    const registry = createRunnableRegistry(cf, adapter);
    const session = cf.createCodeFlow({ registry });
    const validated = await session.validate(SHAPED);
    expect(validated.level).toBe("L2");
  });

  it("unfences a model answer", () => {
    expect(extractFlowSource("```ts\nconst a = 1;\n```")).toBe("const a = 1;\n");
    expect(extractFlowSource("const a = 1;")).toBe("const a = 1;\n");
  });

  it("carries a version, so rates are never compared across incompatible briefs", () => {
    expect(GENERATE_AND_RUN_EVAL_VERSION).toBeGreaterThan(0);
  });
});

/**
 * The improvement this eval found, on the schema that motivated it.
 *
 * `sequentialthinking` publishes `nextThoughtNeeded` as **not required**, and
 * the live server then rejects a call that omits it. The type alone therefore
 * reads as "safe to leave out", and a model left it out: L2, and dead on the
 * first call. `parameterDocs` puts the argument's own sentence next to the
 * signature. It is off by default — this is the test that says what it does
 * when it is on, and that it changes nothing when it is off.
 */
describe("per-argument documentation in tools.d.ts (05 §2)", () => {
  const registry = createRunnableRegistry(cf, adapter);

  it("is off by default — the generated file is byte-identical", () => {
    expect(cf.generateToolsDts(registry, { parameterDocs: false })).toBe(
      cf.generateToolsDts(registry),
    );
  });

  it("documents the argument a model omitted, and says it is optional", () => {
    const dts = cf.generateToolsDts(registry, { parameterDocs: true });
    expect(dts).toContain(
      "@param nextThoughtNeeded (optional) — Whether another thought step is needed",
    );
    // A required argument is not labelled optional.
    expect(dts).toContain("@param thoughtNumber — Current thought number");
    expect(dts).not.toContain("@param thoughtNumber (optional)");
  });

  it("says nothing about an argument the server did not describe", () => {
    // The filesystem server documents `head`/`tail` but leaves `path` blank; a
    // `@param path` line repeating the name would be pure token cost.
    const dts = cf.generateToolsDts(registry, { parameterDocs: true });
    expect(dts).toContain("@param head (optional) — If provided, returns only the first N lines");
    expect(dts).not.toContain("@param path —");
  });

  it("leaves every signature untouched — this is documentation, not typing", () => {
    const signatures = (text: string): string[] =>
      text.split("\n").filter((line) => /\(input: /.test(line));
    expect(signatures(cf.generateToolsDts(registry, { parameterDocs: true }))).toEqual(
      signatures(cf.generateToolsDts(registry)),
    );
  });

  it("costs tokens, and the caller can see how many before paying", () => {
    const off = cf.estimateTokens(cf.generateToolsDts(registry));
    const on = cf.estimateTokens(cf.generateToolsDts(registry, { parameterDocs: true }));
    expect(on).toBeGreaterThan(off);
    // Whole-registry cost stayed under a quarter again when this was written;
    // a server that grows chattier should make somebody look, not slip through.
    expect(on).toBeLessThan(off * 1.5);
  });

  it("reaches the generation context through an option, not a rebuild", async () => {
    const session = cf.createCodeFlow({ registry });
    const plain = await session.buildGenerationContext({});
    const documented = await session.buildGenerationContext({ parameterDocs: true });
    expect(plain.files[0]!.content).not.toContain("@param");
    expect(documented.files[0]!.content).toContain("@param");
    expect(documented.estimatedTokens).toBeGreaterThan(plain.estimatedTokens);
  });
});
