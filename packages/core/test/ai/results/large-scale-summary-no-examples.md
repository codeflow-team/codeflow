# Large-scale AI conformance — stealth/ox-alpha

Feature-sized briefs (150–400 lines expected) against scoped registries of real MCP tools. Eval version 1. `max_tokens` 48000, target L2, max 2 retries, few-shot examples **off**.

Ran 2026-08-23T06:15:51.301Z · 7 generations.

First round is what a host gets from one generation; final is what the retry loop of
10 §5 gets after feeding diagnostics back.

| Level | First round | Final | Final rate |
| --- | --- | --- | --- |
| L0 (parses + contract) | 7/7 | 7/7 | 100% |
| L1 (everything resolves) | 7/7 | 7/7 | 100% |
| L2 (maps cleanly) | 6/7 | 7/7 | 100% |

## Per generation

| Intent | Tools | Lines (target) | Nodes | Edges | Code nodes | Meaningful | Nesting | First → final | Retries | Time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| data-migration | 23 | 246 (190) | 52 | 132 | 10 | 81% | 4 | L2 → L2 | 0 | 214s |
| knowledge-base-sync | 27 | 337 (170) | 59 | 126 | 14 | 76% | 4 | L1 → L2 | 1 | 453s |
| dependency-audit | 18 | 483 (160) | 65 | 142 | 9 | 86% | 4 | L2 → L2 | 0 | 666s |
| repo-triage-bot | 23 | 312 (180) | 61 | 138 | 6 | 90% | 4 | L2 → L2 | 0 | 264s |
| research-pipeline | 28 | 227 (200) | 41 | 86 | 5 | 88% | 2 | L2 → L2 | 0 | 476s |
| browser-qa-suite | 38 | 153 (220) | 35 | 75 | 4 | 89% | 6 | L2 → L2 | 0 | 363s |
| incident-responder | 28 | 363 (170) | 60 | 162 | 10 | 83% | 3 | L2 → L2 | 0 | 692s |

## Construct coverage

45/49 of the constructs the briefs required were projected to the graph (92%).

| Construct asked for | Times missing |
| --- | --- |
| else-if-chain | 2 |
| nested-loop | 1 |
| early-return | 1 |

## Diagnostics over every round

| Diagnostic | Count |
| --- | --- |
| `info/unsupported-construct` | 73 |
| `warning/inline-logic-in-code-node` | 1 |

## Tokens and time

| Intent | Round | Prompt tokens | Completion tokens | Time |
| --- | --- | --- | --- | --- |
| data-migration | 0 | 3532 | 10388 | 214s |
| knowledge-base-sync | 0 | 4314 | 14222 | 379s |
| knowledge-base-sync | 1 | 6912 | 3855 | 73s |
| dependency-audit | 0 | 4472 | 23111 | 666s |
| repo-triage-bot | 0 | 3632 | 9254 | 264s |
| research-pipeline | 0 | 5111 | 16326 | 476s |
| browser-qa-suite | 0 | 4138 | 15277 | 363s |
| incident-responder | 0 | 4404 | 23733 | 691s |

## data-migration

Servers: filesystem, memory · 23 tools · system prompt ≈ 3427 tokens.

Tools actually called: `filesystem.createDirectory`, `filesystem.readMultipleFiles`, `filesystem.searchFiles`, `filesystem.writeFile`, `memory.createEntities`

### round 0 → L2 · 246 lines · 52 nodes (214s)

Node types: function×15, code×10, tool×7, condition×5, merge×4, loop×3, jump×3, output×2, try×2, trigger×1

Covered: condition, early-return, else-if-chain, function, jump, loop, nested-loop, try

Diagnostics:

- `info/unsupported-construct` (line 145) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 175) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 182) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 185) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 192) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 199) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 206) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 225) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 229) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 236) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

interface FlowInput {
  sourceDirectory: string;
  destinationDirectory: string;
  batchSize: number;
  maxFailures: number;
}

interface NoteEntry {
  path: string;
  text: string;
}

interface FailureRecord {
  path: string;
  reason: string;
}

function baseNameOf(sourcePath: string): string {
  const fileName = sourcePath.split("/").pop() ?? sourcePath;
  return fileName.replace(/\.[^.]+$/, "");
}

function destinationPathFor(sourcePath: string, destinationDirectory: string): string {
  return `${destinationDirectory}/${baseNameOf(sourcePath)}.md`;
}

function noteEntityName(sourcePath: string): string {
  return baseNameOf(sourcePath);
}

function reportPathFor(destinationDirectory: string): string {
  return `${destinationDirectory}/migration-report.md`;
}

function parseSearchResults(content: string): string[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function chunk<T>(items: T[], size: number): T[][] {
  const safeSize = Math.max(1, size);
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += safeSize) {
    const batch = items.slice(index, index + safeSize);
    batches.push(batch);
  }
  return batches;
}

// readMultipleFiles returns the whole batch as one string; each file is
// expected as a "<path>:" header line followed by its content lines.
function parseBatchContent(content: string): NoteEntry[] {
  const entries: NoteEntry[] = [];
  let currentPath = "";
  let currentLines: string[] = [];
  let inSection = false;

  const flush = () => {
    if (inSection) {
      const text = currentLines.join("\n").trim();
      entries.push({ path: currentPath, text });
    }
  };

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.endsWith(":") && line.includes("/")) {
      flush();
      currentPath = line.slice(0, -1).trim();
      currentLines = [];
      inSection = true;
    } else if (inSection) {
      currentLines.push(line);
    }
  }
  flush();
  return entries;
}

function findEntry(entries: NoteEntry[], path: string): NoteEntry | null {
  const match = entries.find((entry) => entry.path === path);
  return match ?? null;
}

// Legacy transformation: normalize line endings, strip legacy "NOTE:" markers
// and trailing whitespace.
function transformNote(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/^NOTE:\s*/i, "")
    .replace(/[ \t]+$/gm, "")
    .trim();
}

function isEmptyNote(text: string): boolean {
  return text.replace(/\s/g, "").length === 0;
}

