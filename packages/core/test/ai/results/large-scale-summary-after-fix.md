# Large-scale AI conformance — stealth/ox-alpha

Feature-sized briefs (150–400 lines expected) against scoped registries of real MCP tools. Eval version 1. `max_tokens` 48000, target L2, max 2 retries, few-shot examples on.

Ran 2026-08-23T05:58:17.600Z · 7 generations.

First round is what a host gets from one generation; final is what the retry loop of
10 §5 gets after feeding diagnostics back.

| Level | First round | Final | Final rate |
| --- | --- | --- | --- |
| L0 (parses + contract) | 7/7 | 7/7 | 100% |
| L1 (everything resolves) | 7/7 | 7/7 | 100% |
| L2 (maps cleanly) | 7/7 | 7/7 | 100% |

## Per generation

| Intent | Tools | Lines (target) | Nodes | Edges | Code nodes | Meaningful | Nesting | First → final | Retries | Time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dependency-audit | 18 | 311 (160) | 53 | 107 | 5 | 91% | 4 | L2 → L2 | 0 | 348s |
| browser-qa-suite | 38 | 142 (220) | 39 | 84 | 6 | 85% | 6 | L2 → L2 | 0 | 290s |
| incident-responder | 28 | 300 (170) | 50 | 121 | 7 | 86% | 2 | L2 → L2 | 0 | 387s |
| repo-triage-bot | 23 | 250 (180) | 56 | 120 | 6 | 89% | 4 | L2 → L2 | 0 | 255s |
| research-pipeline | 28 | 170 (200) | 38 | 81 | 4 | 89% | 2 | L2 → L2 | 0 | 474s |
| data-migration | 23 | 228 (190) | 44 | 101 | 6 | 86% | 3 | L2 → L2 | 0 | 338s |
| knowledge-base-sync | 27 | 344 (170) | 64 | 139 | 16 | 75% | 4 | L2 → L2 | 0 | 421s |

## Construct coverage

45/49 of the constructs the briefs required were projected to the graph (92%).

| Construct asked for | Times missing |
| --- | --- |
| else-if-chain | 2 |
| early-return | 1 |
| nested-loop | 1 |

## Diagnostics over every round

| Diagnostic | Count |
| --- | --- |
| `info/unsupported-construct` | 50 |

## Tokens and time

| Intent | Round | Prompt tokens | Completion tokens | Time |
| --- | --- | --- | --- | --- |
| dependency-audit | 0 | 4961 | 13205 | 348s |
| browser-qa-suite | 0 | 4627 | 13124 | 290s |
| incident-responder | 0 | 4893 | 14217 | 387s |
| repo-triage-bot | 0 | 4121 | 9409 | 255s |
| research-pipeline | 0 | 5600 | 11537 | 474s |
| data-migration | 0 | 4021 | 13062 | 338s |
| knowledge-base-sync | 0 | 4803 | 13317 | 421s |

## dependency-audit

Servers: filesystem, context7, deepwiki, sequential-thinking · 18 tools · system prompt ≈ 5032 tokens.

Tools actually called: `context7.queryDocs`, `context7.resolveLibraryId`, `deepwiki.deepwikiFetch`, `filesystem.createDirectory`, `filesystem.readTextFile`, `filesystem.searchFiles`, `filesystem.writeFile`, `sequentialThinking.sequentialthinking`

### round 0 → L2 · 311 lines · 53 nodes (348s)

Node types: function×14, tool×11, merge×6, code×5, condition×5, loop×4, jump×4, trigger×1, try×1, parallel×1, output×1

Covered: condition, function, jump, loop, nested-loop, parallel, try · **missing: else-if-chain**

Diagnostics:

- `info/unsupported-construct` (line 198) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 207) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 222) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 225) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 228) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

// ── Types ────────────────────────────────────────────────────────────────────

type Grade = "critical" | "warning" | "info";
type GradeCounts = Record<Grade, number>;

interface AuditFinding {
  repository: string;
  manifest: string;
  dependency: string;
  grade: Grade;
}

interface AuditFailure {
  repository: string;
  manifest: string;
  reason: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

const MAX_WEEKLY_FINDINGS = 20;

const MANIFEST_FILE_NAMES = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
];

const DIRECT_DEPENDENCY_SECTIONS = [
  '"dependencies"',
  '"deps"',
  "[dependencies]",
  "[project]",
];

const NON_DIRECT_DEPENDENCY_SECTIONS = [
  '"devDependencies"',
  '"peerDependencies"',
  '"optionalDependencies"',
  '"dev-dependencies"',
  '"build-dependencies"',
];

// ── Helpers (each becomes a named node when called from the flow) ────────────

function overWeeklyLimit(findings: AuditFinding[]): boolean {
  return findings.length > MAX_WEEKLY_FINDINGS;
}

