# 11 — Testing & Correctness Goals

## 1. Goal: what "the final output is correct" means

CodeFlow's trust model: **a non-developer user does not read the code — they look at the graph and believe it**. The whole product holds up if and only if these three outputs are correct:

| Output | What "correct" means |
|---|---|
| **O1 — Graph** | The graph is a faithful reflection of the code: no step of the flow is missing from the graph, and no node says one thing while the code does another |
| **O2 — Code after an edit** | Exactly what the user did in the UI, and **only** that region changed — every other character is untouched |
| **O3 — AI-generated code** | Valid under the contract (L0), fully resolving (L1), mapping well (L2) — [10-ai-codegen.md](10-ai-codegen.md) §5 |

The most dangerous failure is **the graph says A while the code does B** — a user approving a flow they have misunderstood. Hence the principle running through everything: showing a code/unknown node (the user knows they do not know) is better than mapping something wrongly (invariant I6). Every test layer below exists to protect O1–O3.

## 2. Correctness invariants

These must hold in all cases. Each invariant has a corresponding test, and violating one is a serious bug:

- **I1 — Faithful projection**: every statement in the flow body belongs to exactly one node (full coverage, nothing skipped); synthetic nodes (merge…) share source ranges according to the rule in [03-data-model.md](03-data-model.md) §4. Every side-effecting call in the flow body either **appears as its own node** or sits inside an **opaque `code` node with a diagnostic** ([04-analyzer.md](04-analyzer.md) §1.4) — it is never swallowed into the expression text of a "pretty" semantic node (condition/parallel) without a trace.
- **I2 — Determinism (cold analyze)**: the same (source, registry) → the same graph, node IDs included, when analyzing without a previous graph ([03-data-model.md](03-data-model.md) §5.0). Within a session, ids are carried across by resolution (continuity), so a session id is allowed to differ from the cold-analyze id; fixtures compare on the cold path.
- **I3 — Patch minimality**: a patch touches only the node's source region and only the edited element; every character outside that region is preserved **byte-for-byte** (whitespace and comments included).
- **I4 — Round-trip stability**: an empty edit → the source does not change by one byte; `analyze(patch(analyze(s), e))` → the graph differs only in the edited part; running the loop again → stable (idempotent).
- **I5 — Identity stability, no mis-binding**: node ids survive reformatting, unrelated code being added, and patches produced by CodeFlow itself; and in particular an old id is **never** assigned to a different node in the identical-sibling-insertion scenario ([03-data-model.md](03-data-model.md) §5.2).
- **I6 — Graceful degradation**: when unsure → a `code`/`unknown` node + a diagnostic. **Never** map a construct to a semantically wrong node.
- **I7 — No execution**: core never executes the input code — enforced by a lint rule (no `eval`, no `new Function`, no dynamic import of user source inside core) plus a test.

## 3. Test layers

```text
6. AI conformance evals            (periodic, does not block CI)
5. UI e2e — Claude in Chrome       (on PRs touching the UI)
4. Round-trip suite            ┐
3. Property-based tests        │ must be green
2. Golden fixture corpus       │ on every PR
1. Unit tests                  ┘
```

### 3.1 Unit tests (Vitest)

Per module: parser, analyzer, mapper, patcher, registry codegen. Fast, narrow, run on every save.

### 3.2 Golden fixture corpus — the backbone

Each case is a self-contained directory:

```text
fixtures/<case-name>/
├── input.flow.ts          # the input flow code
├── registry.json          # tools + library functions — DECLARATIVE (JSON):
│                          #   it cannot carry analyzer/patcher/renderer hooks;
│                          #   plugin hooks are tested at the unit layer (in code),
│                          #   not in the corpus
├── expected-graph.json    # the expected graph (a REVIEWED snapshot, never a blind one)
└── edits/                 # the edits applied to this case
    ├── change-channel.edit.json
    └── change-channel.expected.diff   # the expected diff, character-exact
```

The corpus must cover:

- every supported construct, standing on its own;
- nested combinations (if inside for, parallel inside if…);
- nasty edge cases: two identical calls in the same scope, odd comments/formatting, unicode in strings, complex template literals, shorthand arguments;
- the degradation cases: unsupported constructs, unresolvable tools, unfamiliar imports.

### 3.3 Property-based tests (fast-check)

Generate random **irrelevant** transformations (reformatting, inserting independent statements, changing comments) over the fixtures → assert I2/I5 (equivalent graph, identity preserved). Generate random valid edits → assert I3/I4. Property tests catch the combinations hand-written fixtures never think of.

### 3.4 Round-trip suite — the most important gate

For **every fixture × every editable field**: edit → patch → re-analyze → assert:

1. the diff equals the expected one exactly, with no extra character;
2. the new graph differs only in the edited node; every other node keeps its id;
3. running the loop again on the new source → stable.

This is the MVP acceptance criteria ([08-mvp.md](08-mvp.md) §4) in automated form.

### 3.5 UI e2e (Claude in Chrome — agent-driven)

The UI is tested with **Claude in Chrome** driving a real browser instead of a Playwright script: each test case is a described scenario (a checklist of steps + expected results), the agent executes it against the demo app, takes screenshots, compares the results, and reports pass/fail with evidence.

Scenarios cover: inspector edit → the code changes correctly; a code edit in Monaco → the graph changes correctly; select a node ↔ highlight the source; an unsupported operation → a clear message; the conflict flow; palette insertion (including the "needs configuration" path).

The accepted trade-off: agent-driven testing is slower and more expensive than a script, in exchange for scenarios written in natural language (easy to add and change) that catch UX problems a selector-based script misses (an obscured element, broken layout, confusing wording). That is why this layer runs from a checklist on PRs that touch the UI rather than on every commit; the correctness of core logic is carried entirely by layers 1–4 (deterministic and cheap).

### 3.6 AI conformance evals

A fixed, versioned set of intent prompts × N generations through a real LLM → measure the L0/L1/L2 rate ([10-ai-codegen.md](10-ai-codegen.md) §5). Non-deterministic, so it **does not block CI** — it runs on a schedule and before releases, and the trend is tracked. It is the regression tool for the style guide and the context builder: change the prompt/context and the eval tells you whether the conformance rate went up or down.

## 4. CI gates

- Layers 1–4: must be green on every PR — these are the only deterministic gates.
- Layer 5: runs from the Claude in Chrome checklist on PRs touching `@codeflow-team/react`; its output is an **evidence report** (screenshots + pass/fail per item) for a human reviewer to decide on. It is **not** an automatic blocking gate (agent-driven testing is not deterministic, the same reason layer 6 does not block CI; "the agent misread the scenario" and "the product is broken" need a human to tell apart).
- Layer 6: scheduled + at releases; reports trends, with a warning threshold (e.g. L1 rate < 90% → investigate).
- **Bug-fixing rule**: every real bug found (including from review or production) → write a fixture/test reproducing it **first**, then fix it. The corpus only grows, it never shrinks.

## 5. Expected coverage

For the core moat modules (analyzer, mapper, patcher), the primary measure is not line percentage but the **construct × edit-type matrix**: every supported construct crossed with every kind of edit — each cell either has a fixture covering it, or is explicitly marked unsupported in the specs. Any cell that is neither is a hole in the test suite.