function recordFailure(failures: FailureRecord[], path: string, reason: string): FailureRecord {
  const record = { path, reason };
  failures.push(record);
  return record;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buildReport(
  migrated: number,
  skipped: number,
  failed: number,
  aborted: boolean,
  failures: FailureRecord[]
): string {
  const lines: string[] = [
    "# Migration report",
    "",
    `- Migrated: ${migrated}`,
    `- Skipped (empty after transformation): ${skipped}`,
    `- Failed: ${failed}`,
    `- Aborted: ${aborted ? "yes" : "no"}`,
    "",
    "## Failures",
    "",
  ];
  if (failures.length === 0) {
    lines.push("None.");
  } else {
    for (const failure of failures) {
      lines.push(`- ${failure.path}: ${failure.reason}`);
    }
  }
  return lines.join("\n");
}

export default async function flow(input: FlowInput, tools: Tools) {
  const failures: FailureRecord[] = [];
  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  let aborted = false;

  const reportPath = reportPathFor(input.destinationDirectory);

  // 1. The destination directory must exist before anything is written.
  await tools.filesystem.createDirectory({ path: input.destinationDirectory });

  // 2. Find every note file under the source directory.
  // Note files are markdown; adjust the pattern if legacy notes use another extension.
  const searchResult = await tools.filesystem.searchFiles({
    path: input.sourceDirectory,
    pattern: "**/*.md",
  });
  const notePaths = parseSearchResults(searchResult.content);

  // 3. Nothing to migrate: write an empty report and stop.
  if (notePaths.length === 0) {
    const emptyReport = buildReport(0, 0, 0, false, failures);
    await tools.filesystem.writeFile({ path: reportPath, content: emptyReport });
    return { migrated: 0, skipped: 0, failed: 0, aborted: false };
  }

  // 4. Process the notes in batches.
  const batches = chunk(notePaths, input.batchSize);

  for (const batch of batches) {
    let batchEntries: NoteEntry[] = [];
    let batchReadError = "";

    // Read the whole batch in one go.
    try {
      const batchResult = await tools.filesystem.readMultipleFiles({ paths: batch });
      const parsedBatch = parseBatchContent(batchResult.content);
      batchEntries = parsedBatch;
    } catch (error) {
      const readMessage = describeError(error);
      batchReadError = readMessage;
    }

    if (batchReadError !== "") {
      // The batch read failed as a whole: every note in it is a failure.
      for (const notePath of batch) {
        recordFailure(failures, notePath, batchReadError);
        failed += 1;
      }
    } else {
      for (const notePath of batch) {
        const entry = findEntry(batchEntries, notePath);
        if (entry === null) {
          recordFailure(failures, notePath, "note missing from batch read result");
          failed += 1;
          continue;
        }

        const transformed = transformNote(entry.text);
        if (isEmptyNote(transformed)) {
          // Empty after transformation: skipped, counts as neither success nor failure.
          skipped += 1;
          continue;
        }

        const targetPath = destinationPathFor(notePath, input.destinationDirectory);
        const entityName = noteEntityName(notePath);

        try {
          await tools.filesystem.writeFile({ path: targetPath, content: transformed });
          // 8. Record the migrated note in the knowledge graph.
          await tools.memory.createEntities({
            entities: [
              {
                name: entityName,
                entityType: "note",
                observations: [notePath],
              },
            ],
          });
          migrated += 1;
        } catch (error) {
          const writeMessage = describeError(error);
          recordFailure(failures, notePath, writeMessage);
          failed += 1;
        }
      }
    }

    // 7. Too many failures: abandon the migration immediately.
    if (failed > input.maxFailures) {
      aborted = true;
      break;
    }
  }

  // 9. Write the final report.
  const report = buildReport(migrated, skipped, failed, aborted, failures);
  await tools.filesystem.writeFile({ path: reportPath, content: report });

  return { migrated, skipped, failed, aborted };
}
```

## knowledge-base-sync

Servers: memory, context7, deepwiki, duckduckgo, filesystem · 27 tools · system prompt ≈ 4316 tokens.

Tools actually called: `deepwiki.deepwikiFetch`, `duckduckgo.duckduckgoWebSearch`, `filesystem.writeFile`, `memory.addObservations`, `memory.deleteEntities`, `memory.searchNodes`

### round 0 → L1 · 331 lines · 59 nodes (379s)

Node types: function×19, code×15, tool×6, condition×5, jump×4, merge×4, loop×3, trigger×1, try×1, output×1

Covered: condition, else-if-chain, function, jump, loop, nested-loop, try, while-loop

Diagnostics:

- `info/unsupported-construct` (line 37) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 40) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 57) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 63) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 74) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 76) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 80) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 83) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 85) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 98) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 100) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 107) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 116) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 118) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 120) Custom code is kept verbatim — no semantic projection.
- `warning/inline-logic-in-code-node` (line 74) `hasUsableHit(webHits)` runs inside a custom code node, so the step is invisible on the graph. Give the call its own `const x = await …` statement if it is a tool, or move the logic into a named function and call that (01 §3 rules 4–5).

```ts
import type { Tools } from "../generated/tools";

/**
 * Knowledge-base sync.
 *
 * Per topic: walk the existing knowledge-graph entries in pages (bounded),
 * collect + dedupe node names, then reconcile each node against upstream
 * documentation found on the web: refresh stale observations, delete nodes
 * that vanished upstream, and never let one bad source abort the run.
 * Finishes by writing "sync-log.md" and returning per-topic + grand totals.
 */

// TODO(pagination): memory.searchNodes in the registry has no offset/page
// parameters, so paging is emulated: every iteration re-queries the topic and
// takes the window for the current page index. Pages overlap in practice — the
// dedupe helper absorbs that. Swap in real server-side paging when the
// registry gains a paginated search.

interface GraphEntity {
  name: string;
  entityType: string;
  observations: string[];
}

interface TopicReport {
  topic: string;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
}

export default async function flow(
  input: { topics: string[]; pageSize: number; maxPagesPerTopic: number },
  tools: Tools
) {
  const report: TopicReport[] = [];

  for (const topic of input.topics) {
    const totals: TopicReport = { topic, updated: 0, deleted: 0, skipped: 0, failed: 0 };

    // ---- Walk the existing graph entries, page by page (bounded) --------
    const collectedNames: string[] = [];
    const heldEntities: GraphEntity[] = [];
    let page = 0;
    let reachedLastPage = false;

    while (page < input.maxPagesPerTopic && !reachedLastPage) {
      const matchPage = await tools.memory.searchNodes({ query: topic });

      const entitiesOnPage = pageOf(matchPage.entities, page, input.pageSize);
      const namesOnPage = namesOf(entitiesOnPage);
      recordNames(collectedNames, namesOnPage);
      recordEntities(heldEntities, entitiesOnPage);

      const shortPage = isShortPage(namesOnPage, input.pageSize);
      reachedLastPage = shortPage;
      page += 1;
    }

    // ---- Dedupe before use, and respect the per-topic touch budget ------
    const uniqueNames = dedupeNames(collectedNames);
    const touchBudget = input.maxPagesPerTopic * input.pageSize;
    const budget = capToBudget(uniqueNames, touchBudget);

    // ---- Reconcile each node against upstream ---------------------------
    for (const nodeName of budget) {
      const webHits = await tools.duckduckgo.duckduckgoWebSearch({
        query: `${nodeName} ${topic}`,
        count: 5,
      });

      const upstreamUrl = firstHitUrl(webHits);
      const hasUpstream = hasUsableHit(webHits) && upstreamUrl.length > 0;
      if (!hasUpstream) {
        totals.skipped += 1;
        continue;
      }

      let upstreamDoc: unknown = undefined;
      try {
        const fetched = await tools.deepwiki.deepwikiFetch({ url: upstreamUrl });
        upstreamDoc = fetched;
      } catch {
        totals.failed += 1;
        continue;
      }

      const held = findHeldEntity(heldEntities, nodeName);
      const upstreamStamp = latestIsoStamp(upstreamDoc);
      const upstreamMs = timestampMs(upstreamStamp);
      const heldMs = latestHeldTimestamp(held);

      const missingUpstream = isMissingUpstream(upstreamDoc);
      if (missingUpstream) {
        const removal = await tools.memory.deleteEntities({ entityNames: [nodeName] });
        if (removal.success) {
          totals.deleted += 1;
        } else {
          totals.skipped += 1;
        }
        continue;
      }

      const upstreamIsNewer = isNewer(upstreamMs, heldMs);
      if (!upstreamIsNewer) {
        totals.skipped += 1;
        continue;
      }

      const docText = documentText(upstreamDoc);
      const body = observationBody(upstreamUrl, upstreamStamp, docText);
      const stamped = await tools.memory.addObservations({
        observations: [{ entityName: nodeName, contents: [body] }],
      });
      const applied = stamped.results.length > 0;
      if (applied) {
        totals.updated += 1;
      } else {
        totals.skipped += 1;
      }
    }

    recordTopicReport(report, { ...totals });
  }

  // ---- Sync log ---------------------------------------------------------
  const logText = renderLog(report);
  await tools.filesystem.writeFile({ path: "sync-log.md", content: logText });

  const grandTotals = sumTotals(report);
  return { perTopic: report, totals: grandTotals };
}

// ---------------------------------------------------------------------------
// Paging + collection helpers
// ---------------------------------------------------------------------------

function pageOf(entities: GraphEntity[], page: number, pageSize: number): GraphEntity[] {
  const start = page * pageSize;
  return entities.slice(start, start + pageSize);
}

function namesOf(entities: GraphEntity[]): string[] {
  return entities.map((entity) => entity.name);
}

function recordNames(target: string[], names: string[]): void {
  for (const name of names) target.push(name);
}

function recordEntities(target: GraphEntity[], entities: GraphEntity[]): void {
  for (const entity of entities) {
    const alreadyHeld = target.some((held) => held.name === entity.name);
    if (!alreadyHeld) target.push(entity);
  }
}

function isShortPage(names: string[], pageSize: number): boolean {
  return names.length < pageSize;
}

function dedupeNames(names: string[]): string[] {
  const unique: string[] = [];
  for (const name of names) {
    if (!unique.includes(name)) unique.push(name);
  }
  return unique;
}

function capToBudget(names: string[], budget: number): string[] {
  return names.slice(0, Math.max(0, budget));
}

function findHeldEntity(entities: GraphEntity[], name: string): GraphEntity | undefined {
  return entities.find((entity) => entity.name === name);
}

// ---------------------------------------------------------------------------
// Upstream-result helpers (tolerant of loosely shaped payloads)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasUsableHit(result: unknown): boolean {
  if (typeof result === "string") return result.trim().length > 0;
  const record = asRecord(result);
  if (!record) return false;
  if (Array.isArray(record.results)) return record.results.length > 0;
  if (typeof record.content === "string") return record.content.trim().length > 0;
  return false;
}

function firstHitUrl(result: unknown): string {
  const record = asRecord(result);
  if (!record) return typeof result === "string" ? firstUrlInText(result) : "";
  if (Array.isArray(record.results)) {
    for (const item of record.results) {
      const itemRecord = asRecord(item);
      const candidate = itemRecord
        ? (itemRecord.url ?? itemRecord.href ?? itemRecord.link)
        : undefined;
      if (typeof candidate === "string" && candidate.length > 0) return candidate;
    }
  }
  if (typeof record.content === "string") return firstUrlInText(record.content);
  return "";
}

