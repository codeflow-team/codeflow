# Large-scale AI conformance — can the ladder survive a feature request?

`stealth/ox-alpha` via OpenRouter · `max_tokens` 48000 · target L2 · max 2 retries
· eval version 1 · harness `packages/mcp/test/ai/large-scale-suite.ts`,
runner `packages/mcp/scripts/large-scale-eval.mjs`.

The existing evals ask for 20–40 line flows and report 12/12 L2. This one asks for
**feature-sized flows**: seven product briefs, each written the way a PM writes a
ticket (numbered requirements, edge cases, an explicit result), each needing
150–400 lines, against **scoped registries of real MCP tools** (18–38 tools drawn
from the 65 captured in `packages/mcp/test/real-schemas/`). Every intent mounts
only the servers its brief names, so a tool the model invents fails L1 instead of
resolving by accident (10 §4).

Three arms were run, raw data alongside this file:

| Arm | File | Prompt | Generations |
| --- | --- | --- | --- |
| **baseline** | `large-scale-summary-baseline.md` | style guide rules 1–9 | 7 intents × 2 |
| **after fix** | `large-scale-summary-after-fix.md` | + style rule 10 | 7 intents × 1 |
| **no examples** | `large-scale-summary-no-examples.md` | + rule 10, few-shot **off** | 7 intents × 1 |

## 1. Headline

| Arm | round-0 L2 | final L2 | model calls per accepted flow | `inline-logic-in-code-node` |
| --- | --- | --- | --- | --- |
| baseline | **0/14 (0%)** | 14/14 | 2.29 | 61 |
| after fix | **7/7 (100%)** | 7/7 | **1.00** | **0** |
| no examples | 6/7 (86%) | 7/7 | 1.14 | 1 |

**L0 and L1 were 100% in every arm, first round, every time.** Across 47 model
calls there was not one parse error, not one broken flow contract, not one
invented tool, not one bad import, not one `unknown` node. The model reads a
20–38 tool `tools.d.ts` written by someone else and never makes anything up.

**L2 is where scale bit.** At 20–40 lines the model reached L2 unaided 12/12
times; at 150–400 lines it reached it **0/14**. The retry loop of 10 §5 always
recovered it — every one of the 14 baseline generations ended at L2 — but that
costs a second and sometimes a third model call, at 200–500 s each.

The cause turned out to be a single missing sentence in the style guide (§4), and
adding it took round-0 L2 from 0/14 to 7/7.

## 2. Size actually reached

Per intent, after-fix arm, single round:

| Intent | Tools | Prompt (tok) | Lines (asked) | Nodes | Edges | Tool nodes | Code nodes | Meaningful | Max nesting | Time | Completion tok |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| repo-triage-bot | 23 | 3 912 | 250 (180) | 56 | 120 | 13 | 6 | 89% | 4 | 255 s | 9 409 |
| research-pipeline | 28 | 5 695 | 170 (200) | 38 | 81 | 13 | 4 | 89% | 2 | 474 s | 11 537 |
| browser-qa-suite | 38 | 4 508 | 142 (220) | 39 | 84 | 11 | 6 | 85% | 6 | 290 s | 13 124 |
| incident-responder | 28 | 4 872 | 300 (170) | 50 | 121 | 12 | 7 | 86% | 2 | 387 s | 14 217 |
| data-migration | 23 | 3 912 | 228 (190) | 44 | 101 | 7 | 6 | 86% | 3 | 338 s | 13 062 |
| knowledge-base-sync | 27 | 4 801 | 344 (170) | 64 | 139 | 6 | 16 | 75% | 4 | 421 s | 13 317 |
| dependency-audit | 18 | 5 032 | 311 (160) | 53 | 107 | 11 | 5 | 91% | 4 | 348 s | 13 205 |

Read across the three arms (`lines/nodes/first→final/retries`, two runs shown for
the baseline):