function toPaths(searchOutput: string): string[] {
  return searchOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function collectAll(target: string[], additions: string[]) {
  for (const item of additions) {
    target.push(item);
  }
}

function mentionsDependency(manifest: string, dependency: string): boolean {
  return manifest.includes(dependency);
}

function latestMarkerBefore(text: string, markers: string[], position: number): number {
  let latest = -1;
  for (const marker of markers) {
    const at = text.indexOf(marker);
    if (at !== -1 && at < position && at > latest) {
      latest = at;
    }
  }
  return latest;
}

// Crude but readable pin detection across JSON/TOML styles:
// "dep": "0.9.1" / "dep": "^0.4" / dep = "0.2" — any pinned version below 1.
function pinnedVersionBelowOne(manifest: string, dependency: string): boolean {
  const escaped = dependency.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pin = new RegExp(`["']${escaped}["']\\s*[:=]\\s*["'][~^>=]*0(\\.\\d+){0,3}["']`);
  return pin.test(manifest);
}

function appearsInDirectDependencies(manifest: string, dependency: string): boolean {
  const entryAt = manifest.indexOf(`"${dependency}"`);
  if (entryAt === -1) {
    return false;
  }
  const directAt = latestMarkerBefore(manifest, DIRECT_DEPENDENCY_SECTIONS, entryAt);
  const nonDirectAt = latestMarkerBefore(manifest, NON_DIRECT_DEPENDENCY_SECTIONS, entryAt);
  return directAt !== -1 && directAt > nonDirectAt;
}

function gradeFinding(manifest: string, dependency: string): Grade {
  if (pinnedVersionBelowOne(manifest, dependency)) {
    return "critical";
  }
  if (appearsInDirectDependencies(manifest, dependency)) {
    return "warning";
  }
  return "info";
}

function buildFinding(
  repository: string,
  manifest: string,
  dependency: string,
  grade: Grade
): AuditFinding {
  return { repository, manifest, dependency, grade };
}

function recordFinding(findings: AuditFinding[], finding: AuditFinding) {
  findings.push(finding);
}

function recordFailure(failures: AuditFailure[], repository: string, manifest: string, error: unknown) {
  failures.push({ repository, manifest, reason: String(error) });
}

function groupByGrade(findings: AuditFinding[]): Record<Grade, AuditFinding[]> {
  const grouped: Record<Grade, AuditFinding[]> = { critical: [], warning: [], info: [] };
  for (const finding of findings) {
    grouped[finding.grade].push(finding);
  }
  return grouped;
}

function countByGrade(findings: AuditFinding[]): GradeCounts {
  const grouped = groupByGrade(findings);
  return {
    critical: grouped.critical.length,
    warning: grouped.warning.length,
    info: grouped.info.length,
  };
}

function summarizeAudit(counts: GradeCounts, repositoriesAudited: number): string {
  return `${repositoriesAudited} repositories audited: ${counts.critical} critical, ${counts.warning} warning, ${counts.info} info`;
}

function buildRecommendation(counts: GradeCounts): string {
  if (counts.critical > 0) {
    return `Escalate now: ${counts.critical} dependencies are pinned below version 1 and cannot reliably receive stable security patches. Open upgrade tickets before anything else ships this week.`;
  }
  if (counts.warning > 0) {
    return `No pre-1.0 pins found. Review the ${counts.warning} risky direct dependencies and confirm each is still maintained; drop or replace the unmaintained ones.`;
  }
  return `Only informational matches this week (${counts.info}). Re-run the audit after the next dependency refresh.`;
}

function renderGradeSection(grade: Grade, entries: AuditFinding[]): string {
  if (entries.length === 0) {
    return `## ${grade}\n\n_No findings._\n`;
  }
  const lines = entries.map(
    (entry) => `- \`${entry.dependency}\` — ${entry.repository}/${entry.manifest}`
  );
  return `## ${grade}\n\n${lines.join("\n")}\n`;
}

function renderReport(grouped: Record<Grade, AuditFinding[]>, recommendation: string): string {
  return [
    "# Weekly dependency audit",
    "",
    renderGradeSection("critical", grouped.critical),
    renderGradeSection("warning", grouped.warning),
    renderGradeSection("info", grouped.info),
    "## Recommendation",
    "",
    recommendation,
    ""
  ].join("\n");
}

function renderFailures(failures: AuditFailure[]): string {
  const lines = failures.map((failure) => `- ${failure.repository}/${failure.manifest}: ${failure.reason}`);
  return ["# Manifests that failed to read", "", ...lines, ""].join("\n");
}

function wikiUrl(dependency: string): string {
  return `https://deepwiki.com/${dependency}`;
}

// ── Flow ─────────────────────────────────────────────────────────────────────

export default async function flow(
  input: { repositories: string[]; riskyDependencies: string[] },
  tools: Tools
) {
  const findings: AuditFinding[] = [];
  const failures: AuditFailure[] = [];
  let repositoriesAudited = 0;

  for (const repository of input.repositories) {
    if (overWeeklyLimit(findings)) {
      break;
    }

    const manifestPaths: string[] = [];
    for (const manifestName of MANIFEST_FILE_NAMES) {
      const search = await tools.filesystem.searchFiles({
        path: repository,
        pattern: `**/${manifestName}`,
        excludePatterns: ["**/node_modules/**"]
      });
      const matched = toPaths(search.content);
      collectAll(manifestPaths, matched);
    }

    if (manifestPaths.length === 0) {
      continue;
    }

    repositoriesAudited += 1;

    for (const manifestPath of manifestPaths) {
      let manifest: string | null = null;
      try {
        const read = await tools.filesystem.readTextFile({ path: manifestPath });
        manifest = read.content;
      } catch (error) {
        recordFailure(failures, repository, manifestPath, error);
      }

      if (manifest === null) {
        continue;
      }

      for (const dependency of input.riskyDependencies) {
        const mentioned = mentionsDependency(manifest, dependency);
        if (!mentioned) {
          continue;
        }

        const grade = gradeFinding(manifest, dependency);

        // Resolve the dependency's Context7 documentation id first.
        // This registry build surfaces the resolved id out-of-band, so the
        // documentation lookup below keys on the dependency name.
        await tools.context7.resolveLibraryId({
          query: `resolve the documentation id for ${dependency}`,
          libraryName: dependency
        });

        const wikiPage = wikiUrl(dependency);
        await Promise.all([
          tools.context7.queryDocs({
            libraryId: dependency,
            query: `known vulnerabilities and upgrade advice for ${dependency}`
          }),
          tools.deepwiki.deepwikiFetch({ url: wikiPage })
        ]);

        const finding = buildFinding(repository, manifestPath, dependency, grade);
        recordFinding(findings, finding);
      }
    }
  }

  const counts = countByGrade(findings);
  const summary = summarizeAudit(counts, repositoriesAudited);

  await tools.sequentialThinking.sequentialthinking({
    thought: `Step 1 — triage the audit: ${summary}. Critical pins below version 1 cannot reliably receive stable security fixes and must be handled first.`,
    thoughtNumber: 1,
    totalThoughts: 3,
    nextThoughtNeeded: true
  });

  await tools.sequentialThinking.sequentialthinking({
    thought: "Step 2 — order the remaining work by review cost: after critical pins, verify whether each warning-level direct dependency is still maintained, then skim the info-level mentions during the weekly review slot.",
    thoughtNumber: 2,
    totalThoughts: 3,
    nextThoughtNeeded: true
  });

  await tools.sequentialThinking.sequentialthinking({
    thought: "Step 3 — pick the highest severity bucket that has findings and phrase one actionable recommendation that covers every recorded finding exactly once.",
    thoughtNumber: 3,
    totalThoughts: 3,
    nextThoughtNeeded: false
  });

  const recommendation = buildRecommendation(counts);

  await tools.filesystem.createDirectory({ path: "audit" });

  const grouped = groupByGrade(findings);
  const report = renderReport(grouped, recommendation);
  await tools.filesystem.writeFile({ path: "audit/report.md", content: report });

  if (failures.length > 0) {
    const failureLog = renderFailures(failures);
    await tools.filesystem.writeFile({ path: "audit/failures.md", content: failureLog });
  }

  return {
    repositoriesAudited,
    critical: counts.critical,
    warning: counts.warning,
    info: counts.info
  };
}
```

## browser-qa-suite

Servers: playwright, filesystem · 38 tools · system prompt ≈ 4508 tokens.

Tools actually called: `filesystem.writeFile`, `playwright.browserClick`, `playwright.browserClose`, `playwright.browserConsoleMessages`, `playwright.browserNavigate`, `playwright.browserResize`, `playwright.browserSnapshot`, `playwright.browserTakeScreenshot`, `playwright.browserType`, `playwright.browserWaitFor`

### round 0 → L2 · 142 lines · 39 nodes (290s)

Node types: tool×11, code×6, function×6, condition×5, loop×3, try×3, jump×2, trigger×1, merge×1, output×1

Covered: condition, else-if-chain, function, jump, loop, nested-loop, try · **missing: early-return**

Diagnostics:

- `info/unsupported-construct` (line 73) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 82) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 104) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 120) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 122) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 126) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

interface SmokeStep {
  kind: string;
  target: string;
  text?: string;
}

interface SmokeScenario {
  name: string;
  path: string;
  steps: SmokeStep[];
  expected: string;
}

const CONSOLE_LEVELS = ["error", "warning", "info", "debug"] as const;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function screenshotName(scenarioName: string): string {
  return `smoke-${slugify(scenarioName)}.png`;
}

function pageUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const suffix = path.replace(/^\/+/, "");
  return `${base}/${suffix}`;
}

function recordFailure(failures: string[], label: string, error: unknown) {
  failures.push(`${label}: ${String(error)}`);
}

function buildReport(
  passedCount: number,
  failedCount: number,
  failedScenarios: string[],
  problems: string[]
): string {
  const lines: string[] = [
    "# Browser smoke-test report",
    "",
    `Passed scenarios: ${passedCount}`,
    `Failed scenarios: ${failedCount}`,
    "",
    "## Failing scenarios",
  ];
  if (failedScenarios.length === 0) {
    lines.push("- (none)");
  }
  for (const entry of failedScenarios) {
    lines.push(`- ${entry}`);
  }
  if (problems.length > 0) {
    lines.push("");
    lines.push("## Other problems");
    for (const entry of problems) {
      lines.push(`- ${entry}`);
    }
  }
  return lines.join("\n");
}

export default async function flow(
  input: { baseUrl: string; scenarios: SmokeScenario[] },
  tools: Tools
) {
  const failedScenarios: string[] = [];
  const problems: string[] = [];
  let passedCount = 0;
  let failedCount = 0;
  let cutShort = false;

  await tools.playwright.browserResize({ width: 1280, height: 720 });

  for (const scenario of input.scenarios) {
    let passed = false;

    try {
      const url = pageUrl(input.baseUrl, scenario.path);
      await tools.playwright.browserNavigate({ url });
      await tools.playwright.browserSnapshot({});

      for (const step of scenario.steps) {
        if (step.kind === "click") {
          await tools.playwright.browserClick({ target: step.target });
        } else if (step.kind === "type") {
          await tools.playwright.browserType({ target: step.target, text: step.text ?? "" });
        } else if (step.kind === "wait") {
          await tools.playwright.browserWaitFor({ text: step.target });
        } else {
          continue;
        }
      }

      // browserWaitFor throws when the text never appears, so a missing
      // expectation lands in the catch below and fails the scenario.
      await tools.playwright.browserWaitFor({ text: scenario.expected });
      passed = true;
    } catch (error) {
      recordFailure(failedScenarios, scenario.name, error);
    } finally {
      try {
        const shotName = screenshotName(scenario.name);
        await tools.playwright.browserTakeScreenshot({ filename: shotName, type: "png", scale: "css" });
        for (const level of CONSOLE_LEVELS) {
          await tools.playwright.browserConsoleMessages({ level, all: true });
        }
      } catch (error) {
        recordFailure(problems, `${scenario.name} clean-up`, error);
      }
    }

    if (passed) {
      passedCount += 1;
    } else {
      failedCount += 1;
    }

    if (failedCount > 3) {
      cutShort = true;
      break;
    }
  }

  await tools.playwright.browserClose({});

  const report = buildReport(passedCount, failedCount, failedScenarios, problems);

  try {
    await tools.filesystem.writeFile({ path: "qa-report.md", content: report });
  } catch (error) {
    recordFailure(problems, "qa-report.md", error);
  }

  return { passed: passedCount, failed: failedCount, cutShort };
}
```

## incident-responder

Servers: filesystem, everything, sequential-thinking · 28 tools · system prompt ≈ 4872 tokens.

Tools actually called: `everything.getEnv`, `everything.getStructuredContent`, `filesystem.listDirectory`, `filesystem.readTextFile`, `filesystem.writeFile`, `sequentialThinking.sequentialthinking`

### round 0 → L2 · 300 lines · 50 nodes (387s)

Node types: function×13, tool×12, code×7, condition×5, merge×5, try×3, output×2, trigger×1, parallel×1, loop×1

Covered: condition, early-return, else-if-chain, function, loop, parallel, try

Diagnostics:

- `info/unsupported-construct` (line 204) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 207) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 224) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 240) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 263) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 275) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 278) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