function firstUrlInText(text: string): string {
  const match = /https?:\/\/[^\s"'<>)]+/.exec(text);
  return match ? match[0] : "";
}

function documentText(doc: unknown): string {
  if (typeof doc === "string") return doc;
  const record = asRecord(doc);
  if (!record) return "";
  for (const key of ["content", "markdown", "text"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function isMissingUpstream(doc: unknown): boolean {
  return documentText(doc).trim().length === 0;
}

// ---------------------------------------------------------------------------
// Freshness helpers — ISO stamps embedded in documents / observations
// ---------------------------------------------------------------------------

const ISO_PATTERN =
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function latestIsoStamp(value: unknown): string {
  const text = typeof value === "string" ? value : safeJson(value);
  const stamps = text.match(ISO_PATTERN) ?? [];
  let best = "";
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const stamp of stamps) {
    const ms = Date.parse(stamp);
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      best = stamp;
    }
  }
  return best;
}

function timestampMs(iso: string): number {
  if (iso.length === 0) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function latestHeldTimestamp(entity: GraphEntity | undefined): number {
  if (!entity) return 0;
  let best = 0;
  for (const observation of entity.observations) {
    const ms = timestampMs(latestIsoStamp(observation));
    if (ms > best) best = ms;
  }
  return best;
}

function isNewer(upstreamMs: number, heldMs: number): boolean {
  return upstreamMs > heldMs;
}

function observationBody(sourceUrl: string, fetchedAt: string, text: string): string {
  const stamp = fetchedAt.length > 0 ? fetchedAt : "unknown";
  return [
    "upstream-sync",
    `source: ${sourceUrl}`,
    `fetched_at: ${stamp}`,
    "",
    text,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

function recordTopicReport(report: TopicReport[], entry: TopicReport): void {
  report.push(entry);
}

function sumTotals(report: TopicReport[]): TopicReport {
  const grand: TopicReport = { topic: "ALL", updated: 0, deleted: 0, skipped: 0, failed: 0 };
  for (const entry of report) {
    grand.updated += entry.updated;
    grand.deleted += entry.deleted;
    grand.skipped += entry.skipped;
    grand.failed += entry.failed;
  }
  return grand;
}

function renderLog(report: TopicReport[]): string {
  const lines: string[] = ["# Knowledge base sync log", ""];
  for (const entry of report) {
    lines.push(`## ${entry.topic}`);
    lines.push(`- updated: ${entry.updated}`);
    lines.push(`- deleted: ${entry.deleted}`);
    lines.push(`- skipped: ${entry.skipped}`);
    lines.push(`- failed: ${entry.failed}`);
    lines.push("");
  }
  const grand = sumTotals(report);
  lines.push("## Totals");
  lines.push(`- updated: ${grand.updated}`);
  lines.push(`- deleted: ${grand.deleted}`);
  lines.push(`- skipped: ${grand.skipped}`);
  lines.push(`- failed: ${grand.failed}`);
  return lines.join("\n");
}
```

### round 1 → L2 · 337 lines · 59 nodes (73s)

Node types: function×20, code×14, tool×6, condition×5, jump×4, merge×4, loop×3, trigger×1, try×1, output×1

Covered: condition, else-if-chain, function, jump, loop, nested-loop, try, while-loop

Diagnostics:

- `info/unsupported-construct` (line 37) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 40) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 57) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 63) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 76) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 80) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 83) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 85) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 98) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 100) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 107) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 116) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 118) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 120) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

/**
 * Knowledge-base sync.
 *
 * Per topic: walk the existing knowledge-graph entries in pages (bounded),
 * collect + dedupe node names, then reconcile each node against upstream
 * documentation found on the web: refresh stale observations, delete nodes
 * that vanished upstream, and never let one bad source abort the run.
 * Finishes by writing "sync-log.md" and returning per-topic + grand totals.
 */

// TODO(pagination): memory.searchNodes in the registry has no offset/page
// parameters, so paging is emulated: every iteration re-queries the topic and
// takes the window for the current page index. Pages overlap in practice — the
// dedupe helper absorbs that. Swap in real server-side paging when the
// registry gains a paginated search.

interface GraphEntity {
  name: string;
  entityType: string;
  observations: string[];
}

interface TopicReport {
  topic: string;
  updated: number;
  deleted: number;
  skipped: number;
  failed: number;
}

export default async function flow(
  input: { topics: string[]; pageSize: number; maxPagesPerTopic: number },
  tools: Tools
) {
  const report: TopicReport[] = [];

  for (const topic of input.topics) {
    const totals: TopicReport = { topic, updated: 0, deleted: 0, skipped: 0, failed: 0 };

    // ---- Walk the existing graph entries, page by page (bounded) --------
    const collectedNames: string[] = [];
    const heldEntities: GraphEntity[] = [];
    let page = 0;
    let reachedLastPage = false;

    while (page < input.maxPagesPerTopic && !reachedLastPage) {
      const matchPage = await tools.memory.searchNodes({ query: topic });

      const entitiesOnPage = pageOf(matchPage.entities, page, input.pageSize);
      const namesOnPage = namesOf(entitiesOnPage);
      recordNames(collectedNames, namesOnPage);
      recordEntities(heldEntities, entitiesOnPage);

      const shortPage = isShortPage(namesOnPage, input.pageSize);
      reachedLastPage = shortPage;
      page += 1;
    }

    // ---- Dedupe before use, and respect the per-topic touch budget ------
    const uniqueNames = dedupeNames(collectedNames);
    const touchBudget = input.maxPagesPerTopic * input.pageSize;
    const budget = capToBudget(uniqueNames, touchBudget);

    // ---- Reconcile each node against upstream ---------------------------
    for (const nodeName of budget) {
      const webHits = await tools.duckduckgo.duckduckgoWebSearch({
        query: `${nodeName} ${topic}`,
        count: 5,
      });

      const upstreamUrl = firstHitUrl(webHits);
      const hasUpstream = hasUsableUpstream(webHits);
      if (!hasUpstream) {
        totals.skipped += 1;
        continue;
      }

      let upstreamDoc: unknown = undefined;
      try {
        const fetched = await tools.deepwiki.deepwikiFetch({ url: upstreamUrl });
        upstreamDoc = fetched;
      } catch {
        totals.failed += 1;
        continue;
      }

      const held = findHeldEntity(heldEntities, nodeName);
      const upstreamStamp = latestIsoStamp(upstreamDoc);
      const upstreamMs = timestampMs(upstreamStamp);
      const heldMs = latestHeldTimestamp(held);

      const missingUpstream = isMissingUpstream(upstreamDoc);
      if (missingUpstream) {
        const removal = await tools.memory.deleteEntities({ entityNames: [nodeName] });
        if (removal.success) {
          totals.deleted += 1;
        } else {
          totals.skipped += 1;
        }
        continue;
      }

      const upstreamIsNewer = isNewer(upstreamMs, heldMs);
      if (!upstreamIsNewer) {
        totals.skipped += 1;
        continue;
      }

      const docText = documentText(upstreamDoc);
      const body = observationBody(upstreamUrl, upstreamStamp, docText);
      const stamped = await tools.memory.addObservations({
        observations: [{ entityName: nodeName, contents: [body] }],
      });
      const applied = stamped.results.length > 0;
      if (applied) {
        totals.updated += 1;
      } else {
        totals.skipped += 1;
      }
    }

    recordTopicReport(report, { ...totals });
  }

  // ---- Sync log ---------------------------------------------------------
  const logText = renderLog(report);
  await tools.filesystem.writeFile({ path: "sync-log.md", content: logText });

  const grandTotals = sumTotals(report);
  return { perTopic: report, totals: grandTotals };
}

// ---------------------------------------------------------------------------
// Paging + collection helpers
// ---------------------------------------------------------------------------

function pageOf(entities: GraphEntity[], page: number, pageSize: number): GraphEntity[] {
  const start = page * pageSize;
  return entities.slice(start, start + pageSize);
}

function namesOf(entities: GraphEntity[]): string[] {
  return entities.map((entity) => entity.name);
}

function recordNames(target: string[], names: string[]): void {
  for (const name of names) target.push(name);
}

function recordEntities(target: GraphEntity[], entities: GraphEntity[]): void {
  for (const entity of entities) {
    const alreadyHeld = target.some((held) => held.name === entity.name);
    if (!alreadyHeld) target.push(entity);
  }
}

function isShortPage(names: string[], pageSize: number): boolean {
  return names.length < pageSize;
}

function dedupeNames(names: string[]): string[] {
  const unique: string[] = [];
  for (const name of names) {
    if (!unique.includes(name)) unique.push(name);
  }
  return unique;
}

function capToBudget(names: string[], budget: number): string[] {
  return names.slice(0, Math.max(0, budget));
}

function findHeldEntity(entities: GraphEntity[], name: string): GraphEntity | undefined {
  return entities.find((entity) => entity.name === name);
}

// ---------------------------------------------------------------------------
// Upstream-result helpers (tolerant of loosely shaped payloads)
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasUsableUpstream(result: unknown): boolean {
  const url = firstHitUrl(result);
  const usable = hasUsableHit(result);
  return usable && url.length > 0;
}

function hasUsableHit(result: unknown): boolean {
  if (typeof result === "string") return result.trim().length > 0;
  const record = asRecord(result);
  if (!record) return false;
  if (Array.isArray(record.results)) return record.results.length > 0;
  if (typeof record.content === "string") return record.content.trim().length > 0;
  return false;
}

function firstHitUrl(result: unknown): string {
  const record = asRecord(result);
  if (!record) return typeof result === "string" ? firstUrlInText(result) : "";
  if (Array.isArray(record.results)) {
    for (const item of record.results) {
      const itemRecord = asRecord(item);
      const candidate = itemRecord
        ? (itemRecord.url ?? itemRecord.href ?? itemRecord.link)
        : undefined;
      if (typeof candidate === "string" && candidate.length > 0) return candidate;
    }
  }
  if (typeof record.content === "string") return firstUrlInText(record.content);
  return "";
}

function firstUrlInText(text: string): string {
  const match = /https?:\/\/[^\s"'<>)]+/.exec(text);
  return match ? match[0] : "";
}

function documentText(doc: unknown): string {
  if (typeof doc === "string") return doc;
  const record = asRecord(doc);
  if (!record) return "";
  for (const key of ["content", "markdown", "text"]) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return "";
}

function isMissingUpstream(doc: unknown): boolean {
  return documentText(doc).trim().length === 0;
}

// ---------------------------------------------------------------------------
// Freshness helpers — ISO stamps embedded in documents / observations
// ---------------------------------------------------------------------------

const ISO_PATTERN =
  /\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?/g;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function latestIsoStamp(value: unknown): string {
  const text = typeof value === "string" ? value : safeJson(value);
  const stamps = text.match(ISO_PATTERN) ?? [];
  let best = "";
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const stamp of stamps) {
    const ms = Date.parse(stamp);
    if (!Number.isNaN(ms) && ms > bestMs) {
      bestMs = ms;
      best = stamp;
    }
  }
  return best;
}

function timestampMs(iso: string): number {
  if (iso.length === 0) return 0;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
}

function latestHeldTimestamp(entity: GraphEntity | undefined): number {
  if (!entity) return 0;
  let best = 0;
  for (const observation of entity.observations) {
    const ms = timestampMs(latestIsoStamp(observation));
    if (ms > best) best = ms;
  }
  return best;
}

function isNewer(upstreamMs: number, heldMs: number): boolean {
  return upstreamMs > heldMs;
}

function observationBody(sourceUrl: string, fetchedAt: string, text: string): string {
  const stamp = fetchedAt.length > 0 ? fetchedAt : "unknown";
  return [
    "upstream-sync",
    `source: ${sourceUrl}`,
    `fetched_at: ${stamp}`,
    "",
    text,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

function recordTopicReport(report: TopicReport[], entry: TopicReport): void {
  report.push(entry);
}

function sumTotals(report: TopicReport[]): TopicReport {
  const grand: TopicReport = { topic: "ALL", updated: 0, deleted: 0, skipped: 0, failed: 0 };
  for (const entry of report) {
    grand.updated += entry.updated;
    grand.deleted += entry.deleted;
    grand.skipped += entry.skipped;
    grand.failed += entry.failed;
  }
  return grand;
}

function renderLog(report: TopicReport[]): string {
  const lines: string[] = ["# Knowledge base sync log", ""];
  for (const entry of report) {
    lines.push(`## ${entry.topic}`);
    lines.push(`- updated: ${entry.updated}`);
    lines.push(`- deleted: ${entry.deleted}`);
    lines.push(`- skipped: ${entry.skipped}`);
    lines.push(`- failed: ${entry.failed}`);
    lines.push("");
  }
  const grand = sumTotals(report);
  lines.push("## Totals");
  lines.push(`- updated: ${grand.updated}`);
  lines.push(`- deleted: ${grand.deleted}`);
  lines.push(`- skipped: ${grand.skipped}`);
  lines.push(`- failed: ${grand.failed}`);
  return lines.join("\n");
}
```

## dependency-audit

Servers: filesystem, context7, deepwiki, sequential-thinking · 18 tools · system prompt ≈ 4547 tokens.

Tools actually called: `context7.queryDocs`, `context7.resolveLibraryId`, `deepwiki.deepwikiFetch`, `filesystem.createDirectory`, `filesystem.directoryTree`, `filesystem.readTextFile`, `filesystem.writeFile`, `sequentialThinking.sequentialthinking`

### round 0 → L2 · 483 lines · 65 nodes (666s)

Node types: function×15, tool×11, code×9, merge×8, condition×7, jump×7, loop×3, try×2, trigger×1, parallel×1, output×1

Covered: condition, function, jump, loop, nested-loop, parallel, try · **missing: else-if-chain**

Diagnostics:

- `info/unsupported-construct` (line 356) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 366) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 372) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 389) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 392) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 429) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 435) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 437) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 439) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

// ---------------------------------------------------------------------------
// Weekly dependency audit
//
// Trigger payload:
//   repositories:       directories of the repositories to audit
//   riskyDependencies:  dependency names considered risky
//
// Walks every repository, finds its manifest files, checks them for the
// risky dependencies, resolves documentation for each hit (docs lookup and
// wiki lookup run in parallel), grades every finding, reasons over the
// results in three sequential thoughts, and writes audit/report.md
// (plus audit/failures.md when anything failed to read).
// ---------------------------------------------------------------------------

type Grade = "critical" | "warning" | "info";

interface GradeCounts {
  critical: number;
  warning: number;
  info: number;
}

interface DependencyFinding {
  repository: string;
  manifest: string;
  dependency: string;
  grade: Grade;
}

interface ReadFailure {
  repository: string;
  item: string;
}

interface TreeNode {
  name: string;
  type: string;
  children?: TreeNode[];
}

/** More than this many findings exceeds a week of human review (req. 5). */
const FINDING_LIMIT = 20;

const AUDIT_DIR = "audit";

const TREE_EXCLUSIONS = [
  "node_modules/**",
  ".git/**",
  "dist/**",
  "build/**",
  "vendor/**",
  "target/**",
  ".venv/**",
  "__pycache__/**",
];

const MANIFEST_FILE_NAMES = new Set<string>([
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
]);

/** Section headers that hold non-production (non-direct) dependencies. */
const NON_DIRECT_SECTION = /(test|dev|bench|doc|build|optional|example|workspace|target)/i;

// -- small utilities ----------------------------------------------------------

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fileNameOf(path: string): string {
  const segments = path.split("/");
  return segments[segments.length - 1] ?? path;
}

// -- manifest discovery --------------------------------------------------------

/** Pick the manifest files out of a repository directory-tree snapshot. */
function collectManifestPaths(rootDirectory: string, treeJson: string): string[] {
  let tree: TreeNode;
  try {
    tree = JSON.parse(treeJson) as TreeNode;
  } catch {
    // Unparseable tree snapshot: treat as "no manifests found".
    return [];
  }
  const base = rootDirectory.endsWith("/") ? rootDirectory.slice(0, -1) : rootDirectory;
  const found: string[] = [];
  const visit = (node: TreeNode, parentPath: string): void => {
    const path = parentPath === "" ? node.name : `${parentPath}/${node.name}`;
    if (node.type === "file") {
      if (MANIFEST_FILE_NAMES.has(node.name)) {
        found.push(`${base}/${path}`);
      }
      return;
    }
    for (const child of node.children ?? []) {
      visit(child, path);
    }
  };
  if (tree !== null && typeof tree === "object") {
    visit(tree, "");
  }
  return found;
}

// -- mention check + grading (req. 3 and req. 4) -------------------------------

function manifestMentions(manifestText: string, dependency: string): boolean {
  return manifestText.toLowerCase().includes(dependency.toLowerCase());
}

/** True when the manifest pins the dependency to a version below 1.0.0. */
function pinsVersionBelowOne(manifestText: string, dependency: string): boolean {
  const name = escapeRegExp(dependency);
  // JSON/TOML style: "dep": "~0.9.0"  /  dep = "^0.4"
  const keyValue = new RegExp(
    `["']${name}["']\\s*[:=]\\s*["'][~^><=*\\s]*v?0(\\.\\d+)?`,
    "i",
  );
  // Python style: dep==0.3.1  /  dep[extra]==0.3.1
  const pythonPin = new RegExp(
    `^\\s*${name}(?:\\[[^\\]]*\\])?\\s*==\\s*v?0\\.`,
    "im",
  );
  // Bare pin with a leading-zero version, e.g. "dep 0.2.3".
  const barePin = new RegExp(`\\b${name}\\s+v?0\\.\\d+`, "i");
  return keyValue.test(manifestText) || pythonPin.test(manifestText) || barePin.test(manifestText);
}

function packageJsonObject(manifestText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(manifestText);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function requirementsTxtHasDirect(text: string, escapedName: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("-")) {
      continue;
    }
    if (new RegExp(`^${escapedName}(?:\\[[^\\]]*\\])?(?:[~<>=!].*)?$`, "i").test(trimmed)) {
      return true;
    }
  }
  return false;
}

function goModHasDirect(text: string, escapedName: string): boolean {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.includes("// indirect")) {
      continue;
    }
    if (new RegExp(`^${escapedName}(?:\\s+v\\S+)?$`).test(trimmed)) {
      return true;
    }
  }
  return false;
}

function tomlHasDirect(text: string, escapedName: string): boolean {
  let seenHeader = false;
  let inDirectSection = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = /^\[\[?\s*([^\]"']+?)\s*\]?\]$/.exec(trimmed);
    if (header) {
      seenHeader = true;
      inDirectSection = !NON_DIRECT_SECTION.test(header[1]);
      continue;
    }
    if (seenHeader && inDirectSection && new RegExp(`^${escapedName}\\b`).test(trimmed)) {
      return true;
    }
  }
  return false;
}

/** True when the dependency appears among the manifest's direct dependencies. */
function isDirectDependency(manifestPath: string, manifestText: string, dependency: string): boolean {
  const file = fileNameOf(manifestPath);
  const escaped = escapeRegExp(dependency);

  if (file === "package.json") {
    const parsed = packageJsonObject(manifestText);
    if (parsed === null) {
      return false;
    }
    const sections = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];
    for (const section of sections) {
      const entries = parsed[section];
      if (
        entries !== null &&
        typeof entries === "object" &&
        !Array.isArray(entries) &&
        Object.prototype.hasOwnProperty.call(entries, dependency)
      ) {
        return true;
      }
    }
    return false;
  }
  if (file === "requirements.txt") {
    return requirementsTxtHasDirect(manifestText, escaped);
  }
  if (file === "go.mod") {
    return goModHasDirect(manifestText, escaped);
  }
  if (file === "pyproject.toml" || file === "Cargo.toml") {
    return tomlHasDirect(manifestText, escaped);
  }
  // Unrecognised manifest formats stay conservative (req. 4: "info" otherwise).
  return false;
}

function gradeFinding(manifestPath: string, manifestText: string, dependency: string): Grade {
  if (pinsVersionBelowOne(manifestText, dependency)) {
    return "critical";
  }
  if (isDirectDependency(manifestPath, manifestText, dependency)) {
    return "warning";
  }
  return "info";
}

// -- recording ------------------------------------------------------------------

function addFinding(
  list: DependencyFinding[],
  repository: string,
  manifest: string,
  dependency: string,
  grade: Grade,
): void {
  list.push({ repository, manifest, dependency, grade });
}

function recordReadFailure(list: ReadFailure[], repository: string, item: string): void {
  list.push({ repository, item });
}

// -- documentation lookups (req. 3) ---------------------------------------------

function docsQueryFor(dependency: string): string {
  return `Security advisories, breaking changes, and maintenance status of ${dependency}`;
}

// NOTE: the registry requires resolving a Context7 library id before querying,
// but the resolver's choice is not returned as data, so these builders fall
// back to conventional identifiers derived from the dependency name.
function assumedContext7Id(dependency: string): string {
  return `/npm/${dependency}`;
}

function assumedDeepWikiUrl(dependency: string): string {
  return `https://deepwiki.com/${dependency}`;
}

