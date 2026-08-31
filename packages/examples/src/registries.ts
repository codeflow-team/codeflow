/**
 * The registries the examples are analyzed against.
 *
 * Four of the six are built from **real MCP tool schemas** — verbatim
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
 * The sixth (`common`) is the odd one out and is documented where it is
 * defined: it borrows the filesystem server's real tools and spends its weight
 * on **library functions** instead — the everyday steps a workflow is actually
 * made of, each with a real body and a real configuration surface.
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

/* -------------------------------------------------------------------------- */
/* common — the everyday steps, as library functions (+ filesystem)            */
/* -------------------------------------------------------------------------- */

/**
 * The n8n "common node" set, minus the four that CodeFlow already projects from
 * the language itself.
 *
 * IF, Merge, Loop Over Items and Code are `condition`, `merge`, `loop` and
 * `code` — core node types the analyzer reads straight out of `if`, `for…of`,
 * `Promise.all` and any statement it will not guess at. Shipping node *types*
 * for them would be a second way to say what TypeScript already says, so this
 * registry deliberately holds the other half: the steps that are genuinely
 * library code — set a field, filter, sort, limit, de-duplicate, split out,
 * aggregate, format, shift a date, wait, parse JSON, and ask a model.
 *
 * Every one is real TypeScript with a real body. The demo runner writes them
 * into `lib.ts` next to the flow and imports them for real (`apps/demo/server/
 * runner.ts`), so anything untrue here fails in front of the user rather than in
 * a comment. They are therefore pure and offline — no network, no filesystem, no
 * `process` — and deterministic, so two runs of the same flow can be compared.
 * The one step that would want a network says so in its own output; see
 * `runAgentStep`.
 *
 * The item shape is one flat record (`Record<string, unknown>`), which is what
 * lets the list steps chain: filter → sort → limit → aggregate, each taking and
 * returning the same thing.
 */
const RECORD = "Record<string, unknown>";
const RECORD_LIST = "Record<string, unknown>[]";

/**
 * Model ids spelled the way OpenRouter spells them, so the select is a real
 * choice rather than a set of plausible-looking strings. Nothing dials them —
 * they are carried into the stand-in's answer so a reader can see which one the
 * flow *would* have asked.
 */
const AGENT_MODELS = [
  "anthropic/claude-3.5-sonnet",
  "openai/gpt-4o-mini",
  "google/gemini-2.0-flash-001",
  "meta-llama/llama-3.3-70b-instruct",
  "mistralai/mistral-large",
];

const AGENT_RESULT = {
  type: "object",
  properties: {
    simulated: { type: "boolean" },
    model: { type: "string" },
    text: { type: "string" },
    note: { type: "string" },
    promptWords: { type: "number" },
    fingerprint: { type: "string" },
    temperature: { type: "number" },
  },
  required: ["simulated", "model", "text", "note", "promptWords", "fingerprint", "temperature"],
} as const;

const AGGREGATE_RESULT = {
  type: "object",
  properties: {
    operation: { type: "string" },
    key: { type: "string" },
    count: { type: "number" },
    value: { type: ["number", "string"] },
    ok: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["operation", "key", "count", "value", "ok", "reason"],
} as const;

const DATE_RESULT = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    reason: { type: "string" },
    iso: { type: "string" },
    formatted: { type: "string" },
    epochMs: { type: "number" },
  },
  required: ["ok", "reason", "iso", "formatted", "epochMs"],
} as const;

const JSON_RESULT = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    reason: { type: "string" },
    data: { type: "object", additionalProperties: true },
  },
  required: ["ok", "reason", "data"],
} as const;