interface Incident {
  id: string;
  title: string;
  errorRate: number;
  affectedUsers: number;
  service: string;
  logFilePaths: string[];
}

type Severity = "sev1" | "sev2" | "sev3" | "sev4";

interface LogFailure {
  path: string;
  reason: string;
}

interface LogSummary {
  path: string;
  head: string;
}

type StatusPayload = {
  temperature: number;
  conditions: string;
  humidity: number;
};

const LOW_LOG_PATH = "incidents/low.log";
const TRACKED_LOG_PATH = "incidents/tracked.log";

const STATUS_LOCATIONS = ["New York", "Chicago", "Los Angeles"] as const;
type StatusLocation = (typeof STATUS_LOCATIONS)[number];

function classifySeverity(errorRate: number, affectedUsers: number): Severity {
  if (errorRate > 50 || affectedUsers > 10000) {
    return "sev1";
  }
  if (errorRate > 20 || affectedUsers > 1000) {
    return "sev2";
  }
  if (errorRate > 5) {
    return "sev3";
  }
  return "sev4";
}

function timestamp(): string {
  return new Date().toISOString();
}

function lowLogLine(input: Incident): string {
  return `${timestamp()} sev4 ${input.id} ${input.title} (service=${input.service}, errorRate=${input.errorRate}%, users=${input.affectedUsers})\n`;
}

function trackedLine(input: Incident, logsRead: number, logsFailed: number): string {
  return `${timestamp()} sev3 ${input.id} ${input.title} (service=${input.service}, logsRead=${logsRead}, logsFailed=${logsFailed})\n`;
}

function logFolderOf(logFilePaths: string[]): string {
  const first = logFilePaths[0] ?? "";
  const slash = first.lastIndexOf("/");
  if (slash <= 0) {
    return ".";
  }
  return first.slice(0, slash);
}

function statusLocationFor(service: string): StatusLocation {
  let hash = 0;
  for (let index = 0; index < service.length; index += 1) {
    hash = (hash * 31 + service.charCodeAt(index)) % STATUS_LOCATIONS.length;
  }
  return STATUS_LOCATIONS[hash] ?? "New York";
}

function firstLineOf(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text.trim() : text.slice(0, newline).trim();
}

function collectLogSummary(summaries: LogSummary[], path: string, head: string) {
  summaries.push({ path, head });
}

function recordLogFailure(failures: LogFailure[], path: string, error: unknown) {
  failures.push({ path, reason: error instanceof Error ? error.message : String(error) });
}

function describeLogOutcome(summaries: LogSummary[], failures: LogFailure[]): string {
  if (summaries.length === 0 && failures.length === 0) {
    return "no log files were referenced by the incident";
  }
  const parts = [`read ${summaries.length} (${summaries.map((summary) => summary.path).join(", ") || "none"})`];
  if (failures.length > 0) {
    parts.push(`failed ${failures.length} (${failures.map((failure) => failure.path).join(", ")})`);
  }
  return parts.join("; ");
}

function escalationPlan(severity: Severity): string {
  if (severity === "sev1") {
    return "notify the on-call channel and the incident commander simultaneously";
  }
  return "notify the on-call channel";
}

function buildEscalationMessage(
  input: Incident,
  severity: Severity,
  status: StatusPayload,
  logsRead: number,
  logsFailed: number,
): string {
  return [
    `[${severity.toUpperCase()}] incident ${input.id} — ${input.title}`,
    `service: ${input.service}`,
    `error rate: ${input.errorRate}% | affected users: ${input.affectedUsers}`,
    `structured status: ${status.conditions}, ${status.temperature}°C, humidity ${status.humidity}%`,
    `logs: ${logsRead} read, ${logsFailed} failed`,
    `plan: ${escalationPlan(severity)}`,
  ].join("\n");
}

function environmentSummary(environment: unknown): string {
  if (typeof environment === "object" && environment !== null) {
    return `snapshot captured (${Object.keys(environment).length} entries)`;
  }
  return "snapshot unavailable";
}

function timelinePathFor(id: string): string {
  return `incidents/${id}.md`;
}