// -- reporting -------------------------------------------------------------------

function countByGrade(findings: DependencyFinding[]): GradeCounts {
  const counts: GradeCounts = { critical: 0, warning: 0, info: 0 };
  for (const finding of findings) {
    counts[finding.grade] += 1;
  }
  return counts;
}

function summarizeFindings(findings: DependencyFinding[]): string {
  if (findings.length === 0) {
    return "no risky-dependency findings";
  }
  const counts = countByGrade(findings);
  return `${findings.length} findings (critical: ${counts.critical}, warning: ${counts.warning}, info: ${counts.info})`;
}

function summarizeFailures(failures: ReadFailure[]): string {
  return failures.length === 0 ? "nothing failed to read" : `${failures.length} item(s) failed to read`;
}

function buildRecommendation(counts: GradeCounts, findings: DependencyFinding[]): string {
  if (findings.length === 0) {
    return "No risky dependencies were found; no action is required this week.";
  }
  const actions: string[] = [];
  if (counts.critical > 0) {
    actions.push(`treat the ${counts.critical} dependency(ies) pinned below version 1 as the week's priority upgrade`);
  }
  if (counts.warning > 0) {
    actions.push(`schedule updates for the ${counts.warning} risky dependencies used directly`);
  }
  if (counts.info > 0) {
    actions.push(`review the ${counts.info} remaining mentions during routine maintenance`);
  }
  return `${actions.join("; ")}.`;
}

function renderReport(
  findings: DependencyFinding[],
  failures: ReadFailure[],
  recommendation: string,
  truncationNotice: string,
): string {
  const lines: string[] = ["# Weekly dependency audit", ""];
  for (const grade of ["critical", "warning", "info"] as Grade[]) {
    const bucket = findings.filter((candidate) => candidate.grade === grade);
    lines.push(`## ${grade} (${bucket.length})`, "");
    if (bucket.length === 0) {
      lines.push("_none_", "");
      continue;
    }
    for (const finding of bucket) {
      lines.push(`- \`${finding.dependency}\` in \`${finding.manifest}\` — repository: ${finding.repository}`);
    }
    lines.push("");
  }
  if (truncationNotice !== "") {
    lines.push(`> ${truncationNotice}`, "");
  }
  if (failures.length > 0) {
    lines.push(`> ${failures.length} item(s) could not be read — see ${AUDIT_DIR}/failures.md.`, "");
  }
  lines.push("## Recommendation", "", recommendation, "");
  return lines.join("\n");
}

