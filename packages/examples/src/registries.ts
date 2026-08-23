/**
 * The registries the examples are analyzed against.
 *
 * Four of the five are built from **real MCP tool schemas** — verbatim
 * `tools/list` payloads from `@modelcontextprotocol/server-filesystem`,
 * `server-memory`, `server-everything`, `@playwright/mcp`, duckduckgo,
 * deepwiki, context7 and sequential-thinking, frozen into `src/tools/` by
 * `scripts/generate-tools.mjs`. Nothing here was invented to make an example
 * work: if a field is optional, it is optional because the server said so, and
 * a flow that passes the wrong shape fails the type-check in
 * `packages/core/test/stress/type-check.test.ts`.
 *
 * The fifth (`sample`) is the github/slack registry the specs use throughout
 * (01 §1, 07 §6), carried over so the four flows the demo app shipped with keep
 * working. Its schemas are spelled as JSON Schema rather than as the TS type
 * refs the old demo used (`"PullRequest[]"`), for one reason: a generated
 * `tools.d.ts` full of type names nobody declares cannot be type-checked, and
 * an example that cannot be type-checked is an example nobody can trust.
 *
 * Library functions live in `@flows/lib` (05 §4). Their `inputSchema` is a
 * named-fields map — key order is parameter order — and their `code` is the
 * body a user would see behind "Edit Code".
 */

import type { ExampleRegistry } from "./types.js";
import { FILESYSTEM_TOOLS } from "./tools/filesystem.js";
import { MEMORY_TOOLS } from "./tools/memory.js";
import { PLAYWRIGHT_TOOLS } from "./tools/playwright.js";
import { EVERYTHING_TOOLS } from "./tools/everything.js";
import { DUCKDUCKGO_TOOLS } from "./tools/duckduckgo.js";
import { DEEPWIKI_TOOLS } from "./tools/deepwiki.js";
import { CONTEXT7_TOOLS } from "./tools/context7.js";
import { SEQUENTIAL_THINKING_TOOLS } from "./tools/sequential-thinking.js";

const LIB = "@flows/lib";

/* -------------------------------------------------------------------------- */
/* sample — the specs' own github/slack registry (01 §1, 07 §6)                */
/* -------------------------------------------------------------------------- */

const PULL_REQUEST = {
  type: "object",
  properties: {
    number: { type: "number" },
    title: { type: "string" },
    draft: { type: "boolean" },
  },
  required: ["number", "title", "draft"],
} as const;

const CHANGED_FILE = {
  type: "object",
  properties: {
    path: { type: "string" },
    additions: { type: "number" },
  },
  required: ["path", "additions"],
} as const;