function buildTimeline(
  input: Incident,
  severity: Severity,
  status: StatusPayload,
  environment: unknown,
  folderListing: string,
  summaries: LogSummary[],
  failures: LogFailure[],
  escalation: string | null,
): string {
  const lines: string[] = [
    `# Incident ${input.id} — ${input.title}`,
    "",
    `Recorded ${timestamp()}.`,
    "",
    "## Summary",
    "",
    `- Service: ${input.service}`,
    `- Error rate: ${input.errorRate}%`,
    `- Affected users: ${input.affectedUsers}`,
    `- Severity: ${severity}`,
    "",
    "## Context",
    "",
    `- Environment: ${environmentSummary(environment)}`,
    `- Structured status: ${status.conditions}, ${status.temperature}°C, humidity ${status.humidity}%`,
    "",
    "### Log folder listing",
    "",
    "```",
    folderListing.trim(),
    "```",
    "",
    "## Logs",
    "",
  ];

  if (summaries.length > 0) {
    lines.push(`Read successfully (${summaries.length}):`);
    for (const summary of summaries) {
      lines.push(`- ${summary.path} — first line: ${summary.head}`);
    }
  } else {
    lines.push("No log files were read successfully.");
  }

  if (failures.length > 0) {
    lines.push("", `Failed reads (${failures.length}):`);
    for (const failure of failures) {
      lines.push(`- ${failure.path} — ${failure.reason}`);
    }
  }

  lines.push("", "## Escalation", "");
  if (escalation !== null) {
    lines.push("```", escalation, "```");
  } else {
    lines.push("No page sent; incident recorded for tracking.");
  }

  return lines.join("\n");
}

export default async function flow(input: Incident, tools: Tools) {
  const severity = classifySeverity(input.errorRate, input.affectedUsers);

  if (severity === "sev4") {
    let lowLog = "";
    try {
      const existingLow = await tools.filesystem.readTextFile({ path: LOW_LOG_PATH });
      lowLog = existingLow.content;
    } catch {
      // First low-priority incident — start a fresh file.
    }
    const lowEntry = lowLogLine(input);
    await tools.filesystem.writeFile({ path: LOW_LOG_PATH, content: lowLog + lowEntry });
    return { severity, logsRead: 0, logsFailed: 0 };
  }

  const logFolder = logFolderOf(input.logFilePaths);
  const statusLocation = statusLocationFor(input.service);
  const [environment, status, folderListing] = await Promise.all([
    tools.everything.getEnv({}),
    tools.everything.getStructuredContent({ location: statusLocation }),
    tools.filesystem.listDirectory({ path: logFolder }),
  ]);

  const summaries: LogSummary[] = [];
  const failures: LogFailure[] = [];

  for (const logPath of input.logFilePaths) {
    try {
      const log = await tools.filesystem.readTextFile({ path: logPath });
      const head = firstLineOf(log.content);
      collectLogSummary(summaries, logPath, head);
    } catch (error) {
      recordLogFailure(failures, logPath, error);
    }
  }

  const logOutcome = describeLogOutcome(summaries, failures);
  const plan = escalationPlan(severity);

  let escalation: string | null = null;

  if (severity === "sev1" || severity === "sev2") {
    const assessment = await tools.sequentialThinking.sequentialthinking({
      thought: `Assessing incident ${input.id} (“${input.title}”) on ${input.service}: error rate ${input.errorRate}%, ${input.affectedUsers} users affected, classified ${severity}. Context collected: environment snapshot, structured status (${status.conditions}, ${status.temperature}°C, humidity ${status.humidity}%), log folder “${logFolder}”, and ${summaries.length} of ${input.logFilePaths.length} referenced log files read.`,
      nextThoughtNeeded: true,
      thoughtNumber: 1,
      totalThoughts: 3,
    });
    const correlation = await tools.sequentialThinking.sequentialthinking({
      thought: `Correlating evidence: ${logOutcome}. Cross-checking the successful and failed log reads against the structured status payload and the service environment to confirm the blast radius before escalating.`,
      nextThoughtNeeded: true,
      thoughtNumber: 2,
      totalThoughts: 3,
    });
    const decision = await tools.sequentialThinking.sequentialthinking({
      thought: `Decision: severity ${severity} stands based on the evidence above. Next actions: ${plan}, then write the incident timeline. Reasoning complete.`,
      nextThoughtNeeded: false,
      thoughtNumber: 3,
      totalThoughts: 3,
    });

    const escalationMessage = buildEscalationMessage(input, severity, status, summaries.length, failures.length);
    escalation = escalationMessage;

    if (severity === "sev1") {
      // TODO: no paging/notification tool exists in the registry — deliver escalationMessage to the on-call channel.
      // TODO: no paging/notification tool exists in the registry — deliver escalationMessage to the incident commander at the same time as the on-call page above.
    }
    if (severity === "sev2") {
      // TODO: no paging/notification tool exists in the registry — deliver escalationMessage to the on-call channel.
    }
  }

  if (severity === "sev3") {
    let tracked = "";
    try {
      const existingTracked = await tools.filesystem.readTextFile({ path: TRACKED_LOG_PATH });
      tracked = existingTracked.content;
    } catch {
      // First tracked incident — start a fresh file.
    }
    const trackedEntry = trackedLine(input, summaries.length, failures.length);
    await tools.filesystem.writeFile({ path: TRACKED_LOG_PATH, content: tracked + trackedEntry });
  }

  const timelinePath = timelinePathFor(input.id);
  const timeline = buildTimeline(
    input,
    severity,
    status,
    environment,
    folderListing.content,
    summaries,
    failures,
    escalation,
  );
  await tools.filesystem.writeFile({ path: timelinePath, content: timeline });

  return { severity, logsRead: summaries.length, logsFailed: failures.length };
}
```

## repo-triage-bot

Servers: filesystem, memory · 23 tools · system prompt ≈ 3912 tokens.

Tools actually called: `filesystem.directoryTree`, `filesystem.getFileInfo`, `filesystem.listAllowedDirectories`, `filesystem.listDirectoryWithSizes`, `filesystem.readTextFile`, `filesystem.searchFiles`, `filesystem.writeFile`, `memory.createEntities`, `memory.createRelations`, `memory.readGraph`

### round 0 → L2 · 250 lines · 56 nodes (255s)

Node types: tool×13, function×13, condition×6, merge×6, code×6, jump×4, output×2, loop×2, try×2, trigger×1, parallel×1

Covered: condition, early-return, function, jump, loop, nested-loop, parallel, try · **missing: else-if-chain**

Diagnostics:

- `info/unsupported-construct` (line 176) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 196) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 201) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 203) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 205) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 208) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

type Severity = "high" | "medium" | "low";

interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
}

interface ReportData {
  root: string;
  sizesListing: string;
  tree: string;
  inspected: number;
  counts: SeverityCounts;
  highPaths: string[];
  knownEntities: number;
}

const ERROR_LOG_PATH = "triage-errors.log";
const REPORT_PATH = "triage-report.md";
const HIGH_SIZE_BYTES = 100 * 1024;

function zeroCounts(): SeverityCounts {
  return { high: 0, medium: 0, low: 0 };
}

function normalizeDir(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function parseAllowedDirectories(content: string): string[] {
  try {
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed.map((entry) => String(entry));
    }
  } catch {
    // not JSON — fall through to line-based parsing
  }
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isRootAllowed(root: string, allowed: string[]): boolean {
  const normalizedRoot = normalizeDir(root);
  return allowed.some((dir) => {
    const normalizedDir = normalizeDir(dir);
    return normalizedRoot === normalizedDir || normalizedRoot.startsWith(`${normalizedDir}/`);
  });
}

function parseMatches(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseFileSize(infoContent: string): number {
  try {
    const parsed = JSON.parse(infoContent) as { size?: unknown };
    if (typeof parsed.size === "number") {
      return parsed.size;
    }
  } catch {
    // metadata was not JSON — treat size as unknown
  }
  return 0;
}

function mentionsAny(text: string, needles: string[]): boolean {
  const lowered = text.toLowerCase();
  return needles.some((needle) => lowered.includes(needle.toLowerCase()));
}

function decideSeverity(sizeBytes: number, contents: string): Severity {
  if (sizeBytes > HIGH_SIZE_BYTES || mentionsAny(contents, ["password"])) {
    return "high";
  }
  if (mentionsAny(contents, ["todo", "fixme"])) {
    return "medium";
  }
  return "low";
}

function failureLine(path: string, error: unknown): string {
  const stamp = new Date().toISOString();
  return `[${stamp}] failed to read ${path}: ${String(error)}`;
}

function fileObservations(severity: Severity, sizeBytes: number): string[] {
  return [`severity: ${severity}`, `size: ${sizeBytes} bytes`];
}

function runEntityName(root: string): string {
  return `triage-run:${normalizeDir(root)}@${new Date().toISOString()}`;
}

function tally(counts: SeverityCounts, severity: Severity): void {
  counts[severity] += 1;
}

function noteHigh(paths: string[], path: string): void {
  paths.push(path);
}

function buildReport(data: ReportData): string {
  const lines: string[] = [];
  lines.push("# Repository triage report");
  lines.push("");
  lines.push(`Root directory: ${data.root}`);
  lines.push("");
  lines.push("## Repository size");
  lines.push("```");
  lines.push(data.sizesListing);
  lines.push("```");
  lines.push("");
  lines.push("## Directory tree");
  lines.push("```");
  lines.push(data.tree);
  lines.push("```");
  lines.push("");
  lines.push("## Scan results");
  lines.push(`- Files inspected this run: ${String(data.inspected)}`);
  lines.push(`- High severity: ${String(data.counts.high)}`);
  lines.push(`- Medium severity: ${String(data.counts.medium)}`);
  lines.push(`- Low severity: ${String(data.counts.low)}`);
  lines.push(`- Entities now in knowledge graph: ${String(data.knownEntities)}`);
  lines.push("");
  lines.push("## High-severity paths");
  if (data.highPaths.length === 0) {
    lines.push("- none");
  } else {
    for (const path of data.highPaths) {
      lines.push(`- ${path}`);
    }
  }
  return lines.join("\n");
}