| Intent | baseline | after fix | no examples |
| --- | --- | --- | --- |
| repo-triage-bot | 258L/52n/L1→L2/1r · 270L/61n/L1→L2/1r | 250L/56n/L2→L2/0r | 312L/61n/L2→L2/0r |
| research-pipeline | 154L/31n/L1→L2/2r · 223L/42n/L1→L2/1r | 170L/38n/L2→L2/0r | 227L/41n/L2→L2/0r |
| browser-qa-suite | 154L/42n/L1→L2/1r · 131L/38n/L1→L2/1r | 142L/39n/L2→L2/0r | 153L/35n/L2→L2/0r |
| incident-responder | 240L/50n/L1→L2/2r · 309L/56n/L1→L2/1r | 300L/50n/L2→L2/0r | 363L/60n/L2→L2/0r |
| data-migration | 264L/58n/L1→L2/1r · 217L/47n/L1→L2/1r | 228L/44n/L2→L2/0r | 246L/52n/L2→L2/0r |
| knowledge-base-sync | 319L/51n/L1→L2/2r · 237L/54n/L1→L2/2r | 344L/64n/L2→L2/0r | 337L/59n/L1→L2/1r |
| dependency-audit | 295L/45n/L1→L2/1r · 289L/53n/L1→L2/1r | 311L/53n/L2→L2/0r | 483L/65n/L2→L2/0r |

Scale is real, not claimed: 131–483 lines, 31–65 nodes, 64–139 edges, containers
nested up to 7 deep. The model **over-delivers on the small briefs and
under-delivers on the biggest one** — `dependency-audit` asked for ~160 lines and
got 311; `browser-qa-suite` asked for ~220 and got 142, dropping the "resize the
viewport once" step and collapsing two of the three step kinds. Length tracks how
much *branching* a brief implies, not how many words it contains.

Run-to-run spread on the same brief is ±20% of lines and ±20% of nodes; the level
reached was identical across repeats in all 7 intents.

## 3. What actually breaks

Every diagnostic emitted across all 47 rounds of all three arms, by code:

| Diagnostic | Baseline | After fix | No examples |
| --- | --- | --- | --- |
| `info/unsupported-construct` (one per code node — not a defect) | 283 | 50 | 73 |
| `warning/inline-logic-in-code-node` | **61** | **0** | 1 |
| everything else (`parse-error`, `invalid-flow-contract`, `unresolved-tool`, `hidden-call-in-expression`, `foreign-value-import`, `invalid-import`, `unbounded-loop-risk`) | 0 | 0 | 0 |

One failure mode, and only one. Classifying all 61 baseline occurrences by what
the code node contained:

| What is in the code node | Count | Real example from the run |
| --- | --- | --- |
| `xs.push(…)` — accumulating a result | **34 (56%)** | `failures.push({ repository, manifest: manifestPath, reason: String(error) })` |
| a named helper called inside a bigger expression | 11 | `const evidenceFile = \`qa-artifacts/${artifactSlug(scenario.name)}-final-snapshot.yaml\`;` |
| a `.map`/`.filter`/`.reduce` chain | 7 | `knowledgeGraph.entities.filter((entity) => entity.entityType === "triaged-file")` |
| `new X()` | 5 | `const alreadyTriaged = new Set<string>();` |
| a global (`JSON.stringify`, `encodeURIComponent`) | 3 | `JSON.stringify(serviceStatus)` |
| `Map`/`Set` mutation | 1 | `alreadyTriaged.add(filePath)` |

Two more shapes of the same mistake, both real:

```ts
scenarioPassed = pageContains(finalSnapshot.content, scenario.expectedText);  // call into an outer `let`
errorLog += `[${runName}] failed to read ${filePath}: ${describeError(readError)}\n`;
```

None of these hide a *tool* call. They hide a **step**: "record the failure",
"derive the screenshot path", "test the page". The flow is correct and runs; the
graph just does not show those steps, which is exactly what L2 measures.