const SAMPLE: ExampleRegistry = {
  id: "sample",
  label: "GitHub + Slack (the specs' canonical registry)",
  tools: [
    {
      name: "github.getNewPRs",
      label: "Get New PRs",
      description: "Get new pull requests",
      icon: "🐙",
      inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
      outputSchema: { type: "array", items: PULL_REQUEST },
      editableFields: ["repo"],
    },
    {
      name: "github.getFiles",
      label: "Get PR Files",
      description: "Get files changed in a PR",
      icon: "🐙",
      inputSchema: { type: "object", properties: { pr: PULL_REQUEST }, required: ["pr"] },
      outputSchema: { type: "array", items: CHANGED_FILE },
      editableFields: ["pr"],
    },
    {
      name: "slack.send",
      label: "Slack Send",
      description: "Send a Slack message",
      icon: "💬",
      inputSchema: {
        type: "object",
        properties: { channel: { type: "string" }, message: { type: "string" } },
        required: ["channel", "message"],
      },
      editableFields: ["channel", { name: "message", editor: "expression" }],
    },
    {
      name: "payment.charge",
      label: "Charge Card",
      description: "Charge the customer's card",
      icon: "💳",
      inputSchema: {
        type: "object",
        properties: { amount: { type: "number" } },
        required: ["amount"],
      },
      outputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: ["ok", "pending", "failed"] },
        },
        required: ["id", "status"],
      },
      editableFields: ["amount"],
    },
  ],
  functions: [
    {
      name: "isAuthChange",
      label: "Is Auth Change",
      description: "True when a changed file touches authentication code.",
      icon: "🔐",
      inputSchema: { file: CHANGED_FILE },
      outputSchema: { type: "boolean" },
      code: `export function isAuthChange(file: { path: string; additions: number }) {
  return /auth|login|oauth|permission/i.test(file.path);
}`,
      modulePath: LIB,
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* repo-triage — filesystem (14) + memory (9)                                  */
/* -------------------------------------------------------------------------- */

const RISK_VERDICT = {
  type: "object",
  properties: {
    level: { type: "string", enum: ["high", "medium", "low"] },
    score: { type: "number" },
    reasons: { type: "array", items: { type: "string" } },
  },
  required: ["level", "score", "reasons"],
} as const;

const REPO_TRIAGE: ExampleRegistry = {
  id: "repo-triage",
  label: "Filesystem + Memory (23 real MCP tools)",
  tools: [...FILESYSTEM_TOOLS, ...MEMORY_TOOLS],
  functions: [
    {
      name: "isSourcePath",
      label: "Is Source File",
      description: "True for a file worth reading — source, not a lockfile or a build artifact.",
      icon: "📄",
      inputSchema: { path: { type: "string" } },
      outputSchema: { type: "boolean" },
      code: `const SKIP = /(^|\\/)(node_modules|dist|coverage|\\.git)(\\/|$)|\\.(lock|min\\.js|map|png|jpg|pdf)$/i;

export function isSourcePath(path: string) {
  return !SKIP.test(path) && /\\.(ts|tsx|js|jsx|py|go|rs|java|rb|sql|sh)$/i.test(path);
}`,
      modulePath: LIB,
    },
    {
      name: "scoreRisk",
      label: "Score Risk",
      description: "Rate one file's contents against the triage heuristics.",
      icon: "⚖️",
      inputSchema: { path: { type: "string" }, body: { type: "string" } },
      outputSchema: RISK_VERDICT,
      code: `const RULES: { pattern: RegExp; weight: number; reason: string }[] = [
  { pattern: /\\b(eval|new Function)\\s*\\(/, weight: 5, reason: "dynamic code execution" },
  { pattern: /(api[_-]?key|secret|password)\\s*[:=]/i, weight: 4, reason: "possible embedded credential" },
  { pattern: /TODO|FIXME|HACK/, weight: 1, reason: "unfinished work marker" },
  { pattern: /catch\\s*\\(\\s*\\w*\\s*\\)\\s*\\{\\s*\\}/, weight: 3, reason: "swallowed error" },
];

export function scoreRisk(path: string, body: string) {
  const reasons: string[] = [];
  let score = /(^|\\/)(auth|billing|payment)\\//.test(path) ? 2 : 0;
  for (const rule of RULES) {
    if (rule.pattern.test(body)) {
      score += rule.weight;
      reasons.push(rule.reason);
    }
  }
  const level = score >= 6 ? "high" : score >= 3 ? "medium" : "low";
  return { level: level as "high" | "medium" | "low", score, reasons };
}`,
      modulePath: LIB,
    },
    {
      name: "renderTriageReport",
      label: "Render Triage Report",
      description: "Turn the collected findings into the markdown written back to the repo.",
      icon: "📝",
      inputSchema: {
        repository: { type: "string" },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string" },
              level: { type: "string" },
              score: { type: "number" },
              reasons: { type: "array", items: { type: "string" } },
            },
            required: ["path", "level", "score", "reasons"],
          },
        },
      },
      outputSchema: { type: "string" },
      code: `export function renderTriageReport(
  repository: string,
  findings: { path: string; level: string; score: number; reasons: string[] }[],
) {
  const rows = findings
    .slice()
    .sort((a, b) => b.score - a.score)
    .map((f) => \`| \${f.path} | \${f.level} | \${f.score} | \${f.reasons.join(", ")} |\`);
  return [\`# Triage — \${repository}\`, "", "| File | Level | Score | Why |", "|---|---|---|---|", ...rows].join("\\n");
}`,
      modulePath: LIB,
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* research — duckduckgo + deepwiki + context7 + sequential-thinking + memory  */
/* -------------------------------------------------------------------------- */

const RESEARCH: ExampleRegistry = {
  id: "research",
  label: "DuckDuckGo + DeepWiki + Context7 + Sequential Thinking + Memory + Filesystem (28 real MCP tools)",
  // The four research servers declare no `outputSchema`, so their calls are
  // `Promise<void>` in the generated `tools.d.ts` — that is what the servers
  // actually say, and inventing a return type here would be inventing a fact.
  // A real agent over these servers therefore reads its harvest back off disk
  // and keeps its state in the knowledge graph, which is why `fs` and `memory`
  // are in this registry: they are where the data lives.
  tools: [
    ...DUCKDUCKGO_TOOLS,
    ...DEEPWIKI_TOOLS,
    ...CONTEXT7_TOOLS,
    ...SEQUENTIAL_THINKING_TOOLS,
    ...MEMORY_TOOLS,
    ...FILESYSTEM_TOOLS,
  ],
  functions: [
    {
      name: "planQueries",
      label: "Plan Queries",
      description: "Expand one research topic into the search queries worth running.",
      icon: "🧭",
      inputSchema: { topic: { type: "string" }, depth: { type: "number" } },
      outputSchema: { type: "array", items: { type: "string" } },
      code: `const ANGLES = ["overview", "architecture", "known issues", "alternatives", "benchmarks"];

export function planQueries(topic: string, depth: number) {
  return ANGLES.slice(0, Math.max(1, Math.min(depth, ANGLES.length))).map(
    (angle) => \`\${topic} \${angle}\`,
  );
}`,
      modulePath: LIB,
    },
    {
      name: "rankSources",
      label: "Rank Sources",
      description: "Score raw search output and keep the sources worth reading.",
      icon: "📊",
      inputSchema: { raw: { type: "string" }, minScore: { type: "number" } },
      outputSchema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            url: { type: "string" },
            title: { type: "string" },
            score: { type: "number" },
          },
          required: ["url", "title", "score"],
        },
      },
      code: `const TRUSTED = ["github.com", "developer.mozilla.org", "docs.python.org", "rfc-editor.org"];

export function rankSources(raw: string, minScore: number) {
  return raw
    .split("\\n")
    .map((line) => line.split(" — "))
    .filter((parts) => parts.length === 2)
    .map(([url, title]) => ({
      url,
      title,
      score: TRUSTED.some((host) => url.includes(host)) ? 10 : 4,
    }))
    .filter((source) => source.score >= minScore);
}`,
      modulePath: LIB,
    },
    {
      name: "renderBrief",
      label: "Render Brief",
      description: "Assemble the sections gathered by the agent into one briefing document.",
      icon: "📰",
      inputSchema: {
        topic: { type: "string" },
        sections: { type: "array", items: { type: "string" } },
      },
      outputSchema: { type: "string" },
      code: `export function renderBrief(topic: string, sections: string[]) {
  return [\`# \${topic}\`, "", ...sections.map((section, i) => \`## \${i + 1}. \${section}\`)].join("\\n");
}`,
      modulePath: LIB,
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* browser-qa — playwright (24) + filesystem (14)                              */
/* -------------------------------------------------------------------------- */

const QA_STEP = {
  type: "object",
  properties: {
    action: { type: "string", enum: ["click", "type", "press", "expect", "hover"] },
    target: { type: "string" },
    value: { type: "string" },
  },
  required: ["action", "target"],
} as const;

const BROWSER_QA: ExampleRegistry = {
  id: "browser-qa",
  label: "Playwright + Filesystem (38 real MCP tools)",
  tools: [...PLAYWRIGHT_TOOLS, ...FILESYSTEM_TOOLS],
  functions: [
    {
      name: "parseTestPlan",
      label: "Parse Test Plan",
      description: "Read the checked-in QA plan into cases the runner can walk.",
      icon: "🧾",
      inputSchema: { raw: { type: "string" } },
      outputSchema: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            url: { type: "string" },
            critical: { type: "boolean" },
            steps: { type: "array", items: QA_STEP },
          },
          required: ["id", "url", "critical", "steps"],
        },
      },
      code: `export function parseTestPlan(raw: string) {
  const plan = JSON.parse(raw) as {
    cases: { id: string; url: string; critical?: boolean; steps: { action: string; target: string; value?: string }[] }[];
  };
  return plan.cases.map((testCase) => ({
    id: testCase.id,
    url: testCase.url,
    critical: testCase.critical === true,
    steps: testCase.steps.map((step) => ({
      action: step.action as "click" | "type" | "press" | "expect" | "hover",
      target: step.target,
      value: step.value,
    })),
  }));
}`,
      modulePath: LIB,
    },
    {
      name: "isBlockingFailure",
      label: "Is Blocking Failure",
      description: "Decide whether a step failure should stop the whole suite.",
      icon: "🛑",
      inputSchema: { critical: { type: "boolean" }, message: { type: "string" } },
      outputSchema: { type: "boolean" },
      code: `export function isBlockingFailure(critical: boolean, message: string) {
  if (/timeout|net::ERR/i.test(message)) return true;
  return critical;
}`,
      modulePath: LIB,
    },
    {
      name: "renderJUnit",
      label: "Render JUnit XML",
      description: "Serialise the run into the JUnit XML that CI collects.",
      icon: "📦",
      inputSchema: {
        suite: { type: "string" },
        results: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: { type: "string" },
              detail: { type: "string" },
            },
            required: ["id", "status", "detail"],
          },
        },
      },
      outputSchema: { type: "string" },
      code: `export function renderJUnit(
  suite: string,
  results: { id: string; status: string; detail: string }[],
) {
  const failures = results.filter((r) => r.status !== "passed").length;
  const cases = results.map((r) =>
    r.status === "passed"
      ? \`  <testcase name="\${r.id}" />\`
      : \`  <testcase name="\${r.id}"><failure>\${r.detail}</failure></testcase>\`,
  );
  return [
    \`<testsuite name="\${suite}" tests="\${results.length}" failures="\${failures}">\`,
    ...cases,
    "</testsuite>",
  ].join("\\n");
}`,
      modulePath: LIB,
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* pipeline — filesystem (14) + everything (13)                                */
/* -------------------------------------------------------------------------- */