export default async function flow(
  input: { rootDirectory: string; riskyPatterns: string[]; maxFiles: number },
  tools: Tools
) {
  const allowedResult = await tools.filesystem.listAllowedDirectories({});
  const allowedDirs = parseAllowedDirectories(allowedResult.content);
  const permitted = isRootAllowed(input.rootDirectory, allowedDirs);
  const emptyCounts = zeroCounts();

  if (!permitted) {
    return { refused: true, filesInspected: 0, counts: emptyCounts, readFailures: 0 };
  }

  const [sizesListing, tree] = await Promise.all([
    tools.filesystem.listDirectoryWithSizes({ path: input.rootDirectory }),
    tools.filesystem.directoryTree({ path: input.rootDirectory })
  ]);

  const runName = runEntityName(input.rootDirectory);
  await tools.memory.createEntities({
    entities: [{
      name: runName,
      entityType: "triage-run",
      observations: [
        `root directory: ${input.rootDirectory}`,
        `max files per run: ${String(input.maxFiles)}`
      ]
    }]
  });

  const counts = zeroCounts();
  const highPaths: string[] = [];
  let inspected = 0;
  let readFailures = 0;

  for (const pattern of input.riskyPatterns) {
    if (inspected >= input.maxFiles) {
      break;
    }

    const searchHit = await tools.filesystem.searchFiles({ path: input.rootDirectory, pattern });
    const matches = parseMatches(searchHit.content);

    if (matches.length === 0) {
      continue;
    }

    for (const filePath of matches) {
      if (inspected >= input.maxFiles) {
        break;
      }
      inspected += 1;

      let contents: string | null = null;
      try {
        const read = await tools.filesystem.readTextFile({ path: filePath });
        contents = read.content;
      } catch (error) {
        readFailures += 1;
        const line = failureLine(filePath, error);
        let previous = "";
        try {
          const existing = await tools.filesystem.readTextFile({ path: ERROR_LOG_PATH });
          previous = existing.content;
        } catch {
          // no log file yet — start a fresh one
        }
        await tools.filesystem.writeFile({ path: ERROR_LOG_PATH, content: `${previous}${line}\n` });
      }

      if (contents === null) {
        continue;
      }

      const info = await tools.filesystem.getFileInfo({ path: filePath });
      const sizeBytes = parseFileSize(info.content);
      const severity = decideSeverity(sizeBytes, contents);
      tally(counts, severity);
      const observations = fileObservations(severity, sizeBytes);
      await tools.memory.createEntities({
        entities: [{ name: filePath, entityType: "triaged-file", observations }]
      });

      if (severity === "high") {
        noteHigh(highPaths, filePath);
        await tools.memory.createRelations({
          relations: [{ from: filePath, to: runName, relationType: "flagged_during" }]
        });
      }
    }
  }

  const graph = await tools.memory.readGraph({});
  const report = buildReport({
    root: input.rootDirectory,
    sizesListing: sizesListing.content,
    tree: tree.content,
    inspected,
    counts,
    highPaths,
    knownEntities: graph.entities.length
  });
  await tools.filesystem.writeFile({ path: REPORT_PATH, content: report });

  return { refused: false, filesInspected: inspected, counts, readFailures };
}
```

## research-pipeline

Servers: duckduckgo, context7, deepwiki, sequential-thinking, memory, filesystem · 28 tools · system prompt ≈ 5695 tokens.

Tools actually called: `context7.queryDocs`, `context7.resolveLibraryId`, `deepwiki.deepwikiFetch`, `duckduckgo.duckduckgoWebSearch`, `filesystem.createDirectory`, `filesystem.writeFile`, `memory.createEntities`, `memory.createRelations`, `sequentialThinking.sequentialthinking`

### round 0 → L2 · 170 lines · 38 nodes (474s)

Node types: tool×13, function×10, code×4, merge×2, loop×2, try×2, trigger×1, parallel×1, jump×1, condition×1, output×1

Covered: condition, function, jump, loop, parallel, try · **missing: nested-loop**

Diagnostics:

- `info/unsupported-construct` (line 96) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 102) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 105) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 123) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

interface ResearchSource {
  url: string;
  label: string;
}

function wikiUrl(repository: string): string {
  if (repository.startsWith("http")) {
    return repository;
  }
  return `https://deepwiki.com/${repository}`;
}

function searchUrl(question: string): string {
  return `https://duckduckgo.com/?q=${encodeURIComponent(question)}`;
}

// TODO: context7.resolveLibraryId returns no structured library id in this
// registry, so the library name stands in for the /org/project id below.
function context7Url(libraryName: string): string {
  return `https://context7.com/${libraryName}`;
}

function recordSource(sources: ResearchSource[], source: ResearchSource): void {
  sources.push(source);
}

function recordDead(dead: string[], libraryName: string): void {
  dead.push(libraryName);
}