function renderFailureReport(failures: ReadFailure[]): string {
  const lines: string[] = ["# Audit read failures", ""];
  for (const failure of failures) {
    lines.push(`- ${failure.item} in repository \`${failure.repository}\``);
  }
  lines.push("");
  return lines.join("\n");
}

// -- the flow ---------------------------------------------------------------------

export default async function flow(
  input: { repositories: string[]; riskyDependencies: string[] },
  tools: Tools,
) {
  const findings: DependencyFinding[] = [];
  const readFailures: ReadFailure[] = [];
  let repositoriesAudited = 0;

  for (const repository of input.repositories) {
    if (findings.length > FINDING_LIMIT) {
      break; // req. 5: more than twenty findings — stop auditing further repositories
    }

    // Snapshot the repository tree once; manifests are picked out of it below.
    let treeJson: string;
    try {
      const snapshot = await tools.filesystem.directoryTree({
        path: repository,
        excludePatterns: TREE_EXCLUSIONS,
      });
      treeJson = snapshot.content;
    } catch {
      recordReadFailure(readFailures, repository, `${repository} (directory tree)`);
      continue;
    }

    const manifestPaths = collectManifestPaths(repository, treeJson);
    if (manifestPaths.length === 0) {
      continue; // req. 1: no manifest — skip this repository
    }

    for (const manifestPath of manifestPaths) {
      if (findings.length > FINDING_LIMIT) {
        break; // req. 5
      }

      // req. 2: read the manifest; on failure record and move on.
      let manifestText: string;
      try {
        const file = await tools.filesystem.readTextFile({ path: manifestPath });
        manifestText = file.content;
      } catch {
        recordReadFailure(readFailures, repository, manifestPath);
        continue;
      }

      for (const dependency of input.riskyDependencies) {
        const mentioned = manifestMentions(manifestText, dependency);
        if (!mentioned) {
          continue;
        }

        const grade = gradeFinding(manifestPath, manifestText, dependency);
        addFinding(findings, repository, manifestPath, dependency, grade);

        if (findings.length > FINDING_LIMIT) {
          break; // req. 5: stop inspecting this manifest, then further repositories
        }

        const docsQuery = docsQueryFor(dependency);

        // req. 3: resolve the documentation id first…
        const resolved = await tools.context7.resolveLibraryId({
          query: docsQuery,
          libraryName: dependency,
        });

        // …then fetch the documentation and the wiki page concurrently (req. 3).
        const docsId = assumedContext7Id(dependency);
        const wikiUrl = assumedDeepWikiUrl(dependency);
        const [documentation, wikiPage] = await Promise.all([
          tools.context7.queryDocs({ libraryId: docsId, query: docsQuery }),
          tools.deepwiki.deepwikiFetch({ url: wikiUrl }),
        ]);
      }
    }

    repositoriesAudited += 1;
  }

  const counts = countByGrade(findings);
  const findingSummary = summarizeFindings(findings);
  const failureSummary = summarizeFailures(readFailures);
  let truncationNotice = "";
  if (findings.length > FINDING_LIMIT) {
    truncationNotice = `Finding limit of ${FINDING_LIMIT} reached; remaining repositories were not inspected.`;
  }
  const caveat = readFailures.length > 0 ? ` Also account for: ${failureSummary}.` : "";
  const truncationSuffix = truncationNotice === "" ? "" : ` ${truncationNotice}`;

  // req. 6: reason over the findings in three sequential thoughts.
  const inventory = await tools.sequentialThinking.sequentialthinking({
    thought: `Weekly dependency audit inventory: audited ${repositoriesAudited} repositories and collected ${findingSummary}, with ${failureSummary}. Identify which repositories and manifests concentrate the findings.`,
    thoughtNumber: 1,
    totalThoughts: 3,
    nextThoughtNeeded: true,
  });
  const weighting = await tools.sequentialThinking.sequentialthinking({
    thought: `Risk weighting over ${findingSummary}: critical entries pin a risky dependency below version 1 (likely unmaintained or pre-release), warnings mark direct use, info entries are indirect or unpinned mentions and can wait.`,
    thoughtNumber: 2,
    totalThoughts: 3,
    nextThoughtNeeded: true,
  });
  const conclusion = await tools.sequentialThinking.sequentialthinking({
    thought: `Conclude the weekly recommendation from the collected findings: ${findingSummary}.${caveat}${truncationSuffix}`,
    thoughtNumber: 3,
    totalThoughts: 3,
    nextThoughtNeeded: false,
  });

  const recommendation = buildRecommendation(counts, findings);

  // req. 7: write the report (and the failure report when anything failed).
  await tools.filesystem.createDirectory({ path: AUDIT_DIR });

  const reportMarkdown = renderReport(findings, readFailures, recommendation, truncationNotice);
  await tools.filesystem.writeFile({ path: `${AUDIT_DIR}/report.md`, content: reportMarkdown });

  if (readFailures.length > 0) {
    const failureMarkdown = renderFailureReport(readFailures);
    await tools.filesystem.writeFile({ path: `${AUDIT_DIR}/failures.md`, content: failureMarkdown });
  }

  // req. 8: counts per grade and the number of repositories audited.
  return {
    repositoriesAudited,
    findingsByGrade: counts,
    totalFindings: findings.length,
    readFailures: readFailures.length,
    truncated: truncationNotice !== "",
  };
}
```

## repo-triage-bot

Servers: filesystem, memory · 23 tools · system prompt ≈ 3427 tokens.

Tools actually called: `filesystem.directoryTree`, `filesystem.getFileInfo`, `filesystem.listAllowedDirectories`, `filesystem.listDirectoryWithSizes`, `filesystem.readTextFile`, `filesystem.searchFiles`, `filesystem.writeFile`, `memory.createEntities`, `memory.createRelations`, `memory.readGraph`

### round 0 → L2 · 312 lines · 61 nodes (264s)

Node types: function×19, tool×12, condition×6, merge×6, code×6, jump×4, output×2, loop×2, try×2, trigger×1, parallel×1

Covered: condition, early-return, function, jump, loop, nested-loop, parallel, try · **missing: else-if-chain**

Diagnostics:

- `info/unsupported-construct` (line 222) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 241) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 247) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 251) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 254) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 267) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

// ---------------------------------------------------------------------------
// Types & constants
// ---------------------------------------------------------------------------

interface TriageInput {
  /** Root directory of the repository to triage. */
  rootDirectory: string;
  /** Risky filename patterns (glob-style, relative to the root). */
  riskyPatterns: string[];
  /** Maximum number of files to inspect in one run. */
  maxFiles: number;
}

type Severity = "high" | "medium" | "low";

interface SeverityCounts {
  high: number;
  medium: number;
  low: number;
}

const LARGE_FILE_BYTES = 100 * 1024;

// ---------------------------------------------------------------------------
// Pure helpers — each becomes a readable function node in the graph
// ---------------------------------------------------------------------------

function parseAllowedDirectories(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.map((entry) => String(entry));
    } catch {
      // fall through to line-based parsing
    }
  }
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function isRootPermitted(allowedDirs: string[], root: string): boolean {
  return allowedDirs.some((dir) => {
    if (dir === root) return true;
    // Subdirectories of an allowed directory are accessible too.
    const base = dir.endsWith("/") ? dir : `${dir}/`;
    return root.startsWith(base);
  });
}

function refusalReason(root: string): string {
  return `refused: root directory "${root}" is not in the list of allowed directories`;
}

function hasMatches(searchOutput: string): boolean {
  return searchOutput.trim().length > 0;
}

function extractFilePaths(searchOutput: string): string[] {
  return searchOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Best-effort extraction of the byte size from getFileInfo's textual output. */
function parseSizeBytes(fileInfo: string): number {
  const match = fileInfo.match(/Size:\s*([\d,]+)/i);
  if (!match) return 0;
  return Number(match[1].replace(/,/g, ""));
}

function mentionsPassword(contents: string): boolean {
  return contents.toLowerCase().includes("password");
}

function mentionsTodoMarker(contents: string): boolean {
  return contents.includes("TODO") || contents.includes("FIXME");
}

function classifySeverity(contents: string, sizeBytes: number): Severity {
  if (sizeBytes > LARGE_FILE_BYTES || mentionsPassword(contents)) return "high";
  if (mentionsTodoMarker(contents)) return "medium";
  return "low";
}

function severityObservation(severity: Severity): string {
  return `severity: ${severity}`;
}

function sizeObservation(sizeBytes: number): string {
  return `size: ${sizeBytes} bytes`;
}

function recordFailure(errorLines: string[], filePath: string, error: unknown): void {
  errorLines.push(
    `${new Date().toISOString()} READ_FAILED ${filePath}: ${String(error)}`
  );
}

function renderErrorLog(errorLines: string[]): string {
  if (errorLines.length === 0) return "";
  return errorLines.join("\n") + "\n";
}

function trackHighPath(highPaths: string[], filePath: string): void {
  highPaths.push(filePath);
}

function emptyCounts(): SeverityCounts {
  return { high: 0, medium: 0, low: 0 };
}

function summarizePatterns(patterns: string[]): string {
  return patterns.join(", ");
}

function runEntityName(root: string): string {
  const slug = root.replace(/[^a-zA-Z0-9._-]+/g, "-");
  return `triage-run:${slug}:${new Date().toISOString()}`;
}

function errorLogPath(root: string): string {
  return `${root}/triage-errors.log`;
}

function reportPath(root: string): string {
  return `${root}/triage-report.md`;
}

function renderReport(parts: {
  root: string;
  filesSeen: number;
  counts: SeverityCounts;
  failedReads: number;
  highPaths: string[];
  sizedListing: string;
  tree: string;
}): string {
  const highSection =
    parts.highPaths.length === 0
      ? "(none)"
      : parts.highPaths.map((p) => `- ${p}`).join("\n");
  return [
    "# Repository triage report",
    "",
    `- Root: ${parts.root}`,
    `- Files inspected: ${parts.filesSeen}`,
    `- Failed reads: ${parts.failedReads}`,
    "",
    "## Files by severity",
    `- high: ${parts.counts.high}`,
    `- medium: ${parts.counts.medium}`,
    `- low: ${parts.counts.low}`,
    "",
    "## High-severity paths",
    highSection,
    "",
    "## Repository snapshot",
    "",
    "### Directory listing (with sizes)",
    "```",
    parts.sizedListing,
    "```",
    "",
    "### Directory tree",
    "```",
    parts.tree,
    "```",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export default async function flow(input: TriageInput, tools: Tools) {
  // Step 1 — permission gate: refuse runs outside the allowed directories.
  const allowedRaw = await tools.filesystem.listAllowedDirectories({});
  const allowedDirs = parseAllowedDirectories(allowedRaw.content);
  const permitted = isRootPermitted(allowedDirs, input.rootDirectory);
  if (!permitted) {
    const blankCounts = emptyCounts();
    const reason = refusalReason(input.rootDirectory);
    return {
      refused: true,
      reason,
      filesSeen: 0,
      countsBySeverity: blankCounts,
      failedReads: 0,
    };
  }

  // Step 2 — repository snapshot: sized listing and recursive tree, in parallel.
  const [sizedListing, repoTree] = await Promise.all([
    tools.filesystem.listDirectoryWithSizes({ path: input.rootDirectory }),
    tools.filesystem.directoryTree({ path: input.rootDirectory, excludePatterns: [".git"] }),
  ]);

  // Entity representing this run; high-severity files will be linked to it.
  const runName = runEntityName(input.rootDirectory);
  const patternSummary = summarizePatterns(input.riskyPatterns);
  await tools.memory.createEntities({
    entities: [
      {
        name: runName,
        entityType: "triage-run",
        observations: [`patterns: ${patternSummary}`, `maxFiles: ${input.maxFiles}`],
      },
    ],
  });

  const logPath = errorLogPath(input.rootDirectory);
  const reportFile = reportPath(input.rootDirectory);

  const severityCounts = emptyCounts();
  const highPaths: string[] = [];
  const errorLines: string[] = [];
  let filesSeen = 0;
  let failedReads = 0;

  // Steps 3–6 — scan pattern by pattern, respecting the per-run file budget.
  for (const pattern of input.riskyPatterns) {
    if (filesSeen >= input.maxFiles) break;

    const searchResult = await tools.filesystem.searchFiles({
      path: input.rootDirectory,
      pattern,
    });
    const patternMatched = hasMatches(searchResult.content);
    if (!patternMatched) continue;

    const candidatePaths = extractFilePaths(searchResult.content);
    for (const filePath of candidatePaths) {
      if (filesSeen >= input.maxFiles) break;
      filesSeen += 1;

      let contents = "";
      let sizeBytes = 0;
      try {
        const fileContents = await tools.filesystem.readTextFile({ path: filePath });
        contents = fileContents.content;

        const fileInfo = await tools.filesystem.getFileInfo({ path: filePath });
        const parsedSize = parseSizeBytes(fileInfo.content);
        sizeBytes = parsedSize;
      } catch (readError) {
        // Log the failure and move on to the next file instead of aborting.
        failedReads += 1;
        recordFailure(errorLines, filePath, readError);
        const errorLogText = renderErrorLog(errorLines);
        try {
          await tools.filesystem.writeFile({ path: logPath, content: errorLogText });
        } catch {
          // Never let a logging problem abort the triage run.
        }
        continue;
      }

      // Classify and record the file in the knowledge graph.
      const severity = classifySeverity(contents, sizeBytes);
      severityCounts[severity] += 1;
      if (severity === "high") trackHighPath(highPaths, filePath);

      const severityNote = severityObservation(severity);
      const sizeNote = sizeObservation(sizeBytes);
      await tools.memory.createEntities({
        entities: [
          {
            name: filePath,
            entityType: "triaged-file",
            observations: [severityNote, sizeNote],
          },
        ],
      });

      // Step 5 — link every high-severity file back to this run.
      if (severity === "high") {
        await tools.memory.createRelations({
          relations: [{ from: runName, to: filePath, relationType: "flags" }],
        });
      }
    }
  }

  // Step 7 — read the graph back and write the markdown report.
  const graph = await tools.memory.readGraph({});
  const reportText = renderReport({
    root: input.rootDirectory,
    filesSeen,
    counts: severityCounts,
    failedReads,
    highPaths,
    sizedListing: sizedListing.content,
    tree: repoTree.content,
  });
  await tools.filesystem.writeFile({ path: reportFile, content: reportText });

  // Step 8 — result of the run.
  return {
    refused: false,
    filesSeen,
    countsBySeverity: severityCounts,
    failedReads,
    entitiesInGraph: graph.entities.length,
  };
}
```

## research-pipeline

Servers: duckduckgo, context7, deepwiki, sequential-thinking, memory, filesystem · 28 tools · system prompt ≈ 5209 tokens.

Tools actually called: `context7.queryDocs`, `context7.resolveLibraryId`, `deepwiki.deepwikiFetch`, `duckduckgo.duckduckgoWebSearch`, `filesystem.createDirectory`, `filesystem.writeFile`, `memory.createEntities`, `memory.createRelations`, `sequentialThinking.sequentialthinking`

### round 0 → L2 · 227 lines · 41 nodes (476s)

Node types: tool×13, function×12, code×5, merge×2, loop×2, try×2, trigger×1, parallel×1, jump×1, condition×1, output×1

Covered: condition, function, jump, loop, parallel, try · **missing: nested-loop**

Diagnostics:

- `info/unsupported-construct` (line 124) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 138) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 141) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 148) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 169) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

/**
 * A source gathered during research, tracked by its URL so that duplicates
 * can be removed before anything consumes the list.
 */
type ResearchSource = {
  url: string;
  title: string;
  origin: "web-search" | "repository-wiki" | "library-docs";
};

/** Canonical DeepWiki URL for an "owner/repo" string. */
function deepWikiUrl(repository: string): string {
  return `https://deepwiki.com/${repository}`;
}

