import type { Tools } from "../generated/tools";
import { isBlockingFailure, parseTestPlan, renderJUnit } from "@flows/lib";

/**
 * Browser QA runner — Playwright MCP driving the browser, filesystem MCP
 * holding the evidence.
 *
 * Reads a checked-in test plan, walks every case step by step, and captures a
 * snapshot, the console and the network log for each one. Playwright's tools
 * declare no output schema — they answer by writing a file — so every
 * assertion in this flow reads its evidence back through the filesystem
 * server. Whatever happens, the browser is closed and a JUnit report is
 * written: that is what the `finally` is for.
 */

interface CaseResult {
  id: string;
  status: string;
  detail: string;
}

export default async function flow(
  input: {
    planPath: string;
    artifactDir: string;
    baseUrl: string;
    viewportWidth: number;
    viewportHeight: number;
    suite: string;
  },
  tools: Tools
) {
  /* ---------------------------------------------------------------- */
  /* 0 — the plan                                                      */
  /* ---------------------------------------------------------------- */

  const planFile = await tools.fs.readTextFile({ path: input.planPath });

  if (planFile.content.trim().length === 0) {
    return { suite: input.suite, status: "empty-plan", results: [] as CaseResult[] };
  }

  const cases = parseTestPlan(planFile.content);

  if (cases.length === 0) {
    return { suite: input.suite, status: "no-cases", results: [] as CaseResult[] };
  }

  await tools.fs.createDirectory({ path: input.artifactDir });

  await tools.browser.resize({
    width: input.viewportWidth,
    height: input.viewportHeight
  });

  const results: CaseResult[] = [];

  // Four writers between them: the declarations and the branches below.
  let passed = 0;
  let failed = 0;
  let aborted = false;
  let abortReason = "";

  /* ---------------------------------------------------------------- */
  /* 1 — the run, wrapped so the browser always closes                 */
  /* ---------------------------------------------------------------- */

  try {
    caseLoop: for (const testCase of cases) {
      if (aborted) {
        break caseLoop;
      }

      const caseUrl = `${input.baseUrl}${testCase.url}`;
      const snapshotPath = `${input.artifactDir}/${testCase.id}.snapshot.txt`;
      const consolePath = `${input.artifactDir}/${testCase.id}.console.txt`;
      const networkPath = `${input.artifactDir}/${testCase.id}.network.txt`;
      const screenshotPath = `${input.artifactDir}/${testCase.id}.png`;

      try {
        await tools.browser.tabs({ action: "new", url: caseUrl });

        await tools.browser.navigate({ url: caseUrl });
      } catch (navigationError) {
        failed = failed + 1;

        results.push({
          id: testCase.id,
          status: "error",
          detail: `navigation to ${caseUrl} failed: ${navigationError}`
        });

        const fatal = isBlockingFailure(testCase.critical, `${navigationError}`);

        if (fatal) {
          aborted = true;
          abortReason = `${testCase.id} could not be opened`;
        }

        continue caseLoop;
      }

      // Wait for the app shell, but never forever: `waits` is updated below.
      let waits = 0;
      let ready = false;

      while (waits < 5 && !ready) {
        waits = waits + 1;

        await tools.browser.waitFor({ time: 1, text: "ready" });

        await tools.browser.snapshot({
          filename: snapshotPath,
          depth: 2
        });

        const probe = await tools.fs.readTextFile({ path: snapshotPath });

        ready = probe.content.includes("ready");
      }

      if (!ready) {
        failed = failed + 1;

        results.push({
          id: testCase.id,
          status: "failed",
          detail: `app never became ready after ${waits} waits`
        });

        continue caseLoop;
      }

      let stepIndex = 0;
      let caseDetail = "";
      let caseFailed = false;

      /* --- every step, with a two-try retry loop inside it --------- */
      for (const step of testCase.steps) {
        stepIndex = stepIndex + 1;

        let done = false;
        let lastMessage = "";

        for (const attempt of [1, 2]) {
          if (done) {
            continue;
          }

          try {
            if (step.action === "click") {
              await tools.browser.click({
                element: `${testCase.id} step ${stepIndex}`,
                target: step.target,
                button: "left"
              });
            } else if (step.action === "type") {
              await tools.browser.type({
                element: `${testCase.id} step ${stepIndex}`,
                target: step.target,
                text: step.value ?? "",
                submit: false
              });
            } else if (step.action === "press") {
              await tools.browser.pressKey({ key: step.target });
            } else if (step.action === "hover") {
              await tools.browser.hover({
                element: `${testCase.id} step ${stepIndex}`,
                target: step.target
              });
            } else {
              await tools.browser.find({ text: step.target });

              await tools.browser.snapshot({
                filename: snapshotPath,
                target: step.target,
                depth: 3
              });

              const assertion = await tools.fs.readTextFile({ path: snapshotPath });

              if (!assertion.content.includes(step.value ?? step.target)) {
                throw new Error(`expected "${step.value ?? step.target}" in the snapshot`);
              }
            }

            done = true;
          } catch (stepError) {
            lastMessage = `step ${stepIndex} (${step.action} ${step.target}) attempt ${attempt}: ${stepError}`;

            await tools.browser.takeScreenshot({
              filename: `${screenshotPath}.step${stepIndex}.${attempt}.png`,
              type: "png",
              fullPage: false,
              scale: "css"
            });
          } finally {
            await tools.fs.writeFile({
              path: `${input.artifactDir}/${testCase.id}.log`,
              content: `${stepIndex}:${step.action}:${attempt}:${done}\n`
            });
          }
        }

        if (!done) {
          caseFailed = true;
          caseDetail = lastMessage;

          const fatal = isBlockingFailure(testCase.critical, lastMessage);

          if (fatal) {
            aborted = true;
            abortReason = lastMessage;
            break;
          }
        }
      }

      /* --- evidence: four artefacts collected in one wait ---------- */
      await tools.browser.consoleMessages({
        level: "error",
        all: false,
        filename: consolePath
      });

      await tools.browser.networkRequests({
        static: false,
        filter: "xhr",
        filename: networkPath
      });

      await tools.browser.takeScreenshot({
        filename: screenshotPath,
        type: "png",
        fullPage: true,
        scale: "device"
      });

      const [consoleDump, networkDump, shot, baseline] = await Promise.all([
        tools.fs.readTextFile({ path: consolePath }),
        tools.fs.readTextFile({ path: networkPath }),
        tools.fs.getFileInfo({ path: screenshotPath }),
        tools.fs.readTextFile({ path: `${input.artifactDir}/baseline.txt` })
      ]);

      // Nested destructuring with a rename, straight off the merge ports.
      const { content: consoleText } = consoleDump;

      const errorLines = consoleText
        .split("\n")
        .filter((line) => line.includes("error"));

      const drift =
        baseline.content.length > 0 &&
        !baseline.content.includes(testCase.id);

      if (caseFailed) {
        failed = failed + 1;

        results.push({
          id: testCase.id,
          status: "failed",
          detail: `${caseDetail} · ${errorLines.length} console error(s)`
        });
      } else if (errorLines.length > 0) {
        failed = failed + 1;

        results.push({
          id: testCase.id,
          status: "failed",
          detail: `clean run but ${errorLines.length} console error(s), network ${networkDump.content.length} bytes`
        });
      } else if (drift) {
        results.push({
          id: testCase.id,
          status: "flaky",
          detail: `no baseline entry for ${testCase.id} (${shot.content.length} bytes of screenshot metadata)`
        });
      } else {
        passed = passed + 1;

        results.push({
          id: testCase.id,
          status: "passed",
          detail: `${stepIndex} step(s), screenshot ${screenshotPath}`
        });
      }

      await tools.browser.tabs({ action: "close" });
    }
  } catch (runError) {
    aborted = true;
    abortReason = `${runError}`;

    results.push({
      id: input.suite,
      status: "error",
      detail: `the run itself failed: ${runError}`
    });
  } finally {
    // Cleanup runs whether the loop finished, returned or broke out.
    await tools.browser.close({});

    const report = renderJUnit(input.suite, results);

    await tools.fs.writeFile({
      path: `${input.artifactDir}/junit.xml`,
      content: report
    });
  }

  /* ---------------------------------------------------------------- */
  /* 2 — verdict                                                       */
  /* ---------------------------------------------------------------- */

  if (aborted) {
    return {
      suite: input.suite,
      status: "aborted",
      results,
      reason: abortReason
    };
  }

  if (failed > 0) {
    return {
      suite: input.suite,
      status: "failed",
      results,
      reason: `${failed} of ${results.length} case(s) failed`
    };
  }

  await tools.fs.writeFile({
    path: `${input.artifactDir}/summary.txt`,
    content: `${input.suite}: ${passed} passed, ${failed} failed, ${cases.length} planned`
  });

  return {
    suite: input.suite,
    status: "passed",
    results,
    reason: `${passed} case(s) green`
  };
}