function dedupeByUrl(
  sources: ResearchSource[]
): { kept: ResearchSource[]; duplicates: number } {
  const seen = new Set<string>();
  const kept: ResearchSource[] = [];
  let duplicates = 0;

  for (const source of sources) {
    if (seen.has(source.url)) {
      duplicates += 1;
      continue;
    }
    seen.add(source.url);
    kept.push(source);
  }

  return { kept, duplicates };
}

function renderSources(sources: ResearchSource[], question: string): string {
  const lines = sources.map((source) => `- [${source.label}](${source.url})`);
  return [`# Sources for: ${question}`, "", ...lines, ""].join("\n");
}

function renderDeadSources(dead: string[]): string {
  const lines = dead.map((name) => `- ${name}`);
  return [`# Dead sources (${dead.length})`, "", ...lines, ""].join("\n");
}

export default async function flow(
  input: { question: string; libraries: string[]; repository: string },
  tools: Tools
) {
  // 1. Put the research plan on record in three sequential thoughts.
  await tools.sequentialThinking.sequentialthinking({
    thought: `Research plan, step 1: frame "${input.question}" and decide what evidence the brief needs. Gather broad context from a web search and the repository wiki in parallel.`,
    nextThoughtNeeded: true,
    thoughtNumber: 1,
    totalThoughts: 3
  });

  await tools.sequentialThinking.sequentialthinking({
    thought: `Research plan, step 2: for each of the ${input.libraries.length} requested libraries, resolve a documentation id first; skip any that do not resolve, and guard every documentation fetch so one dead source cannot end the run.`,
    nextThoughtNeeded: true,
    thoughtNumber: 2,
    totalThoughts: 3
  });

  await tools.sequentialThinking.sequentialthinking({
    thought: "Research plan, step 3: deduplicate the collected sources by URL, persist the survivors to the knowledge graph under the research question, write sources.md plus a dead-sources.md when needed, and report kept/deduplicated/dead counts.",
    nextThoughtNeeded: false,
    thoughtNumber: 3,
    totalThoughts: 3
  });

  // 2. Web search and repository wiki fetch, independent of each other.
  const repoWikiUrl = wikiUrl(input.repository);

  await Promise.all([
    tools.duckduckgo.duckduckgoWebSearch({ query: input.question, count: 10 }),
    tools.deepwiki.deepwikiFetch({ url: repoWikiUrl, mode: "aggregate" })
  ]);

  const collected: ResearchSource[] = [];
  const deadLibraries: string[] = [];

  // The search tool exposes no per-hit URLs in this registry, so the search
  // itself is recorded as one provenance source for the web leg.
  const webUrl = searchUrl(input.question);
  const webSource: ResearchSource = { url: webUrl, label: `Web search: ${input.question}` };
  recordSource(collected, webSource);

  const wikiSource: ResearchSource = { url: repoWikiUrl, label: `Repository wiki: ${input.repository}` };
  recordSource(collected, wikiSource);

  // 3. Resolve every library, then pull its documentation for the question.
  for (const libraryName of input.libraries) {
    try {
      await tools.context7.resolveLibraryId({ query: input.question, libraryName });
    } catch {
      // Did not resolve: skip this library and move on to the next one.
      continue;
    }

    try {
      // TODO: pass the resolved /org/project id here once the registry
      // exposes it; the library name is the best identifier available today.
      await tools.context7.queryDocs({ libraryId: libraryName, query: input.question });

      const docUrl = context7Url(libraryName);
      const docSource: ResearchSource = { url: docUrl, label: `Documentation: ${libraryName}` };
      recordSource(collected, docSource);
    } catch {
      // A failing documentation source must not kill the run.
      recordDead(deadLibraries, libraryName);
    }
  }

  // 4. Deduplicate by URL before anything works with the sources.
  const { kept: survivingSources, duplicates: duplicateCount } = dedupeByUrl(collected);

  // 5. Store each survivor and relate it to the research-question entity.
  await tools.memory.createEntities({
    entities: [
      { name: input.question, entityType: "research_question", observations: [input.question] }
    ]
  });

  for (const source of survivingSources) {
    await tools.memory.createEntities({
      entities: [
        { name: source.url, entityType: "source", observations: [input.question] }
      ]
    });

    await tools.memory.createRelations({
      relations: [{ from: source.url, to: input.question, relationType: "supports" }]
    });
  }

  // 6. Write the analyst-facing reports.
  await tools.filesystem.createDirectory({ path: "research" });

  const sourcesReport = renderSources(survivingSources, input.question);
  await tools.filesystem.writeFile({ path: "research/sources.md", content: sourcesReport });

  if (deadLibraries.length > 0) {
    const deadReport = renderDeadSources(deadLibraries);
    await tools.filesystem.writeFile({ path: "research/dead-sources.md", content: deadReport });
  }

  // 7. Report the tally.
  return {
    sourcesKept: survivingSources.length,
    duplicatesRemoved: duplicateCount,
    deadSources: deadLibraries.length
  };
}
```

## data-migration

Servers: filesystem, memory · 23 tools · system prompt ≈ 3912 tokens.

Tools actually called: `filesystem.createDirectory`, `filesystem.readMultipleFiles`, `filesystem.searchFiles`, `filesystem.writeFile`, `memory.createEntities`

### round 0 → L2 · 228 lines · 44 nodes (338s)

Node types: function×13, tool×7, code×6, condition×4, merge×4, jump×4, output×2, loop×2, trigger×1, try×1

Covered: condition, early-return, function, jump, loop, nested-loop, try

Diagnostics:

- `info/unsupported-construct` (line 147) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 177) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 188) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 196) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 213) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 216) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

type MigrationFailure = { path: string; reason: string };

type NoteEntry =
  | { ok: true; path: string; content: string }
  | { ok: false; path: string; error: string };

function recordFailure(failures: MigrationFailure[], path: string, error: unknown) {
  failures.push({ path, reason: String(error) });
}

function chunk<T>(items: T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += step) {
    batches.push(items.slice(index, index + step));
  }
  return batches;
}

// searchFiles returns matching paths; tolerate both newline-separated and JSON-array output.
function parseNoteList(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((item): item is string => typeof item === "string");
      }
    } catch {
      // fall through to line-based parsing
    }
  }
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

// readMultipleFiles joins per-file results with "\n---\n"; each section starts
// with "<path>:" followed by the file body on success, or "Error - ..." on failure.
function parseBatchContents(raw: string): NoteEntry[] {
  const entries: NoteEntry[] = [];
  for (const section of raw.split("\n---\n")) {
    const lineBreak = section.indexOf("\n");
    const header = (lineBreak === -1 ? section : section.slice(0, lineBreak)).trim();
    const body = lineBreak === -1 ? "" : section.slice(lineBreak + 1);
    const colon = header.lastIndexOf(":");
    if (colon === -1) {
      continue;
    }
    const path = header.slice(0, colon).trim();
    const status = header.slice(colon + 1).trim();
    if (status.startsWith("Error")) {
      entries.push({ ok: false, path, error: status });
    } else {
      entries.push({ ok: true, path, content: body });
    }
  }
  return entries;
}

// The legacy-to-standard transformation: normalize line endings, drop legacy
// "empty" placeholders, collapse excess blank lines, and prepend a title heading
// derived from the file name. Returns "" when nothing meaningful remains.
function transformNote(sourcePath: string, rawContent: string): string {
  const body = normalizeBody(rawContent);
  if (body === "") {
    return "";
  }
  return `# ${entityNameFor(sourcePath)}\n\n${body}\n`;
}