/** The web search itself is a citable starting point for the brief. */
function searchSourceFor(question: string): ResearchSource {
  return {
    url: `https://duckduckgo.com/?q=${encodeURIComponent(question)}`,
    title: `Web search: ${question}`,
    origin: "web-search",
  };
}

function wikiSourceFor(repository: string): ResearchSource {
  return {
    url: deepWikiUrl(repository),
    title: `Repository wiki: ${repository}`,
    origin: "repository-wiki",
  };
}

/** Best-effort documentation id for a library name that resolved. */
function docsIdFor(libraryName: string): string {
  return libraryName.trim().toLowerCase().replace(/\s+/g, "-");
}

function docsSourceFor(libraryName: string, libraryId: string): ResearchSource {
  return {
    url: `https://context7.com/${libraryId}`,
    title: `Documentation: ${libraryName}`,
    origin: "library-docs",
  };
}

function addSource(into: ResearchSource[], source: ResearchSource): void {
  into.push(source);
}

function recordDeadSource(into: string[], libraryName: string): void {
  into.push(libraryName);
}

/** The one place where URL deduplication lives — never scattered. */
function dedupeByUrl(sources: ResearchSource[]): ResearchSource[] {
  const seenUrls = new Set<string>();
  const unique: ResearchSource[] = [];
  for (const source of sources) {
    if (seenUrls.has(source.url)) {
      continue;
    }
    seenUrls.add(source.url);
    unique.push(source);
  }
  return unique;
}

function renderSourcesMarkDown(question: string, sources: ResearchSource[]): string {
  const header = ["# Research sources", "", `Question: ${question}`, ""];
  const items = sources.map(
    (source) => `- [${source.title}](${source.url}) (${source.origin})`
  );
  return [...header, ...items].join("\n");
}

function renderDeadSourcesMarkDown(deadLibraries: string[]): string {
  const header = [
    "# Dead sources",
    "",
    "Library documentation pulls that failed and were dropped from the brief:",
    "",
  ];
  const items = deadLibraries.map((libraryName) => `- ${libraryName}`);
  return [...header, ...items].join("\n");
}