Why it only appears at scale: a 30-line flow has nothing to accumulate. A
200-line flow that processes a batch, counts successes and failures, and writes a
report at the end is *made of* accumulation — and the style guide said nothing
about it.

## 4. The fix, and before/after

`packages/core/src/generation/prompts.ts` — one new style rule (01 §3 rule 10) and
one line added to the shipped resilience example.

> **A call in a plain statement is a hidden step too** — the mistake long flows
> make most. Statements outside the table become code nodes; plain data there is
> fine (`failed += 1;`, `const found: Item[] = [];`), a **call** is not:
> `failures.push({ path, reason })`, ``const f = `out/${slugOf(name)}.png` ``,
> `const stamp = new Date().toISOString()`, `passed = matches(text)` all vanish
> into code nodes. Declare a **named function in the same file** and give each its
> own statement — `recordFailure(failures, path, reason);`,
> `const f = shotPath(name);`, `const stamp = startedAt();`,
> `const ok = matches(text); passed = ok;` — each is then a function node.

Verified deterministically before running anything (now a test in
`packages/mcp/test/ai/large-scale.test.ts`):

| Written as | Level | Graph |
| --- | --- | --- |
| `failures.push(path + String(error));` | L1 | code node, step invisible |
| `recordFailure(failures, path, String(error));` | **L2** | **function node** |
| ``const out = `dir/${slugOf(path)}.txt`;`` | L1 | code node |
| `const slug = slugOf(path);` then use `${slug}` | **L2** | **function node** |
| `const stamp = new Date().toISOString();` | L1 | code node |
| `const stamp = startedAt();` | **L2** | **function node** |
| `bad = looksBad(path);` | L1 | code node |
| `const isBad = looksBad(path); bad = isBad;` | **L2** | **function node** |

Live before/after, same 7 briefs, same model, same settings:

| | baseline | after fix | change |
| --- | --- | --- | --- |
| round-0 L2 | 0/14 | 7/7 | **0% → 100%** |
| model calls per accepted flow | 2.29 | 1.00 | **−56%** |
| `inline-logic-in-code-node` | 61 | 0 | **−100%** |
| avg lines | 240 | 249 | +4% |
| avg nodes | 48.6 | 49.1 | +1% |
| avg code nodes | 8.1 | 7.1 | −12% |
| avg meaningful-node ratio | 84% | 86% | +2 pts |

The model picked the rule up literally — from the after-fix `repo-triage-bot`:

```ts
function tally(counts: SeverityCounts, severity: Severity): void {
  counts[severity] += 1;
}
function noteHigh(paths: string[], path: string): void {
  paths.push(path);
}
```

Note the cost: core's own budget test (10 §4 — `estimatedTokens < 2000` for a
small registry with examples on) went from passing comfortably to passing by a
couple of tokens, and rule 10 had to be compressed three times to fit under it.
**There is effectively no headroom left in the style guide** — the next rule
someone wants to add needs that budget re-examined, not squeezed again.

## 5. Do few-shot examples still matter at this scale?

The earlier small-scale finding was that examples are not necessary (6/6 L2 with
them off). At feature scale, with rule 10 in place:

| | examples on | examples off |
| --- | --- | --- |
| round-0 L2 | 7/7 | 6/7 |
| model calls per accepted flow | 1.00 | 1.14 |
| avg lines | 249 | 303 |
| avg nodes | 49 | 53 |
| avg code nodes | 7.1 | 8.3 |
| avg meaningful ratio | 86% | 85% |
| avg completion tokens per call | 12 553 | 14 521 |

Examples still are not *necessary* — 6/7 first-shot L2 without them. What they buy
is **restraint**: without examples the model writes 22% more code for the same
briefs (`dependency-audit` 311 → 483 lines) and 16% more completion tokens, and
the one regression (`knowledge-base-sync`, L1 → needed a retry) came from that
extra sprawl. At scale the examples are a length and consistency anchor rather
than a correctness aid.

## 6. Construct coverage — and one thing the briefs got wrong

