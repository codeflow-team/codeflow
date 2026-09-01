# Generate → validate → run — `openrouter/free`

Round 1 of a planned 2. **The second round was not run**, and that is worth
stating rather than hiding: OpenRouter's free tier allows 50 requests a day, and
round 1 spent 24 of them across 7 generations — one call each plus up to two
static retries and two runtime retries. Finishing would have exhausted the day's
quota and left the demo's own AI features dead until midnight. Seven generations
answer the question this eval exists to ask.

Each intent is generated, validated, then **executed** against real MCP servers
over stdio, and the filesystem and memory are inspected afterwards — the verdict
is what the flow *did*, not what the transcript claimed.

| intent | level | worked first try | worked after feedback | static retries | runtime retries | total |
|---|---|---|---|---|---|---|
| csv-ledger | L2 | yes | yes | 2 | 0 | 141s |
| doc-freshness | L2 | no | no | 2 | 2 | 520s |
| memory-index | L2 | no | yes | 2 | 2 | 633s |
| resilient-reader | L1 | yes | yes | 2 | 0 | 180s |
| parallel-audit | L2 | yes | yes | 1 | 0 | 26s |
| batch-migrate | L2 | no | no | 2 | 2 | 161s |
| status-digest | L2 | yes | yes | 0 | 0 | 367s |

**Conformance: L1+ 7/7, L2 6/7. Delivery: 4/7 first try, 5/7 after feeding
the runtime error back.**

## What this says

Every generation was well-formed, honoured the flow contract and resolved every
name it used. Six of seven also projected to a clean graph. And **3 of 7 did
not do the job on the first attempt** — including flows that scored L2.

Two never did it at all, after two rounds of being handed their own runtime
error: `doc-freshness` and `batch-migrate`. Both are L2.

That ratio is not new and it is not this model's fault. The earlier eval in this
directory measured the same shape on `stealth/ox-alpha` — a different model, now
retired — and found L2 at 100% with half the flows failing to deliver. Two
unrelated models, the same gap. It is not a gap between good and bad models; it
is the gap between *"this is valid code that calls tools that exist"* and *"this
does what you asked"*, and no static score can close it.

Which is the argument for the diagram. A conformance level cannot tell a person
whether an automation does their job. Someone looking at the picture often can.