export default async function flow(
  input: {
    /** The research question the brief will answer. */
    question: string;
    /** Library names the analysts want consulted, e.g. ["react", "zod"]. */
    libraries: string[];
    /** GitHub repository relevant to the question, as "owner/repo". */
    repository: string;
  },
  tools: Tools
) {
  // 1. Put the research plan on record in three sequential thoughts.
  const planScope = await tools.sequentialThinking.sequentialthinking({
    thought: `Planning the research brief. Question: "${input.question}". Anchor repository: ${input.repository}. Candidate libraries requested: ${input.libraries.length}. Goal: gather web, wiki and per-library documentation sources, then consolidate them for the analysts.`,
    nextThoughtNeeded: true,
    thoughtNumber: 1,
    totalThoughts: 3,
  });

  const planGathering = await tools.sequentialThinking.sequentialthinking({
    thought: `Gathering strategy: run the web search for the question and the DeepWiki fetch of ${input.repository} concurrently, neither waiting on the other. Then walk the ${input.libraries.length} candidate libraries one at a time: resolve each to a documentation id and skip it entirely if it does not resolve; pull the documentation for the question and isolate any failing pull into a dead-source list so one bad source cannot end the run.`,
    nextThoughtNeeded: true,
    thoughtNumber: 2,
    totalThoughts: 3,
  });

  const planConsolidation = await tools.sequentialThinking.sequentialthinking({
    thought: `Consolidation strategy: deduplicate the collected sources by URL with a shared helper before anything else touches them. Store each surviving source in the knowledge graph as a "source" entity observed with the question, cited from the research-question entity. Write research/sources.md, write research/dead-sources.md only if something died, and report the kept / deduplicated-away / dead counts.`,
    nextThoughtNeeded: false,
    thoughtNumber: 3,
    totalThoughts: 3,
  });

  // 2. Web search and repository wiki in parallel — neither waits for the other.
  const repoWikiUrl = deepWikiUrl(input.repository);
  const collected: ResearchSource[] = [];

  const [webSearchRun, wikiPageFetched] = await Promise.all([
    tools.duckduckgo.duckduckgoWebSearch({ query: input.question, count: 10 }),
    tools.deepwiki.deepwikiFetch({ url: repoWikiUrl, mode: "aggregate" }),
  ]);

  const webHit = searchSourceFor(input.question);
  addSource(collected, webHit);

  const wikiHit = wikiSourceFor(input.repository);
  addSource(collected, wikiHit);

  // 3. Per-library documentation: resolve first, skip if unresolved, isolated pull.
  const deadLibraries: string[] = [];

  for (const libraryName of input.libraries) {
    let libraryId = "";
    try {
      const resolution = await tools.context7.resolveLibraryId({
        libraryName,
        query: input.question,
      });
      const derivedId = docsIdFor(libraryName);
      libraryId = derivedId;
    } catch {
      // Did not resolve: skip this library and move on to the next one.
      continue;
    }

    try {
      const libraryDocs = await tools.context7.queryDocs({
        libraryId,
        query: input.question,
      });
      const docHit = docsSourceFor(libraryName, libraryId);
      addSource(collected, docHit);
    } catch {
      // A dead documentation source must not kill the run.
      recordDeadSource(deadLibraries, libraryName);
    }
  }

  // 4. Deduplicate by URL before anything consumes the sources.
  const survivors = dedupeByUrl(collected);
  const duplicatesRemoved = collected.length - survivors.length;

  // 5. Knowledge graph: question entity, one source entity per survivor, citations.
  const questionAnchor = await tools.memory.createEntities({
    entities: [
      {
        name: input.question,
        entityType: "research-question",
        observations: [`Research question: ${input.question}`],
      },
    ],
  });

  for (const survivor of survivors) {
    const storedSource = await tools.memory.createEntities({
      entities: [
        {
          name: survivor.url,
          entityType: "source",
          observations: [input.question],
        },
      ],
    });

    const citation = await tools.memory.createRelations({
      relations: [
        {
          from: input.question,
          to: survivor.url,
          relationType: "cites",
        },
      ],
    });
  }

  // 6. Report files.
  const researchDir = await tools.filesystem.createDirectory({ path: "research" });

  const sourcesReport = renderSourcesMarkDown(input.question, survivors);
  const savedSourcesFile = await tools.filesystem.writeFile({
    path: "research/sources.md",
    content: sourcesReport,
  });

  if (deadLibraries.length > 0) {
    const deadReport = renderDeadSourcesMarkDown(deadLibraries);
    const savedDeadFile = await tools.filesystem.writeFile({
      path: "research/dead-sources.md",
      content: deadReport,
    });
  }

  // 7. Counts for whoever triggered the pipeline.
  return {
    sourcesKept: survivors.length,
    duplicatesRemoved,
    deadSources: deadLibraries.length,
  };
}
```

## browser-qa-suite

Servers: playwright, filesystem · 38 tools · system prompt ≈ 4023 tokens.

Tools actually called: `filesystem.createDirectory`, `filesystem.writeFile`, `playwright.browserClick`, `playwright.browserClose`, `playwright.browserConsoleMessages`, `playwright.browserEvaluate`, `playwright.browserNavigate`, `playwright.browserResize`, `playwright.browserSnapshot`, `playwright.browserTakeScreenshot`, `playwright.browserType`, `playwright.browserWaitFor`

### round 0 → L2 · 153 lines · 35 nodes (363s)

Node types: tool×12, function×6, code×4, condition×4, try×3, loop×2, jump×2, trigger×1, output×1

Covered: condition, else-if-chain, function, jump, loop, nested-loop, try · **missing: early-return**

Diagnostics:

- `info/unsupported-construct` (line 20) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 57) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 61) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 76) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

type ScenarioStep = {
  kind: string;
  target: string;
  text?: string;
};

type Scenario = {
  name: string;
  path: string;
  steps: ScenarioStep[];
  expectedText: string;
};

export default async function flow(
  input: { baseUrl: string; scenarios: Scenario[] },
  tools: Tools
) {
  let passedCount = 0;
  let failedCount = 0;
  const failedScenarios: string[] = [];
  let cutShort = false;

  // Evidence for every scenario (screenshots, console logs) lands here.
  await tools.filesystem.createDirectory({ path: "qa-artifacts" });

  // One desktop viewport for the whole suite, before any scenario runs.
  await tools.playwright.browserResize({ width: 1280, height: 800 });

  for (const scenario of input.scenarios) {
    try {
      const url = scenarioUrl(input.baseUrl, scenario.path);
      await tools.playwright.browserNavigate({ url });

      // Snapshot first so the scenario's step targets have refs to aim at.
      await tools.playwright.browserSnapshot({});

      for (const step of scenario.steps) {
        if (step.kind === "click") {
          await tools.playwright.browserClick({ target: step.target });
        } else if (step.kind === "type") {
          await tools.playwright.browserType({ target: step.target, text: step.text ?? "" });
        } else if (step.kind === "wait") {
          await tools.playwright.browserWaitFor({ text: step.target });
        } else {
          // Unknown step kind: skip it and move on to the next step.
          continue;
        }
      }

      // Evaluates a page-side assertion that throws when the expected text
      // is missing — the throw fails the scenario and is caught below.
      const assertExpectedText = expectedTextAssertion(scenario.expectedText);
      await tools.playwright.browserEvaluate({ function: assertExpectedText });

      passedCount += 1;
    } catch {
      // The scenario threw: record it as failed and carry on with the next one.
      recordFailure(failedScenarios, scenario.name);
      failedCount += 1;
    } finally {
      // Evidence capture runs at the end of every scenario, passed or failed.
      const screenshotFile = screenshotPath(scenario.name);
      const consoleLogFile = consoleLogPath(scenario.name);
      try {
        await tools.playwright.browserTakeScreenshot({ filename: screenshotFile, type: "png", scale: "css" });
        await tools.playwright.browserConsoleMessages({ level: "error", all: true, filename: consoleLogFile });
      } catch {
        // Evidence capture is best-effort; it must never kill the suite.
      }
    }

    // More than three failing scenarios: stop the suite early.
    if (failedCount > 3) {
      cutShort = true;
      break;
    }
  }

  try {
    await tools.playwright.browserClose({});
  } catch {
    // Closing is best-effort; the report still has to be written.
  }

  const report = renderReport(input.baseUrl, passedCount, failedCount, failedScenarios, cutShort);
  await tools.filesystem.writeFile({ path: "qa-report.md", content: report });

  return { passed: passedCount, failed: failedCount, cutShort };
}

function scenarioUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}

function expectedTextAssertion(expectedText: string): string {
  const needle = JSON.stringify(expectedText);
  return `() => {
  const text = document.body ? document.body.innerText : "";
  if (!text.includes(${needle})) {
    throw new Error("Expected text not found on page: " + ${needle});
  }
}`;
}

function slugify(scenarioName: string): string {
  return scenarioName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function screenshotPath(scenarioName: string): string {
  return `qa-artifacts/${slugify(scenarioName)}.png`;
}

function consoleLogPath(scenarioName: string): string {
  return `qa-artifacts/${slugify(scenarioName)}.console.log`;
}

function recordFailure(failedScenarios: string[], scenarioName: string): void {
  failedScenarios.push(scenarioName);
}

function renderReport(
  baseUrl: string,
  passedCount: number,
  failedCount: number,
  failedScenarios: string[],
  cutShort: boolean
): string {
  const lines: string[] = [
    "# Browser smoke-test report",
    "",
    `- Base URL: ${baseUrl}`,
    `- Scenarios passed: ${passedCount}`,
    `- Scenarios failed: ${failedCount}`,
    `- Suite cut short: ${cutShort ? "yes" : "no"}`,
    "",
  ];
  if (failedScenarios.length > 0) {
    lines.push("## Failing scenarios", "");
    for (const name of failedScenarios) {
      lines.push(`- ${name}`);
    }
  } else {
    lines.push("All scenarios passed.");
  }
  return lines.join("\n");
}
```

## incident-responder

Servers: filesystem, everything, sequential-thinking · 28 tools · system prompt ≈ 4387 tokens.

Tools actually called: `everything.getEnv`, `everything.getStructuredContent`, `filesystem.createDirectory`, `filesystem.listDirectory`, `filesystem.readTextFile`, `filesystem.writeFile`, `sequentialThinking.sequentialthinking`

### round 0 → L2 · 363 lines · 60 nodes (691s)

Node types: tool×18, function×16, code×10, merge×4, condition×3, try×3, output×2, parallel×2, trigger×1, loop×1

Covered: condition, early-return, else-if-chain, function, loop, parallel, try

Diagnostics:

- `info/unsupported-construct` (line 191) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 196) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 202) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 206) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 209) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 237) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 246) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 249) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 339) Custom code is kept verbatim — no semantic projection.
- `info/unsupported-construct` (line 342) Custom code is kept verbatim — no semantic projection.

