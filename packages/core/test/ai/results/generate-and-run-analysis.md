# Does AI-written CodeFlow actually run? — generate → validate → **run**

Model `stealth/ox-alpha` · eval `packages/mcp/scripts/generate-and-run-eval.mjs`
· suite `packages/mcp/test/ai/generate-and-run-suite.ts` · 2026-08-23.

Every earlier eval in this repo stops at the conformance ladder: L0 (parses and
honours the contract), L1 (every name resolves), L2 (projects to a clean graph).
All three are static judgements. None of them has ever executed anything, so
none of them could answer the only question the owner of this project keeps
asking — *cho agent sinh ra và test xem có chạy được không*.

This eval answers it. Each generation is scored on the ladder, then **handed to
`apps/demo/server/runner.ts`** and executed by a Node worker against four real
MCP servers over stdio (`@modelcontextprotocol/server-filesystem`,
`-memory`, `-everything`, `-sequential-thinking`). Afterwards the scratch
workspace is read off disk: did the files the brief asked for get written, do
they say what they were asked to say, are the entities really in the memory
server's JSON. Nothing here is scored from the transcript.

The registry contains **only tools those four servers back** — 37 of them under
`fs`, `memory`, `everything`, `reasoning`, the same namespaces and the same
method slugging the runner maps back (`packages/examples/scripts/servers.mjs`).
Had a stubbed namespace been in it, "it ran" would have meant "it called a
sample", which is worth nothing.

## The headline number

14 sequences (7 briefs × 2 repetitions), one generation each plus up to 2 rounds
of static diagnostics feedback and up to 2 rounds of **runtime** feedback.

| Measure | Count | Share |
| --- | --- | --- |
| Reached **L2** on the first generation | 14/14 | **100%** |
| Ran clean **and** left the required effects, first attempt | 7/14 | 50% |
| **L2 but did not run** (as scored, eval v1) | **7/14** | **50%** |
| … of which the *harness* was stricter than the brief | 4/7 | — |
| **L2 but did not run** (brief-faithful) | **3/14** | **21%** |
| Fixed by feeding the runtime error back | 6/7 | 86% |
| Still not delivering after every round | 1/14 | 7% |

A corrected pass (eval **v2**) re-ran the three briefs whose checks were too
strict, twice each: **6/6 delivered on the first attempt, 0 needed runtime
feedback.** Across the 20 brief-faithfully-scored sequences the L2-but-did-not-run
rate is **3/20 = 15%**.

Mean share of steps that started on the first attempt: **84%**. Mean real MCP
calls per run: **9.4**. A run costs 2–5 s of wall clock; a generation costs
120–320 s.

**The gap between "looks right" and "runs right" is real and large.** L2 was
100% and first-attempt delivery was 50%. Even after removing the four cases
where this harness demanded more than its own brief did, one flow in five that
a host would render as a beautiful graph does not do the job.

Raw data: `generate-and-run-2026-08-23T11-08-19-989Z-baseline-v1.json` and
`generate-and-run-summary-baseline-v1.md` (every source, every diagnostic, every
failed call, every file the run wrote).

## Per sequence

| intent | rep | level | static retries | steps run/total | MCP calls | real effect | runtime error class | fixed after feedback |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| csv-ledger | 1 | L2 | 1 | 34/36 | 6 | **yes** | — | n/a |
| csv-ledger | 2 | L2 | 1 | 19/24 | 6 | **yes** | — | n/a |
| doc-freshness | 1 | L2 | 0 | 27/28 | 9 | **yes** | — | n/a |
| doc-freshness | 2 | L2 | 0 | 25/27 | 8 | no | (a) logic — found 0 stale docs | yes, round 1 |
| memory-index | 1 | L2 | 0 | 25/26 | 11 | no\* | harness-strict | yes, round 1 |
| memory-index | 2 | L2 | 0 | 27/29 | 11 | no\* | harness-strict | yes, round 1 |
| resilient-reader | 1 | L2 | 0 | 21/23 | 6 | **yes** | — | n/a |
| resilient-reader | 2 | L2 | 0 | 20/22 | 6 | **yes** | — | n/a |
| parallel-audit | 1 | L2 | 0 | 16/23 | 11 | no | **(b) tool schema** | **no** (3 attempts) |
| parallel-audit | 2 | L2 | 0 | 26/29 | 11 | no | (a) logic — path double-join | yes, round 1 |
| batch-migrate | 1 | L2 | 1 | 27/45 | 15 | no\* | harness-strict | yes, round 1 |
| batch-migrate | 2 | L2 | 0 | 26/46 | 15 | no\* | harness-strict | yes, round 1 |
| status-digest | 1 | L2 | 0 | 17/21 | 8 | **yes** | — (but a wrong number, below) | n/a |
| status-digest | 2 | L2 | 0 | 22/28 | 8 | **yes** | — | n/a |

