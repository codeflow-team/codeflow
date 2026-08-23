/**
 * The performance targets of 07 §7, measured on flows the size that section
 * talks about ("a few hundred lines").
 *
 *   - initial analysis   < 500 ms
 *   - analyze after edit < 100 ms (warm session, same parser kept alive)
 *
 * These are engineering targets, not semantic guarantees, so the assertions are
 * generous by design: they are here to catch a change that makes analysis
 * *quadratic*, not to police a 5 ms regression on a loaded laptop. The table
 * printed alongside them is the point — it is the number a reader can compare
 * against the target themselves.
 *
 * Two things make the numbers honest rather than lucky:
 *
 *  - a warm-up run is discarded, because the first analyze in a process pays
 *    for ts-morph's module init and the JIT — a real cost, but not the one
 *    07 §7 is about;
 *  - the **fastest** of the samples is what gets asserted, while the table
 *    prints fastest, median and slowest. Vitest runs test files concurrently in
 *    worker threads, so a median measured during a full `pnpm test` is a
 *    measurement of machine contention as much as of the analyzer (observed:
 *    22 ms alone, 129 ms under a loaded run). The fastest sample is the one
 *    least distorted by that, and it is the analyzer that is under test here.
 */

import { describe, expect, it } from "vitest";

import { EXAMPLES, LONG_EXAMPLES, fileOf, median, registryOf } from "./helpers.js";
import { createCodeFlow } from "../../src/session.js";

/** 07 §7 — initial analysis of a flow file of a few hundred lines. */
const COLD_BUDGET_MS = 500;
/** 07 §7 — re-analyze after an edit, with the parser kept warm. */
const WARM_BUDGET_MS = 100;

const SAMPLES = 5;

interface Timing {
  id: string;
  lines: number;
  nodes: number;
  cold: number[];
  warm: number[];
}

async function measure(exampleId: string): Promise<Timing> {
  const example = EXAMPLES.find((candidate) => candidate.id === exampleId)!;
  const registry = registryOf(example);
  const file = fileOf(example);

  // Warm-up: pays for module init and the first JIT pass.
  await createCodeFlow({ registry }).analyze(example.source, { file });

  const cold: number[] = [];
  for (let run = 0; run < SAMPLES; run++) {
    const session = createCodeFlow({ registry });
    const started = performance.now();
    await session.analyze(example.source, { file });
    cold.push(performance.now() - started);
  }

  // Warm path: one session, re-analyzing an edited source — what the UI does
  // on every keystroke burst behind the debounce (07 §7).
  const session = createCodeFlow({ registry });
  const graph = await session.analyze(example.source, { file });
  const warm: number[] = [];
  for (let run = 0; run < SAMPLES; run++) {
    const edited = `${example.source}\n// edit ${String(run)}\n`;
    const started = performance.now();
    await session.analyze(edited, { file });
    warm.push(performance.now() - started);
  }

  return { id: example.id, lines: example.lines, nodes: graph.nodes.length, cold, warm };
}

const fastest = (samples: number[]): number => Math.min(...samples);

describe("performance (07 §7)", () => {
  it("analyzes every example inside the cold and warm budgets, and prints the table", async () => {
    const timings: Timing[] = [];
    for (const example of EXAMPLES) {
      timings.push(await measure(example.id));
    }

    const cell = (samples: number[]): string =>
      `${fastest(samples).toFixed(1).padStart(6)} /${median(samples).toFixed(1).padStart(7)} /${Math.max(...samples).toFixed(1).padStart(7)}`;

    const rows = timings
      .sort((a, b) => b.lines - a.lines)
      .map(
        (timing) =>
          `  ${timing.id.padEnd(22)} ${String(timing.lines).padStart(4)} lines ${String(timing.nodes).padStart(4)} nodes   cold ${cell(timing.cold)}   warm ${cell(timing.warm)}`,
      );

    console.log(
      [
        "",
        `analyze timings, ms as fastest / median / slowest of ${String(SAMPLES)}`,
        `budgets (asserted on the fastest): cold ${String(COLD_BUDGET_MS)} ms, warm ${String(WARM_BUDGET_MS)} ms`,
        ...rows,
        "",
      ].join("\n"),
    );

    for (const timing of timings) {
      expect(fastest(timing.cold), `${timing.id} cold analyze`).toBeLessThan(COLD_BUDGET_MS);
      expect(fastest(timing.warm), `${timing.id} warm re-analyze`).toBeLessThan(WARM_BUDGET_MS);
      // Even the slowest sample of a full contended run has to stay inside the
      // cold budget — the target is generous enough that contention alone must
      // not blow it.
      expect(Math.max(...timing.cold), `${timing.id} cold analyze, worst`).toBeLessThan(
        COLD_BUDGET_MS,
      );
    }
  });

  it("stays roughly linear from 20 lines to 350", async () => {
    // The failure this guards against is an accidentally quadratic pass — a
    // nested scan over statements, or an identity resolution that compares
    // every node with every node. At 17× the lines, 20× the time is fine;
    // 300× is not.
    const small = await measure("canonical");
    const large = await measure("browser-qa-runner");

    const lineRatio = large.lines / small.lines;
    const timeRatio = fastest(large.cold) / Math.max(fastest(small.cold), 0.05);

    console.log(
      `  scaling: ${String(small.lines)} → ${String(large.lines)} lines (${lineRatio.toFixed(1)}×) costs ${timeRatio.toFixed(1)}× the time`,
    );

    expect(timeRatio).toBeLessThan(lineRatio * 8);
  });

  it("re-analyzing a 345-line flow twenty times does not get slower", async () => {
    // Identity resolution runs against the previous graph on every pass, so a
    // session that has been open a while must not get slower. This is the
    // shape of a real editing session, not a benchmark.
    const example = EXAMPLES.find((candidate) => candidate.id === "browser-qa-runner")!;
    const session = createCodeFlow({ registry: registryOf(example) });
    const file = fileOf(example);
    await session.analyze(example.source, { file });

    const samples: number[] = [];
    for (let run = 0; run < 20; run++) {
      const edited = example.source.replace('status: "passed"', `status: "passed${String(run)}"`);
      const started = performance.now();
      await session.analyze(edited, { file });
      samples.push(performance.now() - started);
    }

    const first = samples[0];
    const last = samples[samples.length - 1];
    console.log(
      `  20 warm re-analyses: fastest ${Math.min(...samples).toFixed(1)} ms, median ${median(samples).toFixed(1)} ms, slowest ${Math.max(...samples).toFixed(1)} ms`,
    );

    expect(Math.min(...samples)).toBeLessThan(WARM_BUDGET_MS);
    // No creep: the twentieth pass must not cost multiples of the first. This
    // is the assertion that actually matters here — identity resolution runs
    // against the previous graph every time, so a session that gets slower the
    // longer it is open would show up as a rising `last`.
    expect(last).toBeLessThan(Math.max(first * 4, 40));
  });

  it("the long flows are the ones being measured", () => {
    // A guard on the guard: if the corpus ever loses its long flows, these
    // budgets stop meaning anything.
    expect(LONG_EXAMPLES.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...LONG_EXAMPLES.map((example) => example.lines))).toBeGreaterThanOrEqual(300);
  });
});