```ts
import type { Tools } from "../generated/tools";

/**
 * Incident responder.
 *
 * Trigger payload: the incident itself — id, title, error rate (%), number of
 * affected users, the affected service, and the log files to sweep.
 */

interface IncidentInput {
  id: string;
  title: string;
  errorRate: number;
  affectedUsers: number;
  service: string;
  logFilePaths: string[];
}

type Severity = "sev1" | "sev2" | "sev3" | "sev4";

interface StatusProbe {
  temperature: number;
  conditions: string;
  humidity: number;
}

interface CollectedLog {
  path: string;
  excerpt: string;
}

interface FailedLog {
  path: string;
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Helpers — every call site in the flow body projects as its own     */
/* function node, so deriving/recording stays visible in the graph.   */
/* ------------------------------------------------------------------ */

/** Numeric triage: severity from the incident numbers alone. */
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

/** Folder holding the incident's logs (folder of the first referenced path). */
function logFolderOf(logFilePaths: string[]): string {
  const first = logFilePaths[0] ?? "";
  const cut = first.lastIndexOf("/");
  return cut === -1 ? "." : first.slice(0, cut);
}

/** Deterministic probe location for a service (the registry allows three). */
function statusLocationFor(service: string): "New York" | "Chicago" | "Los Angeles" {
  const options = ["New York", "Chicago", "Los Angeles"] as const;
  let weight = 0;
  for (const ch of service) {
    weight += ch.charCodeAt(0);
  }
  return options[weight % options.length];
}

/** Comma-joined paths of the logs that were read successfully. */
function joinedPaths(entries: CollectedLog[]): string {
  return entries.map((entry) => entry.path).join(", ");
}

/** Record one successfully read log, kept as a short recent-lines excerpt. */
function noteCollectedLog(into: CollectedLog[], path: string, contents: string): void {
  const tailRows = contents.split("\n").slice(-30);
  let excerpt = tailRows.join("\n");
  if (excerpt.length > 1600) {
    excerpt = excerpt.slice(excerpt.length - 1600);
  }
  into.push({ path, excerpt });
}

/** Record one unreadable log together with the reason it could not be read. */
function noteFailedLog(into: FailedLog[], path: string, error: unknown): void {
  into.push({
    path,
    reason: error instanceof Error ? error.message : String(error),
  });
}

/** Who gets woken up for a sev1/sev2, in words (for the reasoning trail). */
function escalationTargets(severity: "sev1" | "sev2"): string {
  return severity === "sev1"
    ? "the on-call channel AND the incident commander (simultaneously)"
    : "the on-call channel only";
}

/** Builds one escalation message for one audience — never assembled inline. */
function escalationMessage(
  severity: "sev1" | "sev2",
  incident: IncidentInput,
  audience: string,
  status: StatusProbe,
  logsRead: number,
  logsFailed: number,
): string {
  return [
    `[${severity.toUpperCase()}] ${incident.title} (${incident.id})`,
    `service: ${incident.service}`,
    `error rate: ${incident.errorRate}%`,
    `affected users: ${incident.affectedUsers}`,
    `evidence: ${logsRead} log file(s) parsed, ${logsFailed} unreadable`,
    `live status probe: ${status.temperature}C, ${status.conditions}, humidity ${status.humidity}%`,
    `audience: ${audience}`,
    "",
    "Acknowledge and join the response bridge.",
  ].join("\n");
}

/** One dated line for the sev3 tracker or the sev4 low-priority registry. */
function registryLine(level: "sev3" | "sev4", incident: IncidentInput): string {
  const stampedAt = new Date().toISOString();
  return `${stampedAt} ${level} ${incident.id} "${incident.title}" service=${incident.service} errorRate=${incident.errorRate}% affectedUsers=${incident.affectedUsers}`;
}

/** Append one line to accumulated file contents (tolerates missing newline). */
function withAppendedLine(existing: string, line: string): string {
  if (existing.length === 0) {
    return `${line}\n`;
  }
  return existing.endsWith("\n") ? `${existing}${line}\n` : `${existing}\n${line}\n`;
}

/** Full markdown timeline for incidents/<id>.md. */
function timelineMarkdown(
  incident: IncidentInput,
  severity: Severity,
  status: StatusProbe | null,
  collected: CollectedLog[],
  failed: FailedLog[],
): string {
  const lines: string[] = [
    `# Incident ${incident.id} — ${incident.title}`,
    "",
    `- service: ${incident.service}`,
    `- error rate: ${incident.errorRate}%`,
    `- affected users: ${incident.affectedUsers}`,
    `- severity: ${severity}`,
    `- recorded: ${new Date().toISOString()}`,
    "",
    "## Log evidence",
  ];
  if (collected.length === 0 && failed.length === 0) {
    lines.push("- none collected (triaged from the incident numbers alone)");
  }
  for (const entry of collected) {
    lines.push(`### ${entry.path}`, "", "```");
    for (const row of entry.excerpt.split("\n")) {
      lines.push(row);
    }
    lines.push("```", "");
  }
  for (const entry of failed) {
    lines.push(`- UNREADABLE — ${entry.path}: ${entry.reason}`);
  }
  lines.push("", "## Actions taken");
  if (severity === "sev4") {
    lines.push("- filed in incidents/low.log — below response threshold, nobody woken");
  } else if (severity === "sev3") {
    lines.push("- appended to incidents/tracked.log for deferred follow-up");
  } else if (severity === "sev2") {
    lines.push("- worked through three structured reasoning thoughts");
    lines.push("- on-call channel notified");
  } else {
    lines.push("- worked through three structured reasoning thoughts");
    lines.push("- on-call channel notified");
    lines.push("- incident commander briefed (dispatched simultaneously with the page)");
  }
  if (status !== null) {
    lines.push("", "## Structured status payload", `\`${JSON.stringify(status)}\``);
  }
  return lines.join("\n");
}

export default async function flow(input: IncidentInput, tools: Tools) {
  const incident = input;

  // 1 — classify first, from the incident numbers alone.
  const severity = classifySeverity(incident.errorRate, incident.affectedUsers);

  let logsRead = 0;
  let logsFailed = 0;

  // Every write below lands under incidents/, so make sure it exists.
  const incidentsDirReady = await tools.filesystem.createDirectory({ path: "incidents" });

  let status: StatusProbe | null = null;

  if (severity === "sev4") {
    // 2 — not worth waking anyone: register it and stop right there.
    let lowRegistry = "";
    try {
      const lowCurrent = await tools.filesystem.readTextFile({ path: "incidents/low.log" });
      lowRegistry = lowCurrent.content;
    } catch {
      // incidents/low.log does not exist yet — start it fresh.
    }
    const lowLine = registryLine("sev4", incident);
    const lowRegistered = withAppendedLine(lowRegistry, lowLine);
    const lowSaved = await tools.filesystem.writeFile({
      path: "incidents/low.log",
      content: lowRegistered,
    });

    const lowTimeline = timelineMarkdown(incident, "sev4", null, [], []);
    const lowTimelineSaved = await tools.filesystem.writeFile({
      path: `incidents/${incident.id}.md`,
      content: lowTimeline,
    });

    return { severity, logsRead, logsFailed };
  }

  // 3 — gather the three context pieces at the same time, not in sequence.
  const logFolder = logFolderOf(incident.logFilePaths);
  const statusLocation = statusLocationFor(incident.service);
  const [environment, structuredStatus, logFolderListing] = await Promise.all([
    tools.everything.getEnv({}),
    tools.everything.getStructuredContent({ location: statusLocation }),
    tools.filesystem.listDirectory({ path: logFolder }),
  ]);
  status = structuredStatus;

  // 4 — read every referenced log; one unreadable file never aborts the sweep.
  const collectedLogs: CollectedLog[] = [];
  const failedLogs: FailedLog[] = [];

  for (const logPath of incident.logFilePaths) {
    try {
      const logContents = await tools.filesystem.readTextFile({ path: logPath, tail: 300 });
      logsRead += 1;
      noteCollectedLog(collectedLogs, logPath, logContents.content);
    } catch (readError) {
      logsFailed += 1;
      noteFailedLog(failedLogs, logPath, readError);
    }
  }

  if (severity === "sev1" || severity === "sev2") {
    // 5 — reason through the collected context in three sequential
    // thoughts before acting on anything.
    const seenPaths = joinedPaths(collectedLogs);
    const targets = escalationTargets(severity);

    const situationAssessment = await tools.sequentialThinking.sequentialthinking({
      thought: `Situation: incident ${incident.id} "${incident.title}" on ${incident.service} — error rate ${incident.errorRate}%, ${incident.affectedUsers} users affected, classified ${severity}.`,
      thoughtNumber: 1,
      totalThoughts: 3,
      nextThoughtNeeded: true,
    });

    const evidenceReview = await tools.sequentialThinking.sequentialthinking({
      thought: `Evidence: logs read: ${seenPaths || "none"}; unreadable: ${logsFailed}. Environment captured for ${incident.service}; live status probe says ${status.conditions} at ${status.temperature}C.`,
      thoughtNumber: 2,
      totalThoughts: 3,
      nextThoughtNeeded: true,
    });

    const responseDecision = await tools.sequentialThinking.sequentialthinking({
      thought: `Response: escalate as ${severity}; notify ${targets}; then write the timeline for ${incident.id} and report ${logsRead} read / ${logsFailed} failed logs.`,
      thoughtNumber: 3,
      totalThoughts: 3,
      nextThoughtNeeded: false,
    });

    const outboxReady = await tools.filesystem.createDirectory({
      path: `incidents/outbox/${incident.id}`,
    });

    // 6 — escalation.
    if (severity === "sev1") {
      const onCallPage = escalationMessage(
        "sev1",
        incident,
        "the on-call channel",
        status,
        logsRead,
        logsFailed,
      );
      const commanderBrief = escalationMessage(
        "sev1",
        incident,
        "the incident commander",
        status,
        logsRead,
        logsFailed,
      );

      // TODO: the registry has no paging/notification tool yet, so these two
      // file drafts stand in for the real notification calls. Swap them for
      // the on-call channel notifier and the incident-commander notifier once
      // such tools are registered — they must keep firing together, exactly
      // as this Promise.all does.
      const [onCallNotified, commanderNotified] = await Promise.all([
        tools.filesystem.writeFile({
          path: `incidents/outbox/${incident.id}/on-call-channel.txt`,
          content: onCallPage,
        }),
        tools.filesystem.writeFile({
          path: `incidents/outbox/${incident.id}/incident-commander.txt`,
          content: commanderBrief,
        }),
      ]);
    } else {
      const onCallPage = escalationMessage(
        "sev2",
        incident,
        "the on-call channel",
        status,
        logsRead,
        logsFailed,
      );

      // TODO: the registry has no paging/notification tool yet, so this file
      // draft stands in for the real on-call channel notification. Swap it
      // for the proper notifier call once such a tool is registered.
      const onCallNotified = await tools.filesystem.writeFile({
        path: `incidents/outbox/${incident.id}/on-call-channel.txt`,
        content: onCallPage,
      });
    }
  } else {
    // sev3 — nobody gets woken: one dated line in the tracker.
    let trackedRegistry = "";
    try {
      const trackedCurrent = await tools.filesystem.readTextFile({ path: "incidents/tracked.log" });
      trackedRegistry = trackedCurrent.content;
    } catch {
      // incidents/tracked.log does not exist yet — start it fresh.
    }
    const trackedLine = registryLine("sev3", incident);
    const trackedEntry = withAppendedLine(trackedRegistry, trackedLine);
    const trackedSaved = await tools.filesystem.writeFile({
      path: "incidents/tracked.log",
      content: trackedEntry,
    });
  }

  // 7 — always close with the incident timeline.
  const timeline = timelineMarkdown(incident, severity, status, collectedLogs, failedLogs);
  const timelineSaved = await tools.filesystem.writeFile({
    path: `incidents/${incident.id}.md`,
    content: timeline,
  });

  // 8 — outcome of the response.
  return { severity, logsRead, logsFailed };
}
```