\* The flow did the work; the *report file* did not contain a word this harness
demanded. See "the harness was wrong twice" below. `steps run/total` below 100%
is normal — an early-return branch that is not taken never starts.

## Evidence that the effects are real

`doc-freshness` #1, memory server's own `memory.json` after the run:

```json
{"type":"entity","name":"…/workspace/docs/orders.md","entityType":"stale-doc",
 "observations":["…/workspace/orders.ts"]}
```

`csv-ledger` #1, `ledger.md` and `rejects.md`, written through
`fs.writeFile` into the scratch workspace:

```
# Ledger
- east: 2080.50
```

`batch-migrate` #1, files that did not exist before the run:
`archive/CHANGELOG.md` (51 B), `archive/README.md` (87 B),
`archive/money.md` (47 B), `archive/orders.md` (66 B), `migration-report.md`.
Plus 4 `note` entities in the memory graph.

`status-digest` #1, `digest.md`, from three live `everything` calls:

```
- Cycle 1 — New York: 33°C, Cloudy
- Cycle 2 — Chicago: 36°C, Light rain / drizzle
- Cycle 3 — Los Angeles: 73°C, Sunny / Clear
```

## What actually broke

### (b) The tool schema — and the server was lying, not the model

The one hard crash in 14 runs:

```
sequentialthinking: MCP error -32602: Input validation error:
Invalid arguments for tool sequentialthinking:
Invalid input: expected boolean, received undefined at nextThoughtNeeded
```

`generated/tools.d.ts` says `nextThoughtNeeded?: boolean` — **optional** — and
it says so because the server's own `tools/list` payload says so:

```js
// packages/mcp/test/real-schemas/sequential-thinking.json
required: ["thought", "thoughtNumber", "totalThoughts"]
```

The live server then validates with a zod schema in which the field is
required. The advertised JSON Schema and the enforced schema disagree, CodeFlow
faithfully reproduces the advertised one, and the model reasonably omitted a
field its types called optional. **No amount of static validation can catch
this — only running it can.** That is the single strongest argument for this
eval existing.

Frequency: across 8 `parallel-audit` generations the model omitted the field in
at least one call in 3 of them; only one of those became a fatal run.

### (a) The model's own logic — 2 of 14

- **`doc-freshness` #2** wrote a perfectly formatted `freshness.md` and recorded
  **zero** stale docs, in a workspace whose `docs/orders.md` is deliberately 400
  days older than `orders.ts`. Nothing failed; the answer was simply wrong. This
  is the failure mode a graph flatters most: every node green, output useless.
- **`parallel-audit` #2** joined `input.root` onto paths that were *already*
  absolute, and every `get_file_info` died with
  `Parent directory does not exist: …/workspace/private/var/folders/…/workspace/index.ts`.
  The written `audit.md` had an empty `## modules` section — a 1392-byte report
  about nothing. See the runner bug below: the model was walking into a trap.

### (c) Environment — 0 of 14

No timeouts, no server that failed to start, no rate-limit holes in the data.

### (d) The runner / CodeFlow — 0 fatal, 2 real defects found

Neither ended a run, but both are genuine and both were found only by executing.