Constructs each brief was designed to require, measured on the **graph** (a `try`
the analyzer could not project is not a `try` the reader gets):

- baseline 90/98 (92%), after fix 45/49 (92%), no examples 45/49 (92%).
- Consistently present: `loop`, `nested-loop`, `while-loop` (with a bound —
  zero `unbounded-loop-risk` warnings in 47 rounds), `try`, `parallel`, `jump`
  (`break`/`continue`), `function`, `condition`.
- Consistently missing: `else-if-chain` (2/7), `nested-loop` in
  `research-pipeline` (1/7), `early-return` in `browser-qa-suite` (1/7).

The `else-if-chain` misses are **not a model failure — the expectation was wrong**.
The briefs describe a multi-level classification ("critical when… warning when…
info otherwise"), and the model does what style rule 4 tells it to:

```ts
function gradeFinding(manifest: string, dependency: string): Grade {
  if (pinnedVersionBelowOne(manifest, dependency)) return "critical";
  if (appearsInDirectDependencies(manifest, dependency)) return "warning";
  return "info";
}
```

Worth flagging as a product tension rather than a bug: rule 4 raises the
conformance level *and* hides the decision tree behind one function node. A
non-developer looking at that graph sees "Grade finding" and cannot see the
thresholds. If the severity rules are the thing the user most wants to inspect
and edit, the style guide is currently pointing the model away from showing them.

## 7. Where the model is still weak

1. **First-shot L2 is fragile against anything the style guide has not named.**
   The ladder held at 100% for L0/L1 and collapsed to 0% for L2 on one unlisted
   idiom. The lesson generalises: L2 is a function of style-guide coverage, and
   feature-scale code exercises idioms that small-scale prompts never reach.
2. **Coverage of a long brief degrades silently.** `browser-qa-suite` scored a
   clean L2 at 142 lines while quietly dropping requirement 1 (viewport resize)
   and flattening the step-kind dispatch. Nothing in L0/L1/L2 measures "did it
   build what was asked" — the level and the line count have to be read together,
   which is why this harness records both.
3. **Latency and cost are the real ceiling.** 198–391 s per call, 9 000–14 500
   completion tokens. At baseline, 2.29 calls per accepted flow meant ~8 minutes
   of wall clock per flow; the fix cut that to ~6 minutes for one call. An
   interactive "generate my flow" button is not viable at this size without
   streaming.
4. **Provider instability at this size.** One intent returned `content: null`
   with `finish_reason: "stop"` on four consecutive attempts, and one request hung
   with no response and no error. Both are handled in the harness (retries with
   backoff to 60 s, a 20-minute per-attempt `AbortSignal.timeout`), but a host
   generating flows this large needs both.

## 8. No CodeFlow bug found

47 model calls, 11 597 lines of model-written flow code analyzed. Every
diagnostic CodeFlow raised was correct, and every one was actionable enough that
the model fixed it in a single round. `validate` never scored a good flow badly:
the 61 `inline-logic-in-code-node` warnings were all genuinely calls hidden from
the graph, and the accumulator idiom really does become a readable node when
extracted. The one change made is to the *guidance* (prompts), not to the
analyzer or the ladder.

## Reproducing

```bash
pnpm build
node packages/mcp/scripts/large-scale-eval.mjs --dry                 # context sizing, no tokens
node packages/mcp/scripts/large-scale-eval.mjs --repeat 2 --label myrun
node packages/mcp/scripts/large-scale-eval.mjs --no-examples --label no-examples
node packages/mcp/scripts/large-scale-eval.mjs --label all --merge a.json,b.json
```

A run is shardable by `--intent` (a feature-sized generation takes 3–11 minutes);
finished intents are checkpointed to `checkpoint-<label>-large.json` as they land,
and `--merge` stitches shards into one report. `packages/mcp/test/ai/large-scale.test.ts`
asserts the harness offline on every `vitest run`, and runs one live generation
when `OPENROUTER_API_KEY` is set.