const PIPELINE: ExampleRegistry = {
  id: "pipeline",
  label: "Filesystem + Everything (27 real MCP tools)",
  tools: [...FILESYSTEM_TOOLS, ...EVERYTHING_TOOLS],
  functions: [
    {
      name: "parseDelimited",
      label: "Parse Delimited File",
      description: "Split a CSV/TSV payload into a header row and data rows.",
      icon: "🔤",
      inputSchema: { raw: { type: "string" }, delimiter: { type: "string" } },
      outputSchema: {
        type: "object",
        properties: {
          headers: { type: "array", items: { type: "string" } },
          rows: { type: "array", items: { type: "array", items: { type: "string" } } },
        },
        required: ["headers", "rows"],
      },
      code: `export function parseDelimited(raw: string, delimiter: string) {
  const lines = raw.split(/\\r?\\n/).filter((line) => line.trim().length > 0);
  const [head, ...rest] = lines;
  return {
    headers: (head ?? "").split(delimiter).map((cell) => cell.trim()),
    rows: rest.map((line) => line.split(delimiter).map((cell) => cell.trim())),
  };
}`,
      modulePath: LIB,
    },
    {
      name: "normalizeRow",
      label: "Normalize Row",
      description: "Coerce one raw row into the canonical record shape, or report why it cannot be.",
      icon: "🧹",
      inputSchema: {
        headers: { type: "array", items: { type: "string" } },
        row: { type: "array", items: { type: "string" } },
      },
      outputSchema: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          reason: { type: "string" },
          record: {
            type: "object",
            properties: {
              id: { type: "string" },
              region: { type: "string" },
              amount: { type: "number" },
            },
            required: ["id", "region", "amount"],
          },
        },
        required: ["ok", "reason"],
      },
      code: `export function normalizeRow(headers: string[], row: string[]) {
  const cell = (name: string) => row[headers.indexOf(name)] ?? "";
  const amount = Number(cell("amount").replace(/[^0-9.-]/g, ""));
  if (cell("id").length === 0) return { ok: false, reason: "missing id" };
  if (!Number.isFinite(amount)) return { ok: false, reason: \`bad amount "\${cell("amount")}"\` };
  return {
    ok: true,
    reason: "",
    record: { id: cell("id"), region: cell("region").toLowerCase() || "unknown", amount },
  };
}`,
      modulePath: LIB,
    },
    {
      name: "renderLedger",
      label: "Render Ledger",
      description: "Format the per-region totals as the ledger written back to disk.",
      icon: "📑",
      inputSchema: {
        totals: {
          type: "array",
          items: {
            type: "object",
            properties: { region: { type: "string" }, total: { type: "number" }, count: { type: "number" } },
            required: ["region", "total", "count"],
          },
        },
      },
      outputSchema: { type: "string" },
      code: `export function renderLedger(totals: { region: string; total: number; count: number }[]) {
  return totals
    .slice()
    .sort((a, b) => b.total - a.total)
    .map((t) => \`\${t.region.padEnd(12)} \${t.count.toString().padStart(5)} \${t.total.toFixed(2).padStart(12)}\`)
    .join("\\n");
}`,
      modulePath: LIB,
    },
  ],
};

export const REGISTRIES: Record<string, ExampleRegistry> = {
  [SAMPLE.id]: SAMPLE,
  [REPO_TRIAGE.id]: REPO_TRIAGE,
  [RESEARCH.id]: RESEARCH,
  [BROWSER_QA.id]: BROWSER_QA,
  [PIPELINE.id]: PIPELINE,
};