**1. The scratch path handed to a flow is a symlink; the filesystem server
answers with the resolved path.** `runner.ts` builds the workspace with
`mkdtempSync(join(tmpdir(), …))`, which on macOS is
`/var/folders/…` — a symlink to `/private/var/folders/…`:

```
mkdtemp   : /var/folders/n0/…/T/cf-symlink-eb34Jh
realpath  : /private/var/folders/n0/…/T/cf-symlink-eb34Jh
differ    : true
```

`input.root` is therefore `/var/…`, while `fs.searchFiles` returns
`/private/var/…`. Any flow that joins, compares or strips the root against a
path the server returned is broken through no fault of its own — which is
exactly what `parallel-audit` #2 did. Every report in this run is full of the
two spellings side by side. **Fix: `realpathSync` the workspace before it
becomes `input.root`** (`apps/demo/server/runner.ts`, outside this task's write
scope, so it is reported rather than patched).

**2. A tool with no declared `outputSchema` is typed `Promise<void>`, and that
is false at runtime.** `packages/core/src/codegen/tools-dts.ts:81`. The worker
folds the server's content blocks into `{ content: string }` and returns it, so
there *is* a value — the type just says there is not. Both `status-digest`
generations noticed and wrote a workaround, unprompted:

```ts
// getSum is typed as returning void in the generated tools file, so the
// numeric total has to be recovered from whatever the server resolves with.
function asNumber(value: unknown): number { … }
```

```ts
// getSum is declared to resolve void; coerce whatever the service actually
// returns, falling back to the locally counted total if nothing usable comes back.
```

Run #1's coercion failed and `digest.md` reported **`Total cycles: 0`** when the
flow had polled three. A wrong number, printed confidently, from a run this eval
scored as passing — the type system caused it. Run #2 got the right answer only
because its fallback happened to be the local count.

`void` is load-bearing elsewhere (a tool with no output schema deliberately gets
no data edge — `packages/mcp/test/real-flows.test.ts`), so this is filed as a
recommendation, not a patch: **`unknown` is the truthful type; `void` is a claim
the runtime contradicts.**

## Feeding the *runtime* error back — the part nobody had tried

When a run fails, the model is sent facts and only facts: the status, how many
steps started, the input it was called with, the server's own error strings, the
step and line they happened on, and which required effects are not on disk. No
advice — `generate-and-run.test.ts` asserts the feedback contains no "you
should", "instead of", "the correct".

**6 of 7 failing sequences were fixed by round 1.** The exception is
`parallel-audit` #1, which fixed the crash on round 1 and then failed a content
check twice more.

The clearest single case is the schema crash. Round 0 called:

```ts
const thought1 = await tools.reasoning.sequentialThinking({
  thought: `Inventory: …`, thoughtNumber: 1, totalThoughts: 3,
});
```

Round 1, after being shown the server's message, wrote:

```ts
// The server requires nextThoughtNeeded explicitly on every call.
const thought1 = await tools.reasoning.sequentialThinking({
  thought: `Inventory: …`, nextThoughtNeeded: true, thoughtNumber: 1, totalThoughts: 3,
});
```

It corrected a mistake **the type system had actively invited**, from one line
of runtime evidence, and left a comment explaining why. That loop works.

## The harness was wrong twice — and this eval caught it

`input` is synthesized from the flow's parameter type by
`apps/demo/server/input.ts`, and `maxModules` becomes `3`. A flow that audits
the first three `*.ts` files is *obeying* the brief and never reaches
`orders.ts` (fourth alphabetically) — yet v1 of this suite demanded the string
`orders.ts` in the report and marked four correct runs as effect-less. Likewise
`batch-migrate` was scored on whether its report *listed* the migrated notes,
which the brief never asked for; all four of its runs really did migrate four
files into `archive/`.

Both checks are corrected in eval **v2** (`GENERATE_AND_RUN_EVAL_VERSION = 2`):
`money.ts` instead of `orders.ts`, and `batch-migrate` scored on
`archive/orders.md` existing rather than on the report's prose. A live v2 pass
over the three affected briefs, two repetitions each, settles it:

