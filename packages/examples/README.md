# `@codeflow/examples`

Eleven flow files and the registries they are written against. This is the demo's gallery and the analyzer's stress corpus at the same time — which is deliberate: an example nobody tests is an example nobody can trust.

See the [root README](../../README.md) for what CodeFlow is.

## Install

Prepared for npm as v0.1.0; until the first release lands, use the workspace copy:

```jsonc
"dependencies": { "@codeflow/examples": "workspace:*" }
```

Its only runtime dependency is `@codeflow/core`.

## Use

Two exports carry everything: `EXAMPLES` is the gallery (metadata plus source), `REGISTRIES` is what each one needs to be analyzed, and `registryFor` joins them so a caller never has to know the key.

```js
import { EXAMPLES, registryFor } from "@codeflow/examples";
import { createCodeFlow, createRegistry } from "@codeflow/core";

const example = EXAMPLES.find((e) => e.id === "repo-triage-bot");
const { tools, functions } = registryFor(example);

const session = createCodeFlow({ registry: createRegistry({ tools, functions }) });
const graph = await session.analyze(example.source, { file: `${example.id}.flow.ts` });

console.log(example.title, "—", example.lines, "lines →", graph.nodes.length, "nodes");
// Repository triage bot — 343 lines → 90 nodes
```

`registryFor` throws when an example names a registry that is not there, rather than falling back to an empty one — analyzing a flow against the wrong registry produces a graph full of unknown nodes that looks like a bug in the flow, which is the worst possible way to fail.

Each `FlowExample` carries `id`, `title`, `category`, `summary`, `description`, `highlights`, `lines`, `registryId` and `source`. `lines` is computed from `source` when the package is built, so a gallery card and the code behind it can never disagree.

## The flows

| Flow | Lines | Category | Registry |
|---|---:|---|---|
| `canonical` — Security PR watcher | 20 | basics | sample |
| `code-nodes` — Daily digest | 17 | basics | sample |
| `try-catch` — Card charge with fallback | 17 | control-flow | sample |
| `memory-graph-sync` — Knowledge graph sync | 150 | real-mcp | repo-triage |
| `doc-freshness-audit` — Docs freshness audit | 138 | real-mcp | research |
| `repo-triage-bot` — Repository triage bot | 343 | stress | repo-triage |
| `research-agent` — Research agent | 290 | stress | research |
| `browser-qa-runner` — Browser QA runner | 345 | stress | browser-qa |
| `data-pipeline` — Regional sales pipeline | 261 | stress | pipeline |
| `demo-degradation` — Unknown, code and hidden call | 21 | degradation | sample |
| `degradation-showcase` — Every way of saying "I don't know" | 96 | degradation | repo-triage |

The source lives in [`flows/`](flows/) as real `.flow.ts` files and is embedded into the package by `scripts/embed-flows.mjs`, so the code in the gallery is the code in the repository, byte for byte.

## The registries

| Key | Tools | Built from |
|---|---:|---|
| `sample` | 4 | The specs' own GitHub + Slack registry — illustrations, no server behind them |
| `repo-triage` | 23 | filesystem + memory |
| `pipeline` | 27 | filesystem + everything |
| `research` | 28 | DuckDuckGo, DeepWiki, Context7, sequential-thinking, memory, filesystem |
| `browser-qa` | 38 | Playwright + filesystem |

65 of those 69 tool definitions are **verbatim `tools/list` payloads** from real MCP servers, captured once at authoring time by `scripts/generate-tools.mjs` and frozen into `src/tools/`. Nothing was invented to make an example work: if a field is optional, it is optional because the server said so, and a flow that passes the wrong shape fails the real TypeScript compiler in `packages/core/test/stress/type-check.test.ts`.

The per-server tool sets are exported individually too — `FILESYSTEM_TOOLS`, `MEMORY_TOOLS`, `PLAYWRIGHT_TOOLS`, `EVERYTHING_TOOLS`, `DUCKDUCKGO_TOOLS`, `DEEPWIKI_TOOLS`, `CONTEXT7_TOOLS`, `SEQUENTIAL_THINKING_TOOLS` — if you want a real registry to point CodeFlow at without running any servers.

## Why they are this size

The four stress flows (261–345 lines) exist because problems only appear at scale. The largest is 345 lines → 101 nodes and 286 edges, with a `try/catch/finally` per step inside a retry loop inside a step loop inside a case loop, labelled `break`/`continue` from inside a catch, a bounded `while`, a `Promise.all` with four branches and a five-way `else if` chain. Adding this corpus immediately caught a real bug: a field value with the wrong payload key wrote `undefined` over the user's value and reported success.

## Tests

```bash
pnpm --filter @codeflow/examples test   # 30 tests
```

The heavier suites live in core and run against this package: `packages/core/test/stress/` covers analysis, identity, patch round-trips, degradation, real type-checking and the performance budgets.

## License

[GNU AGPL v3 or later](LICENSE).
