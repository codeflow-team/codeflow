/**
 * The gallery.
 *
 * Four of these are the flows the demo app shipped with — the specs' canonical
 * example and its three companions, carried over unchanged apart from one type
 * annotation. Seven more are written against tool schemas captured from real MCP
 * servers: `@modelcontextprotocol/server-filesystem`, `server-memory`,
 * `server-everything`, `@playwright/mcp`, DuckDuckGo, DeepWiki, Context7 and
 * sequential-thinking. The last two are built out of the `common` registry's
 * everyday library steps, which is what a node editor spends most of its time
 * configuring. Nothing is padded: every one is a scenario somebody would
 * actually automate, and the hard cases are hard because that is what the
 * scenario needs, not because a test wanted them.
 *
 * `source` comes from `flows/*.flow.ts` via `scripts/embed-flows.mjs`, so the
 * code in the gallery is the code in the repository, byte for byte.
 */

import type { FlowExample } from "./types.js";
import { SOURCES } from "./generated/sources.js";

/** A trailing newline is not a line. */
function countLines(source: string): number {
  return source.replace(/\n$/, "").split("\n").length;
}

type ExampleSeed = Omit<FlowExample, "source" | "lines">;

const SEEDS: ExampleSeed[] = [
  /* ------------------------------ basics ------------------------------ */
  {
    id: "canonical",
    title: "Security PR watcher",
    category: "basics",
    summary: "Watches a repository for pull requests that touch authentication code.",
    description:
      "Pulls the new pull requests on a repository, opens each one's changed files, and pings the security channel whenever a change lands in authentication code. This is the shape every other flow here is built from: one step per line, results named as they are produced. It is also the example the specs use end to end, so the graph it produces is the one everything else is measured against.",
    highlights: [
      "one tool call per statement — the flow contract in its plainest form",
      "`files.some(isAuthChange)` takes its node label from the function library",
      "the condition ends the loop body, so no merge node is invented",
      "template literal in an argument, rendered as {{ pr.title }} in the inspector",
    ],
    registryId: "sample",
  },
  {
    id: "code-nodes",
    title: "Daily digest",
    category: "basics",
    summary: "Posts a daily digest of open pull requests, formatted by a local helper.",
    description:
      "Fetches the day's pull requests, formats them with a helper declared in the same file, counts the long-titled ones inline, and posts the result to Slack. It exists to show the two kinds of opaque region CodeFlow keeps verbatim — a local function and a plain expression — and that both are editable without leaving the canvas.",
    highlights: [
      "local function call becomes a function node; its body stays opaque",
      "an inline `.filter().length` becomes a code node, kept verbatim",
      "both opaque regions are replaceable through one `$code` patch",
    ],
    registryId: "sample",
  },

  {
    id: "everyday-order-digest",
    title: "Order digest",
    category: "basics",
    summary: "Reads a JSON document off disk and writes back a one-paragraph digest of the orders in it.",
    description:
      "Parses an orders document, pulls the order list out of it, keeps the ones in the status the caller asked about, ranks them by value and writes a short digest back to the repository. Seven of the everyday library steps in under seventy lines, one per statement, with no control flow beyond two guards — the flow to open first when the question is what a node in the editor actually configures.",
    highlights: [
      "seven library steps in a row: parse, split out, filter, sort, limit, aggregate, format",
      "`extractJson` fails honestly — a file that is not JSON returns a reason, not a zero",
      "`filterRecords` takes the condition as a real TypeScript arrow, edited in the expression editor",
      "`formatText` fills `{{ count }}` / `{{ revenue }}` from an object literal — the drag-and-drop target",
      "two early returns, one per way the input can be unusable",
    ],
    registryId: "common",
  },

  /* --------------------------- control-flow --------------------------- */
  {
    id: "ticket-triage-agent",
    title: "Support ticket triage",
    category: "control-flow",
    summary: "Triages a support queue one ticket at a time, with an agent step inside the loop.",
    description:
      "Prepares a queue once — parse, split out, de-duplicate, sort, cap — and then walks it, giving every ticket its own due date, its own prompt and its own agent answer before folding the result back onto the record. The per-iteration shape is the point: this is what the canvas has to show once per pass rather than once. The agent calls no model; it is CodeFlow's offline stand-in, and every answer says so in its own first line.",
    highlights: [
      "a `for…of` loop whose body is four configured steps, one agent call per ticket",
      "`runAgentStep` is a labelled stand-in — `simulated: true` travels with every record",
      "`formatText` builds the prompt per ticket, which is where a value gets dragged in",
      "`setFields` folds the verdict, the model and the due date back onto the ticket",
      "`dateTimeStep` returns `ok: false` on an unreadable timestamp, and the loop `continue`s",
      "collecting is a named local function, so the step stays on the canvas",
      "a template literal in the `content` argument, shown as `{{ triaged.length }}` in the inspector",
      "try/catch around the write only, with its own early return",
    ],
    registryId: "common",
  },
  {
    id: "try-catch",
    title: "Card charge with fallback",
    category: "control-flow",
    summary: "Charges a card, returns early when it is pending, and alerts on failure.",
    description:
      "Attempts a payment, hands a pending charge straight back to the caller, and drops a message in the alerts channel if the charge throws. Small on purpose: it is the smallest flow that has a try node, an error branch, an early return and a final return all at once.",
    highlights: [
      "early `return` inside a try body becomes its own output node",
      "`catch` is a second subgraph joined by the `error` edge",
      "two output nodes — the early return and the tail return",
    ],
    registryId: "sample",
  },

  /* ------------------------------ real MCP ---------------------------- */
  {
    id: "memory-graph-sync",
    title: "Knowledge graph sync",
    category: "real-mcp",
    summary: "Keeps the memory server's picture of a codebase in step with the files on disk.",
    description:
      "Searches the knowledge graph for what it already knows about a package, walks the source tree with the filesystem server, and reconciles the two: new modules become entities linked to their package, known ones get a fresh observation, and modules that no longer exist are pruned when pruning is switched on. Short enough to read end to end, and every call is a real MCP tool.",
    highlights: [
      "filesystem + memory MCP, 23 real tool schemas in the registry",
      "if / else-if routing between create, refresh and prune",
      "try/catch around each file read — one unreadable file is not a failed run",
      "three early returns, one per outcome the caller cares about",
    ],
    registryId: "repo-triage",
  },
  {
    id: "doc-freshness-audit",
    title: "Docs freshness audit",
    category: "real-mcp",
    summary: "Compares every dependency's checked-in guide against its upstream documentation.",
    description:
      "Reads the dependency manifest, asks Context7 and DeepWiki for the upstream docs, and diffs the headings against the guide committed next to the code. Drift is reported, missing guides are listed, and the whole verdict is filed both as a markdown report and as an entity in the knowledge graph. The doc servers declare no output schema, so the comparison deliberately happens on files the filesystem server can hand back.",
    highlights: [
      "four MCP servers in one flow: Context7, DeepWiki, memory, filesystem",
      "`Promise.all` over three filesystem reads with an array literal",
      "else-if chain routing on how far the docs have drifted",
      "`.find()` on the stat output stays a code node — honest about what it is",
    ],
    registryId: "research",
  },

  /* ------------------------------- stress ----------------------------- */
  {
    id: "repo-triage-bot",
    title: "Repository triage bot",
    category: "stress",
    summary: "Scans every allowed root, scores each source file for risk, and files a report.",
    description:
      "Asks the filesystem server what it is allowed to read, walks each root down to individual files, scores every source file against the triage heuristics, and records what it learns in the knowledge graph as it goes. High-risk files become their own entities linked back to the repository; the run ends with a markdown report written back to the repo and a JSON sidecar for whatever reads it next. It is deliberately unforgiving code: one unreadable file must not lose a whole root, and one failed write must not lose the whole scan.",
    highlights: [
      "three nested `for...of` loops inside one outer try",
      "`try` inside a loop inside a loop inside a loop inside a `try`",
      "labelled `continue outer` from inside a catch, and a labelled `break outer`",
      "`finally` reached both from the loop's exit and from the catch's early return",
      "`Promise.all` with four array-literal branches, then a renamed destructure",
      "a `const entries` inside the loop shadowing the flow-scope `entries`",
      "nested destructuring `{ results: [{ entityName: escalated }] }`",
      "`let` written from four places — declaration plus three branches",
      "bounded `while` retry around the report write, with an else branch",
      "five early returns, one per outcome",
      "library functions (`isSourcePath`, `scoreRisk`, `renderTriageReport`) reused across the flow",
    ],
    registryId: "repo-triage",
  },
  {
    id: "research-agent",
    title: "Research agent",
    category: "stress",
    summary: "Plans queries, harvests and ranks sources, reasons over them, and files a brief.",
    description:
      "Expands one topic into a set of queries, runs each through DuckDuckGo with a bounded retry, ranks what came back, and reads the promising sources through DeepWiki and Context7. It then hands the material to the sequential-thinking server and keeps stepping until that server says it is done — or until the step ceiling is reached, whichever comes first. The brief it writes is filed on disk and in the knowledge graph.",
    highlights: [
      "five MCP servers in one registry: DuckDuckGo, DeepWiki, Context7, sequential-thinking, memory (plus filesystem)",
      "bounded `while` retry nested inside a labelled `for` loop",
      "`continue queryLoop` from inside a catch two levels down",
      "`Promise.all` with four branches, one per server",
      "a second bounded `while` driven by the reasoning server's own answer",
      "`let` writers in the loop body, the catch and the retry",
      "three early returns before any work is committed",
      "template literals with three and four interpolations in tool arguments",
    ],
    registryId: "research",
  },
  {
    id: "browser-qa-runner",
    title: "Browser QA runner",
    category: "stress",
    summary: "Runs a checked-in browser test plan and always leaves behind evidence.",
    description:
      "Reads a test plan out of the repository and walks every case through a real browser: navigate, wait for the shell, then each step with one retry, capturing a snapshot, the console and the network log along the way. Playwright's tools answer by writing files rather than returning values, so every assertion reads its evidence back through the filesystem server. However the run ends — clean, failed, or blown up — the browser is closed and a JUnit report is written.",
    highlights: [
      "Playwright's 24 real tools plus the filesystem server, 38 tools in one registry",
      "outer `try/catch/finally` whose finally is the cleanup the run depends on",
      "`try/catch/finally` per step, inside a retry loop, inside the step loop, inside the case loop",
      "labelled `break caseLoop` from the top of the loop, and `continue caseLoop` from a catch",
      "bounded `while` polling for the app shell",
      "`Promise.all` with four filesystem branches, then a renamed destructure",
      "five-way if / else-if chain dispatching on the step's action",
      "`let` written from the declaration, the catch and three branches",
      "code nodes between tool nodes, threading control and data through",
    ],
    registryId: "browser-qa",
  },
  {
    id: "data-pipeline",
    title: "Regional sales pipeline",
    category: "stress",
    summary: "Folds a drop folder of CSV files into per-region totals, enriched and published.",
    description:
      "Reads every drop file in an inbox, normalises the rows it can and quarantines the ones it cannot, and folds the survivors into per-region totals. Each region is then enriched with live conditions from the reference server and the ledger is published with a bounded retry. The fold in the middle is ordinary TypeScript and stays one code node — which is the honest thing for it to be.",
    highlights: [
      "filesystem + everything server, 27 real tool schemas",
      "labelled `break dropLoop` from the inner row loop",
      "`try/catch` around the read, with `continue dropLoop` from both branches",
      "`Promise.all` with four branches — three enrichments and the previous ledger",
      "three destructures with renames off one parallel merge",
      "object destructuring of a library function's result (`{ headers, rows }`)",
      "a deliberate code node for the fold — five nodes here would be a lie",
      "bounded `while` around publishing, with a recovery branch in the catch",
    ],
    registryId: "pipeline",
  },

  /* ---------------------------- degradation --------------------------- */
  {
    id: "demo-degradation",
    title: "Unknown, code and hidden call",
    category: "degradation",
    summary: "The three degradations a reader meets first, in twenty lines.",
    description:
      "A tool nobody registered, a chained expression with no projection rule, and a tool call hidden inside an `if` condition. Each one produces a node that says what it is plus a diagnostic that says why, and none of them is quietly turned into something prettier.",
    highlights: [
      "unresolved tool → unknown node + error diagnostic",
      "hidden call in a condition → the whole statement degrades",
      "a `while` with no visible bound → warning, not a refusal",
    ],
    registryId: "sample",
  },
  {
    id: "degradation-showcase",
    title: "Every way of saying “I don’t know”",
    category: "degradation",
    summary: "Thirteen statements, each tripping exactly one degradation rule.",
    description:
      "Every construct CodeFlow deliberately refuses to guess at, gathered in one file: unregistered tools, optional chaining on tools, a call hidden in a condition, `Promise.all` over a `.map()`, hoisted promises, a classic `for`, `do…while`, `switch`, an unbounded `while`, a call two callbacks deep and a computed tool path. The point is not that these fail — it is that each one produces a node the reader can see and a diagnostic that names the fix.",
    highlights: [
      "two unresolved tools — one method, one whole namespace",
      "`tools.fs?.readTextFile?.()` → unsupported-optional-chaining",
      "a tool call inside an `if` condition → hidden-call-in-expression",
      "`Promise.all(roots.map(...))` and hoisted promises both degrade, never fake a parallel node",
      "classic `for (;;)`, `do…while` and `switch` kept verbatim",
      "`while (pending)` with no recognisable bound → unbounded-loop-risk",
      "`tools[\"fs\"].createDirectory` is not resolved — a computed key has no static answer",
    ],
    registryId: "repo-triage",
  },
];

export const EXAMPLES: FlowExample[] = SEEDS.map((seed) => {
  const source = SOURCES[seed.id];
  if (source === undefined) {
    throw new Error(
      `No source embedded for example "${seed.id}" — add flows/${seed.id}.flow.ts and run \`pnpm --filter @codeflow-team/examples embed\`.`,
    );
  }
  return { ...seed, lines: countLines(source), source };
});