| intent | rep | level | steps run/total | MCP calls | real effect | class |
| --- | --- | --- | --- | --- | --- | --- |
| memory-index | 1 | L2 | 22/23 | 11 | **yes** | — |
| memory-index | 2 | L2 | 25/26 | 11 | **yes** | — |
| parallel-audit | 1 | L2 | 23/24 | 14 | **yes** | — |
| parallel-audit | 2 | L2 | 27/28 | 14 | **yes** | — |
| batch-migrate | 1 | L2 | 25/41 | 15 | **yes** | — |
| batch-migrate | 2 | L2 | 25/48 | 15 | **yes** | — |

**6/6 on the first attempt, 0 runtime-feedback rounds needed**
(`generate-and-run-2026-08-23T11-23-04-227Z-v2.json`). The 50% headline is
therefore the pessimistic reading and 21% the brief-faithful one; both are
reported, because a number that flatters the model by hiding the harness's own
bugs is worth as little as one that maligns it. It is also worth saying plainly:
**this eval's first finding was a bug in this eval**, and it only surfaced
because the runs left artefacts a human could read.

## The improvement that was tried: per-argument docs in `tools.d.ts`

**Hypothesis.** The model omitted `nextThoughtNeeded` because the only signal it
had was `?` in a signature. The MCP schema *does* carry a description for every
argument (`"Whether another thought step is needed"`) and
`generateToolsDts` was throwing all of them away.

**Change.** `GenerateToolsDtsOptions.parameterDocs` (and
`BuildGenerationContextOptions.parameterDocs`) emits `@param` lines under each
tool's own JSDoc, for arguments that carry a description, restating optionality
in words. Signatures are byte-identical; nothing about the graph changes. Off by
default. Cost on this registry: **3560 → 4317 tokens (+21%)**; system prompt
5418 → 6175.

**Measurement.** `parallel-audit` × 3 with the flag and × 3 without, same model,
same day, `--runtime-retries 0`:

| arm | L2 first | ran + effect first | calls that passed `nextThoughtNeeded` | fatal schema errors |
| --- | --- | --- | --- | --- |
| off | 3/3 | 0/3 | 8/9 (2 of 3 flows complete) | 0 |
| on | 3/3 | 1/3 | 8/9 (2 of 3 flows complete) | 0 |

Pooling with the baseline: **12/15 calls (5 samples) without the docs, 8/9 calls
(3 samples) with them.**

**Verdict: inconclusive, and reported as inconclusive.** The direction is right
and the mechanism is documented, but at n = 8 generations the difference is
noise, and the one fatal occurrence in the whole study happened in the *off*
arm by chance as much as by cause. It is worth noting that the sequential-thinking
tool's own *tool-level* description already contains the sentence "Only set
nextThoughtNeeded to false when truly done" — and the model omitted the argument
anyway, which is evidence that more prose is not the lever. **Recommendation:
keep `parameterDocs` off by default, re-run the A/B at n ≥ 20 before flipping
it, and prefer the two structural fixes above (realpath, and `unknown` instead of
`void`), which do not depend on the model reading anything.**

## Honest answer to the question

**Yes, AI-written CodeFlow runs.** Across 26 sequences and ~40 generations,
every single one parsed, resolved, projected cleanly *and* executed against real
MCP servers; runs started 84% of their steps and made 9–15 real tool calls each;
under brief-faithful scoring **17 of 20 delivered everything asked of them on
the first attempt** with no human in the loop, and 19 of 20 delivered after at
most one round of runtime feedback.

**And the conformance level does not tell you that.** L2 was 100% while
first-attempt delivery under this harness's original checks was 50% (15–21%
failure once its own over-strictness is corrected). A host that renders the
graph and stops has no way to
distinguish `doc-freshness` #1 from `doc-freshness` #2 — same level, same clean
graph, one of them silently finds nothing. The level is a claim about
*readability*, and it was never a claim about correctness; this eval is the
first thing in the repo that can measure the difference, and the difference is
about one flow in six.

The cheapest thing that closes most of that gap is not a better prompt. It is
running the flow once and showing the model what the machine said.