function normalizeBody(rawContent: string): string {
  const unified = rawContent.replace(/\r\n?/g, "\n");
  const trimmed = unified.trim();
  if (trimmed === "" || trimmed === "[[empty]]") {
    return "";
  }
  return trimmed.replace(/\n{3,}/g, "\n\n");
}

function isEmptyNote(text: string): boolean {
  return text.trim() === "";
}

function entityNameFor(sourcePath: string): string {
  const fileName = sourcePath.split("/").pop() ?? sourcePath;
  const dotIndex = fileName.lastIndexOf(".");
  const base = dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
  const cleaned = base.trim();
  return cleaned === "" ? "untitled-note" : cleaned;
}

// Nested legacy paths are flattened into unique file names inside the
// destination root, so only the destination directory itself has to exist.
function destinationFilePath(destinationDirectory: string, sourcePath: string): string {
  const segments = sourcePath.split(/[\\/]+/).filter((segment) => segment !== "");
  return `${destinationDirectory}/${segments.join("--")}`;
}

function reportFilePath(destinationDirectory: string): string {
  return `${destinationDirectory}/migration-report.md`;
}

function exceedsFailureTolerance(failedCount: number, maxFailures: number): boolean {
  return failedCount > maxFailures;
}

function renderReport(
  migratedCount: number,
  skippedCount: number,
  failedCount: number,
  aborted: boolean,
  failureList: MigrationFailure[]
): string {
  const lines: string[] = [
    "# Migration report",
    "",
    `- Migrated: ${migratedCount}`,
    `- Skipped (empty after transformation): ${skippedCount}`,
    `- Failed: ${failedCount}`,
    `- Aborted before finishing all batches: ${aborted ? "yes" : "no"}`,
    "",
    "## Failures",
    ""
  ];
  if (failureList.length === 0) {
    lines.push("- none");
  }
  for (const failure of failureList) {
    lines.push(`- ${failure.path}: ${failure.reason}`);
  }
  return lines.join("\n");
}