const COMMON: ExampleRegistry = {
  id: "common",
  label: "Everyday steps — 12 library functions + Filesystem (14 real MCP tools)",
  tools: [...FILESYSTEM_TOOLS],
  functions: [
    {
      name: "runAgentStep",
      label: "Agent (offline stand-in — no model is called)",
      description:
        "Asks an LLM — except that nothing here can: the demo runner is given no network of its own, so this is a local stand-in and every answer it returns says so in its own text.",
      icon: "🤖",
      inputSchema: {
        model: { type: "string", enum: AGENT_MODELS },
        system: { type: "string" },
        prompt: { type: "string" },
        temperature: { type: "number" },
        maxTokens: { type: "number" },
      },
      outputSchema: AGENT_RESULT,
      code: `export function runAgentStep(
  model: string,
  system: string,
  prompt: string,
  temperature: number,
  maxTokens: number,
) {
  /*
   * The Agent step — and the one place in this registry where the honest answer
   * is "I cannot do that here".
   *
   * A real agent node calls a model over the network. The demo runner
   * deliberately has none: its worker thread is handed MCP transports and
   * nothing else (apps/demo/server/worker.ts), the dev server's /api/ai proxy is
   * a browser-facing SSE middleware that exists only under \`pnpm dev\` and only
   * with an OPENROUTER_API_KEY, and a library function reaching for a hard-coded
   * localhost URL would stop working the moment anything but this demo ran it.
   *
   * So it does not pretend. It returns a deterministic stand-in whose \`text\`
   * begins by saying no model was called, carries \`simulated: true\` and a
   * \`note\` saying the same thing in words, and echoes the model it *would* have
   * asked. Swapping in a real client is one function body away — everything
   * around it, including the whole config surface, is already real.
   */
  const AGENT_STANDIN_NOTE =
    "No model was called. This Agent step ran CodeFlow's offline stand-in: the demo runner has no network of its own, so the prompt was summarised locally instead of being sent anywhere.";

  const brief = prompt.replace(/\\s+/g, " ").trim();
  const words = brief.length === 0 ? [] : brief.split(" ");

  const keywords = words
    .map((word) => word.replace(/[^A-Za-z0-9]/g, "").toLowerCase())
    .filter((word) => word.length > 4)
    .filter((word, index, all) => all.indexOf(word) === index)
    .slice(0, 6);

  // djb2 over the prompt: a stable id for "this exact question", so two runs of
  // the same flow can be compared the way a real cache key would let them be.
  let digest = 5381;
  for (let index = 0; index < brief.length; index++) {
    digest = ((digest * 33) ^ brief.charCodeAt(index)) >>> 0;
  }

  const budget = Math.max(40, Math.min(Math.round(maxTokens / 4), 400));
  const text = [
    "[SIMULATED — no model was called]",
    \`Would have asked \${model} at temperature \${String(temperature)}, up to \${String(maxTokens)} tokens.\`,
    system.trim().length === 0
      ? "No system prompt was set."
      : \`System prompt accepted (\${String(system.trim().length)} characters) but not sent.\`,
    brief.length === 0
      ? "The prompt was empty, so there was nothing to summarise either."
      : \`Prompt (\${String(words.length)} words): \${brief.slice(0, budget)}\`,
    keywords.length === 0 ? "" : \`Key terms: \${keywords.join(", ")}.\`,
    AGENT_STANDIN_NOTE,
  ]
    .filter((line) => line.length > 0)
    .join("\\n");

  return {
    simulated: true,
    model,
    text,
    note: AGENT_STANDIN_NOTE,
    promptWords: words.length,
    fingerprint: digest.toString(16).padStart(8, "0"),
    temperature,
  };
}`,
      modulePath: LIB,
      editableFields: [
        { name: "model", label: "Model", editor: "select", options: AGENT_MODELS },
        { name: "system", label: "System prompt", editor: "code" },
        { name: "prompt", label: "Prompt", editor: "text" },
        { name: "temperature", label: "Temperature", editor: "text" },
        { name: "maxTokens", label: "Max tokens", editor: "text" },
      ],
    },
    {
      name: "setFields",
      label: "Edit Fields (Set)",
      description: "Build one record out of other values — merged onto the record it was given, or replacing it.",
      icon: "✏️",
      inputSchema: {
        input: RECORD,
        assignments: RECORD,
        mode: { type: "string", enum: ["merge", "replace"] },
      },
      outputSchema: RECORD,
      code: `export function setFields(
  input: Record<string, unknown>,
  assignments: Record<string, unknown>,
  mode: "merge" | "replace",
): Record<string, unknown> {
  /*
   * The step you drag values into.
   *
   * \`assignments\` is written as an object literal in the flow, which is exactly
   * what makes it a drop target: each property is one field of the record being
   * built, and its value is an ordinary TypeScript expression — a reference to
   * an earlier step's result, a literal, a template. A property whose value is
   * \`undefined\` is skipped rather than written, so an optional field that was
   * never produced does not appear as an explicit hole.
   */
  const out: Record<string, unknown> = mode === "replace" ? {} : { ...input };
  for (const [key, value] of Object.entries(assignments)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}`,
      modulePath: LIB,
      editableFields: [
        { name: "input", label: "Record to start from", editor: "expression" },
        { name: "assignments", label: "Fields to set", editor: "code" },
        { name: "mode", label: "Mode", editor: "select", options: ["merge", "replace"] },
      ],
    },
    {
      name: "filterRecords",
      label: "Filter",
      description: "Keep the records a condition is true for; the condition is an ordinary TypeScript expression.",
      icon: "🔎",
      inputSchema: {
        records: RECORD_LIST,
        predicate: "(record: Record<string, unknown>) => boolean",
      },
      outputSchema: RECORD_LIST,
      code: `export function filterRecords(
  records: Record<string, unknown>[],
  predicate: (record: Record<string, unknown>) => boolean,
): Record<string, unknown>[] {
  /*
   * Filter, with the condition as a real expression rather than a
   * field/operator/value form.
   *
   * That is principle 7 ("no second expression language") taken literally: the
   * inspector's expression editor edits the arrow function that is already in
   * the source, so what the user reads and what runs are the same text.
   *
   * A predicate that throws is a bug in the condition, not in the data, so it is
   * left to propagate — swallowing it would silently drop records.
   */
  const kept: Record<string, unknown>[] = [];
  for (const record of records) {
    if (predicate(record) === true) kept.push(record);
  }
  return kept;
}`,
      modulePath: LIB,
      editableFields: [
        { name: "records", label: "Records", editor: "expression" },
        { name: "predicate", label: "Condition", editor: "expression" },
      ],
    },
    {
      name: "sortRecords",
      label: "Sort",
      description: "Order records by one key, ascending or descending. Stable: equal keys keep their original order.",
      icon: "🔀",
      inputSchema: {
        records: RECORD_LIST,
        key: { type: "string" },
        direction: { type: "string", enum: ["ascending", "descending"] },
      },
      outputSchema: RECORD_LIST,
      code: `export function sortRecords(
  records: Record<string, unknown>[],
  key: string,
  direction: "ascending" | "descending",
): Record<string, unknown>[] {
  /*
   * Sort by one key.
   *
   * Two numbers compare as numbers; anything else compares as its string form,
   * so a mixed column still produces one defined order instead of an
   * engine-defined one. The original index breaks ties, which makes the sort
   * stable by construction rather than by trusting the engine, and makes the
   * result reproducible across runs.
   */
  const sign = direction === "descending" ? -1 : 1;
  return records
    .map((record, index) => ({ record, index }))
    .sort((left, right) => {
      const a = left.record[key];
      const b = right.record[key];
      if (typeof a === "number" && typeof b === "number") {
        if (a === b) return left.index - right.index;
        return a < b ? -sign : sign;
      }
      const at = a === undefined || a === null ? "" : String(a);
      const bt = b === undefined || b === null ? "" : String(b);
      if (at === bt) return left.index - right.index;
      return at < bt ? -sign : sign;
    })
    .map((entry) => entry.record);
}`,
      modulePath: LIB,
      editableFields: [
        { name: "records", label: "Records", editor: "expression" },
        { name: "key", label: "Sort by", editor: "text" },
        { name: "direction", label: "Direction", editor: "select", options: ["ascending", "descending"] },
      ],
    },
    {
      name: "limitRecords",
      label: "Limit",
      description: "Keep the first or the last N records.",
      icon: "✂️",
      inputSchema: {
        records: RECORD_LIST,
        count: { type: "number" },
        keep: { type: "string", enum: ["first", "last"] },
      },
      outputSchema: RECORD_LIST,
      code: `export function limitRecords(
  records: Record<string, unknown>[],
  count: number,
  keep: "first" | "last",
): Record<string, unknown>[] {
  /*
   * Keep the first or last N records.
   *
   * A negative or fractional count is floored to a whole number of records
   * rather than refused: "keep 2.5 rows" has one sensible reading, and \`slice\`
   * would otherwise read a negative number as counting from the end, which is
   * the opposite of what was asked. A count at or above the input size returns a
   * copy, never the same array, so a later step cannot mutate the caller's list.
   */
  const size = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (size >= records.length) return records.slice();
  return keep === "last" ? records.slice(records.length - size) : records.slice(0, size);
}`,
      modulePath: LIB,
      editableFields: [
        { name: "records", label: "Records", editor: "expression" },
        { name: "count", label: "Keep how many", editor: "text" },
        { name: "keep", label: "From", editor: "select", options: ["first", "last"] },
      ],
    },
    {
      name: "dedupeRecords",
      label: "Remove Duplicates",
      description: "Keep the first record for each distinct value of one key.",
      icon: "🧊",
      inputSchema: { records: RECORD_LIST, key: { type: "string" } },
      outputSchema: RECORD_LIST,
      code: `export function dedupeRecords(
  records: Record<string, unknown>[],
  key: string,
): Record<string, unknown>[] {
  /*
   * First one wins.
   *
   * Identity is \`JSON.stringify\` of the key's value, so \`1\` and \`"1"\` are
   * different records (they are) while two structurally equal objects are the
   * same one (they are). A record that has no value at all under the key is
   * treated as one distinct group rather than as many, which is the reading that
   * actually de-duplicates a column with holes in it.
   */
  const seen = new Set<string>();
  const kept: Record<string, unknown>[] = [];
  for (const record of records) {
    const value = record[key];
    const identity = value === undefined ? "\\u0000missing" : JSON.stringify(value);
    if (seen.has(identity)) continue;
    seen.add(identity);
    kept.push(record);
  }
  return kept;
}`,
      modulePath: LIB,
      editableFields: [
        { name: "records", label: "Records", editor: "expression" },
        { name: "key", label: "Compare on", editor: "text" },
      ],
    },
    {
      name: "splitOutField",
      label: "Split Out",
      description: "Turn one field of each record into records of its own — the array field becomes the list.",
      icon: "🍴",
      inputSchema: { records: RECORD_LIST, field: { type: "string" } },
      outputSchema: RECORD_LIST,
      code: `export function splitOutField(
  records: Record<string, unknown>[],
  field: string,
): Record<string, unknown>[] {
  /*
   * One field, spread out into the list.
   *
   * Each record's \`field\` is read: an array contributes one output record per
   * element, a single value contributes one, and a missing field contributes
   * none. An element that is already an object is passed through as the record
   * itself — that is the case that matters, because it is how a document like
   * \`{ orders: [...] }\` becomes a list of orders. A scalar element is wrapped
   * as \`{ <field>: value }\` so every output is still a record and the next step
   * in the chain does not have to care which shape it came from.
   */
  const out: Record<string, unknown>[] = [];
  for (const record of records) {
    const value = record[field];
    const entries = Array.isArray(value) ? value : value === undefined ? [] : [value];
    for (const entry of entries) {
      if (typeof entry === "object" && entry !== null && !Array.isArray(entry)) {
        out.push(entry as Record<string, unknown>);
      } else {
        out.push({ [field]: entry });
      }
    }
  }
  return out;
}`,
      modulePath: LIB,
      editableFields: [
        { name: "records", label: "Records", editor: "expression" },
        { name: "field", label: "Field to split out", editor: "text" },
      ],
    },
    {
      name: "aggregateRecords",
      label: "Aggregate",
      description: "Fold a list of records into one number or one string: count, sum, min, max or join.",
      icon: "🧮",
      inputSchema: {
        records: RECORD_LIST,
        key: { type: "string" },
        operation: { type: "string", enum: ["count", "sum", "min", "max", "join"] },
      },
      outputSchema: AGGREGATE_RESULT,
      code: `export function aggregateRecords(
  records: Record<string, unknown>[],
  key: string,
  operation: "count" | "sum" | "min" | "max" | "join",
): { operation: string; key: string; count: number; value: number | string; ok: boolean; reason: string } {
  /*
   * Fold a column.
   *
   * \`count\` and \`join\` work on whatever is there; \`sum\`, \`min\` and \`max\` need
   * numbers, and say so instead of answering 0 when there are none — a zero
   * meaning "nothing to add" is indistinguishable from a zero meaning "the total
   * is zero", and a report cannot tell those apart after the fact. Missing and
   * null values are excluded before anything is computed, so \`count\` answers how
   * many records actually carry the key.
   */
  const present = records.filter((record) => record[key] !== undefined && record[key] !== null);

  if (operation === "count") {
    return { operation, key, count: present.length, value: present.length, ok: true, reason: "" };
  }
  if (operation === "join") {
    const joined = present.map((record) => String(record[key])).join(", ");
    return { operation, key, count: present.length, value: joined, ok: true, reason: "" };
  }

  const numbers = present
    .map((record) => Number(record[key]))
    .filter((value) => Number.isFinite(value));
  if (numbers.length === 0) {
    return {
      operation,
      key,
      count: 0,
      value: 0,
      ok: false,
      reason: \`nothing to \${operation}: none of the \${String(records.length)} record(s) carry a numeric "\${key}"\`,
    };
  }
  if (operation === "sum") {
    const total = numbers.reduce((carried, value) => carried + value, 0);
    return { operation, key, count: numbers.length, value: total, ok: true, reason: "" };
  }
  const value = operation === "min" ? Math.min(...numbers) : Math.max(...numbers);
  return { operation, key, count: numbers.length, value, ok: true, reason: "" };
}`,
      modulePath: LIB,
      editableFields: [
        { name: "records", label: "Records", editor: "expression" },
        { name: "key", label: "Field", editor: "text" },
        {
          name: "operation",
          label: "Operation",
          editor: "select",
          options: ["count", "sum", "min", "max", "join"],
        },
      ],
    },
    {
      name: "formatText",
      label: "Format Text",
      description: "Fill {{ placeholders }} in a template from a map of values.",
      icon: "🔤",
      inputSchema: { template: { type: "string" }, values: RECORD },
      outputSchema: { type: "string" },
      code: `export function formatText(template: string, values: Record<string, unknown>): string {
  /*
   * A template with named holes.
   *
   * The syntax is the same \`{{ name }}\` the inspector shows for a TypeScript
   * template literal, which is deliberate: a user who has seen
   * \`Hello {{ user.name }}\` in the expression editor already knows how to write
   * this one. The difference is where the substitution happens — the inspector's
   * \`{{ }}\` is the display form of a template-literal interpolation and is
   * filled by the language, while these are filled here, at run time, from
   * \`values\`.
   *
   * A placeholder with no matching value is left standing rather than blanked,
   * so a missing value shows up in the output as the name of the thing that was
   * missing instead of as a silent gap.
   */
  return template.replace(/\\{\\{\\s*([A-Za-z_$][A-Za-z0-9_$]*)\\s*\\}\\}/g, (whole, name: string) => {
    if (!Object.prototype.hasOwnProperty.call(values, name)) return whole;
    const value = values[name];
    if (value === undefined) return whole;
    if (value === null) return "";
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}`,
      modulePath: LIB,
      editableFields: [
        { name: "template", label: "Template", editor: "text" },
        { name: "values", label: "Values", editor: "expression" },
      ],
    },
    {
      name: "dateTimeStep",
      label: "Date & Time",
      description: "Shift or format an ISO timestamp — and say so plainly when the input is not a date.",
      icon: "📅",
      inputSchema: {
        timestamp: { type: "string" },
        operation: { type: "string", enum: ["add", "subtract", "startOf", "format"] },
        amount: { type: "number" },
        unit: { type: "string", enum: ["seconds", "minutes", "hours", "days", "weeks"] },
      },
      outputSchema: DATE_RESULT,
      code: `export function dateTimeStep(
  timestamp: string,
  operation: "add" | "subtract" | "startOf" | "format",
  amount: number,
  unit: "seconds" | "minutes" | "hours" | "days" | "weeks",
): { ok: boolean; reason: string; iso: string; formatted: string; epochMs: number } {
  /*
   * Add to, subtract from, truncate or simply format a timestamp — always in
   * UTC, so the same flow run on two machines produces the same string.
   *
   * A timestamp the platform cannot read comes back as \`ok: false\` carrying the
   * value it choked on, because the alternative is an "Invalid Date" that
   * travels three steps downstream before anyone notices. \`startOf\` truncates
   * to a whole number of the chosen unit since the Unix epoch, which is exact
   * for seconds through days; a "week" so defined starts on Thursday, the day
   * the epoch fell on.
   */
  const DATE_STEP_MS: Record<string, number> = {
    seconds: 1000,
    minutes: 60000,
    hours: 3600000,
    days: 86400000,
    weeks: 604800000,
  };

  const step = Object.prototype.hasOwnProperty.call(DATE_STEP_MS, unit) ? DATE_STEP_MS[unit] : 0;
  if (step === 0) {
    return {
      ok: false,
      reason: \`"\${String(unit)}" is not a unit this step knows — use seconds, minutes, hours, days or weeks.\`,
      iso: "",
      formatted: "",
      epochMs: 0,
    };
  }

  const epoch = new Date(timestamp).getTime();
  if (!Number.isFinite(epoch)) {
    return {
      ok: false,
      reason: \`"\${timestamp}" is not a timestamp this step can read — give it an ISO 8601 value such as 2026-01-31T09:00:00Z.\`,
      iso: "",
      formatted: "",
      epochMs: 0,
    };
  }

  const whole = Number.isFinite(amount) ? Math.round(amount) : 0;
  let shifted = epoch;
  if (operation === "add") shifted = epoch + whole * step;
  if (operation === "subtract") shifted = epoch - whole * step;
  if (operation === "startOf") shifted = Math.floor(epoch / step) * step;

  const iso = new Date(shifted).toISOString();
  return {
    ok: true,
    reason: "",
    iso,
    formatted: \`\${iso.slice(0, 10)} \${iso.slice(11, 19)} UTC\`,
    epochMs: shifted,
  };
}`,
      modulePath: LIB,
      editableFields: [
        { name: "timestamp", label: "Timestamp", editor: "text" },
        {
          name: "operation",
          label: "Operation",
          editor: "select",
          options: ["add", "subtract", "startOf", "format"],
        },
        { name: "amount", label: "Amount", editor: "text" },
        {
          name: "unit",
          label: "Unit",
          editor: "select",
          options: ["seconds", "minutes", "hours", "days", "weeks"],
        },
      ],
    },
    {
      name: "waitMs",
      label: "Wait",
      description: "Pause for a number of milliseconds, capped so a mistyped delay cannot hang a demo run.",
      icon: "⏳",
      inputSchema: { ms: { type: "number" } },
      outputSchema: "Promise<{ requestedMs: number; waitedMs: number; clamped: boolean }>",
      code: `export async function waitMs(
  ms: number,
): Promise<{ requestedMs: number; waitedMs: number; clamped: boolean }> {
  /*
   * A delay, and an honest account of it.
   *
   * The cap is not decoration: this runs inside the demo's worker thread, and a
   * flow asking for a five-minute pause between iterations looks exactly like a
   * hung run. So the wait is clamped to two seconds — longer than any pause a
   * demo needs, short enough that a mistyped delay is a curiosity rather than a
   * dead session — and the result reports both numbers plus \`clamped\`, which is
   * what lets the canvas say "waited 2000 of 300000 ms" instead of quietly doing
   * something other than what the node says.
   */
  const requestedMs = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
  const waitedMs = Math.min(requestedMs, 2000);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, waitedMs);
  });
  return { requestedMs, waitedMs, clamped: waitedMs !== requestedMs };
}`,
      modulePath: LIB,
      editableFields: [{ name: "ms", label: "Wait (ms)", editor: "text" }],
    },
    {
      name: "extractJson",
      label: "Extract JSON",
      description: "Parse a string into an object — and report why, in the parser's own words, when it is not one.",
      icon: "📥",
      inputSchema: { raw: { type: "string" } },
      outputSchema: JSON_RESULT,
      code: `export function extractJson(
  raw: string,
): { ok: boolean; reason: string; data: Record<string, unknown> } {
  /*
   * Parse, or say why not.
   *
   * Three different failures are worth telling apart and all three are kept:
   * nothing to parse, invalid JSON (reported with the engine's own message,
   * which names the offset), and valid JSON that is not an object — an array or
   * a bare number is perfectly good JSON and still cannot be treated as a
   * record. None of them throws, because the caller's next line is almost always
   * a guard, and none of them hands back a plausible-looking empty object as
   * though it had worked: \`data\` is only meaningful when \`ok\` is true.
   */
  const text = raw.trim();
  if (text.length === 0) {
    return { ok: false, reason: "there was nothing to parse — the input was empty", data: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, reason: \`not valid JSON — \${message}\`, data: {} };
  }

  if (Array.isArray(parsed)) {
    return {
      ok: false,
      reason: \`parsed, but the top-level value is an array of \${String(parsed.length)} item(s), not an object\`,
      data: {},
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      reason: \`parsed, but the top-level value is \${parsed === null ? "null" : typeof parsed}, not an object\`,
      data: {},
    };
  }

  return { ok: true, reason: "", data: parsed as Record<string, unknown> };
}`,
      modulePath: LIB,
      editableFields: [{ name: "raw", label: "JSON text", editor: "expression" }],
    },
  ],
};

export const REGISTRIES: Record<string, ExampleRegistry> = {
  [SAMPLE.id]: SAMPLE,
  [COMMON.id]: COMMON,
  [REPO_TRIAGE.id]: REPO_TRIAGE,
  [RESEARCH.id]: RESEARCH,
  [BROWSER_QA.id]: BROWSER_QA,
  [PIPELINE.id]: PIPELINE,
};