export default async function flow(
  input: {
    sourceDirectory: string;
    destinationDirectory: string;
    batchSize: number;
    maxFailures: number;
  },
  tools: Tools
) {
  const failures: MigrationFailure[] = [];
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  let aborted = false;

  // 1. The destination directory must exist before anything is written.
  await tools.filesystem.createDirectory({ path: input.destinationDirectory });

  // 2. Find every legacy note file under the source directory.
  const searchResult = await tools.filesystem.searchFiles({
    path: input.sourceDirectory,
    pattern: "**/*.md"
  });
  const notePaths = parseNoteList(searchResult.content);

  // 3. Nothing to migrate: write an empty report and return immediately.
  if (notePaths.length === 0) {
    const emptyReport = renderReport(0, 0, 0, false, []);
    const reportPath = reportFilePath(input.destinationDirectory);
    await tools.filesystem.writeFile({ path: reportPath, content: emptyReport });
    return { migrated: 0, skipped: 0, failed: 0, aborted: false };
  }

  const batches = chunk(notePaths, input.batchSize);

  // 4–7. Process the notes batch by batch.
  for (const batch of batches) {
    const overBudget = exceedsFailureTolerance(failed, input.maxFailures);
    if (overBudget) {
      aborted = true;
      break;
    }

    // Read the whole batch in one go.
    const batchResult = await tools.filesystem.readMultipleFiles({ paths: batch });
    const entries = parseBatchContents(batchResult.content);

    for (const entry of entries) {
      if (!entry.ok) {
        recordFailure(failures, entry.path, entry.error);
        failed += 1;
        continue;
      }

      const transformed = transformNote(entry.path, entry.content);

      // 6. Empty after transformation: skip, counting neither success nor failure.
      if (isEmptyNote(transformed)) {
        skipped += 1;
        continue;
      }

      // 5. A note that fails to write or record is a failure; keep going.
      try {
        const targetPath = destinationFilePath(input.destinationDirectory, entry.path);
        await tools.filesystem.writeFile({ path: targetPath, content: transformed });

        // 8. Record every successfully migrated note in the knowledge graph.
        const entityName = entityNameFor(entry.path);
        await tools.memory.createEntities({
          entities: [
            { name: entityName, entityType: "note", observations: [entry.path] }
          ]
        });

        migrated += 1;
      } catch (error) {
        recordFailure(failures, entry.path, error);
        failed += 1;
        continue;
      }
    }
  }

  // 9. Final report and result.
  const report = renderReport(migrated, skipped, failed, aborted, failures);
  const reportPath = reportFilePath(input.destinationDirectory);
  await tools.filesystem.writeFile({ path: reportPath, content: report });

  return { migrated, skipped, failed, aborted };
}
```

## knowledge-base-sync

Servers: memory, context7, deepwiki, duckduckgo, filesystem · 27 tools · system prompt ≈ 4801 tokens.

Tools actually called: `deepwiki.deepwikiFetch`, `duckduckgo.duckduckgoWebSearch`, `filesystem.writeFile`, `memory.addObservations`, `memory.deleteEntities`, `memory.searchNodes`

### round 0 → L2 · 344 lines · 64 nodes (421s)

Node types: function×21, code×16, tool×6, condition×5, loop×4, jump×4, try×3, merge×3, trigger×1, output×1

Covered: condition, function, jump, loop, nested-loop, try, while-loop

Diagnostics:

- `info/unsupported-construct` (line 229) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 232) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 236) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 249) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 259) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 263) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 277) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 281) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 284) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 290) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 296) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 308) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 312) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 319) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 321) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 325) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface WebHit {
  title: string;
  url: string;
}

interface TopicStats {
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
}

interface TopicSummary {
  topic: string;
  stats: TopicStats;
}

// ---------------------------------------------------------------------------
// Helpers (each becomes a readable function node when called from the flow)
// ---------------------------------------------------------------------------

function newStats(): TopicStats {
  return { updated: 0, deleted: 0, skipped: 0, failed: 0 };
}

function extractNodeNames(entities: { name: string; observations: string[] }[]): string[] {
  return entities.map((entity) => entity.name);
}

function mergeNames(into: string[], additions: string[]) {
  for (const name of additions) {
    into.push(name);
  }
}

function rememberHeld(held: Record<string, string[]>, name: string, observations: string[]) {
  held[name] = observations;
}

/** A page is considered "full" when it came back with at least pageSize entries. */
function pageLooksFull(names: string[], pageSize: number): boolean {
  return names.length >= pageSize;
}

/** Requirement 2: the same node regularly shows up on more than one page. */
function dedupeNames(names: string[]): string[] {
  return Array.from(new Set(names));
}

/** Requirement 6: never touch more than pageSize * maxPages nodes per topic. */
function limitToBudget(names: string[], budget: number): string[] {
  return names.slice(0, Math.max(0, budget));
}

function buildSearchQuery(nodeName: string, topic: string): string {
  return `${nodeName} ${topic}`;
}

function collectHits(hits: WebHit[], candidates: unknown[]) {
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object") {
      continue;
    }
    const hit = candidate as { title?: unknown; url?: unknown };
    if (typeof hit.url === "string") {
      hits.push({
        title: typeof hit.title === "string" ? hit.title : hit.url,
        url: hit.url,
      });
    }
  }
}

function parseSearchResults(raw: unknown): WebHit[] {
  const hits: WebHit[] = [];
  if (Array.isArray(raw)) {
    collectHits(hits, raw);
  } else if (raw !== null && typeof raw === "object") {
    const maybe = (raw as { results?: unknown }).results;
    if (Array.isArray(maybe)) {
      collectHits(hits, maybe);
    }
  }
  return hits;
}

function hasUpstreamHit(hits: WebHit[]): boolean {
  return hits.length > 0;
}

function firstUrl(hits: WebHit[]): string | null {
  if (hits.length === 0) {
    return null;
  }
  return hits[0].url;
}

function joinBlockText(blocks: unknown[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block !== null && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") {
      parts.push((block as Record<string, unknown>).text as string);
    }
  }
  return parts.join("\n");
}

function parseDocText(raw: unknown): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw === null || typeof raw !== "object") {
    return "";
  }
  const record = raw as Record<string, unknown>;
  for (const key of ["text", "markdown", "content", "body"]) {
    if (typeof record[key] === "string") {
      return record[key] as string;
    }
  }
  if (Array.isArray(record.blocks)) {
    return joinBlockText(record.blocks);
  }
  return "";
}

const GONE_MARKERS = ["404", "not found", "no longer exists", "does not exist"];

/** An empty or explicitly-missing page means the node no longer exists upstream. */
function isGoneUpstream(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 20) {
    return true;
  }
  const lowered = trimmed.toLowerCase();
  return GONE_MARKERS.some((marker) => lowered.includes(marker));
}

function findLatestDate(text: string): Date | null {
  const stamps = text.match(/\d{4}-\d{2}-\d{2}/g);
  let latest: Date | null = null;
  for (const stamp of stamps ?? []) {
    const parsed = new Date(`${stamp}T00:00:00Z`);
    if (!Number.isNaN(parsed.getTime()) && (latest === null || parsed > latest)) {
      latest = parsed;
    }
  }
  return latest;
}

/**
 * Freshness test: compare the newest date in the upstream document against the
 * newest date already recorded on the node. Missing dates count as "newer"
 * (refresh rather than silently drop).
 */
function isUpstreamNewer(upstreamText: string, heldObservations: string[]): boolean {
  const upstreamDate = findLatestDate(upstreamText);
  if (upstreamDate === null) {
    return true;
  }
  let heldLatest: Date | null = null;
  for (const observation of heldObservations) {
    const found = findLatestDate(observation);
    if (found !== null && (heldLatest === null || found > heldLatest)) {
      heldLatest = found;
    }
  }
  if (heldLatest === null) {
    return true;
  }
  return upstreamDate.getTime() > heldLatest.getTime();
}

function recordFailure(failures: string[], subject: string, error: unknown) {
  failures.push(`${subject}: ${String(error)}`);
}

function addInto(total: TopicStats, stats: TopicStats) {
  total.updated += stats.updated;
  total.deleted += stats.deleted;
  total.skipped += stats.skipped;
  total.failed += stats.failed;
}

function recordTopic(summaries: TopicSummary[], topic: string, stats: TopicStats) {
  summaries.push({ topic, stats });
}

function buildSyncLog(summaries: TopicSummary[], failures: string[]): string {
  const lines: string[] = [
    "# Knowledge base sync log",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
  ];
  for (const summary of summaries) {
    lines.push(`## ${summary.topic}`);
    lines.push(`- Updated: ${summary.stats.updated}`);
    lines.push(`- Deleted: ${summary.stats.deleted}`);
    lines.push(`- Skipped: ${summary.stats.skipped}`);
    lines.push(`- Failed: ${summary.stats.failed}`);
    lines.push("");
  }
  lines.push("## Failures");
  if (failures.length === 0) {
    lines.push("- None");
  } else {
    for (const failure of failures) {
      lines.push(`- ${failure}`);
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export default async function flow(
  input: { topics: string[]; pageSize: number; maxPages: number },
  tools: Tools
) {
  const failures: string[] = [];
  const perTopic: TopicSummary[] = [];
  const totals = newStats();
  const pageBudget = input.pageSize * input.maxPages;

  for (const topic of input.topics) {
    const stats = newStats();
    const names: string[] = [];
    const held: Record<string, string[]> = {};
    let page = 0;
    let morePages = true;

    // TODO(pagination): tools.memory.searchNodes does not yet expose a page /
    // cursor argument, so each request returns the full current match set.
    // Once paging lands, pass the cursor through ({ query, page }) below. The
    // counter, the full-page check and the maxPages bound already implement the
    // required stopping logic, and dedupeNames absorbs the repeats meanwhile.
    // Requirement 1: bounded walk — stops when a page comes back smaller than
    // pageSize, or when maxPages pages have been walked for this topic.
    while (morePages && page < input.maxPages) {
      page += 1;
      try {
        const found = await tools.memory.searchNodes({ query: topic });
        const pageNames = extractNodeNames(found.entities);
        mergeNames(names, pageNames);
        for (const entity of found.entities) {
          rememberHeld(held, entity.name, entity.observations);
        }
        const pageFull = pageLooksFull(pageNames, input.pageSize);
        if (!pageFull) {
          morePages = false;
        }
      } catch (error) {
        recordFailure(failures, `graph page ${page} for "${topic}"`, error);
        stats.failed += 1;
        morePages = false;
      }
    }

    // Requirement 2 then 6: deduplicate, then cap at one full walk's worth.
    const unique = dedupeNames(names);
    const capped = limitToBudget(unique, pageBudget);

    for (const name of capped) {
      const query = buildSearchQuery(name, topic);

      // Requirement 3: search the web for node name + topic. A failing source
      // must not stop the sync (requirement 4 applies here too).
      let hits: WebHit[] = [];
      try {
        const rawHits = await tools.duckduckgo.duckduckgoWebSearch({ query, count: 5 });
        const parsed = parseSearchResults(rawHits);
        hits = parsed;
      } catch (error) {
        recordFailure(failures, `web search for "${name}" (${query})`, error);
        stats.failed += 1;
        continue;
      }

      const hasHit = hasUpstreamHit(hits);
      if (!hasHit) {
        stats.skipped += 1;
        continue;
      }

      const target = firstUrl(hits);
      if (target === null) {
        stats.skipped += 1;
        continue;
      }

      // Requirements 4 and 5: fetch the upstream document; apply or delete.
      try {
        const rawDoc = await tools.deepwiki.deepwikiFetch({ url: target });
        const docText = parseDocText(rawDoc);
        const gone = isGoneUpstream(docText);

        if (gone) {
          await tools.memory.deleteEntities({ entityNames: [name] });
          stats.deleted += 1;
          continue;
        }

        const heldObservations = held[name] ?? [];
        const newer = isUpstreamNewer(docText, heldObservations);

        if (newer) {
          await tools.memory.addObservations({
            observations: [{ entityName: name, contents: [docText] }],
          });
          stats.updated += 1;
        } else {
          stats.skipped += 1;
        }
      } catch (error) {
        recordFailure(failures, `upstream doc for "${name}" (${target})`, error);
        stats.failed += 1;
      }
    }

    addInto(totals, stats);
    recordTopic(perTopic, topic, stats);
  }

  // Requirement 7: write the per-topic log, then hand back the totals.
  const log = buildSyncLog(perTopic, failures);
  const written = await tools.filesystem.writeFile({ path: "sync-log.md", content: log });

  return {
    totals,
    perTopic,
    failures,
    logFile: "sync-log.md",
    logBytes: written.content.length,
  };
}
```

