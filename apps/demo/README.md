# CodeFlow demo

The app the screenshots in the [root README](../../README.md) come from. It is the place to see the whole loop: pick a flow, read the diagram, edit a step and watch the file change, ask an AI to write a new one, then run it against real MCP servers.

## Run it

```bash
pnpm install
pnpm build
pnpm dev            # from the repo root — http://localhost:5173
```

or `pnpm --filter demo dev`. The port is `--strictPort`, so it fails loudly instead of silently moving.

Everything except the AI chat works with no configuration.

## What is in it

- **Gallery** (`⌘O`) — the eleven flows from [`@codeflow/examples`](../../packages/examples/README.md), grouped and searchable, each card listing what the flow shows off.
- **Canvas** — three disclosure levels (Simple / Details / Code), containers that fold, a step list for long flows, a diagnostics popover, and light/dark.
- **Inspector** — edit a field, preview the exact diff, apply it. Delete with a dependency check, swap a tool, edit an opaque code region, insert a step from the command palette (`⌘K`).
- **Code drawer** — Monaco, synced both ways with the canvas. Type in it and the diagram re-reads the file.
- **Ask AI** — write a whole flow from a sentence, or change one step in place. Every answer is scored L0/L1/L2 and shown as a diff before anything is applied.
- **Run** — execute the flow for real (see below).

## The AI chat needs a key

Put one in the **repo-root** `.env`:

```bash
OPENROUTER_API_KEY=sk-or-…
OPENROUTER_MODEL=stealth/ox-alpha    # optional; this is the default
```

The key is read by the Vite dev-server process and never reaches the browser: the page posts to `/api/ai`, the dev-server middleware adds the credential, the model and the token budget, and hands back the answer. Without a key the panel says so instead of failing at request time.

Answers stream, with a 15-minute wall clock and a 3-minute stall timeout. That shape is deliberate: a reasoning model's time is proportional to how much code it writes, so a short wall-clock cap punishes exactly the request the demo exists for. A stream that stops producing is dead; a stream that is merely slow is not.

## The runner is a demo runner, not a sandbox

`POST /api/run` starts a Node worker that executes the flow and streams back an event per step, flushed immediately — a trace delivered at the end would light every node at once, which is a claim rather than a demonstration.

The worker connects over stdio to a short allowlist of MCP servers, and the rule for being on it is that starting the server must be harmless on a laptop with no configuration:

| Namespace | Server | Why it is safe to start |
|---|---|---|
| `fs` | `@modelcontextprotocol/server-filesystem` | Pointed at a fresh scratch directory per run, deleted afterwards |
| `memory` | `@modelcontextprotocol/server-memory` | Its knowledge graph lives in that same scratch directory |
| `everything` | `@modelcontextprotocol/server-everything` | The MCP reference server; it exists to be called |
| `reasoning` | `@modelcontextprotocol/server-sequential-thinking` | Pure computation, no I/O |

Everything else is stubbed, and the UI says so per tool: Playwright downloads and drives a browser, DuckDuckGo/DeepWiki/Context7 need the public internet, and `github`/`slack` have no server at all — they are the specs' illustrations.

**This is not isolation.** The worker has no network of its own and writes only inside a throwaway directory, which is enough to prove a flow really runs. A real deployment needs a V8 isolate or a container. Execution is also deliberately absent from `@codeflow/core` — `packages/core/test/no-execution.test.ts` fails if anyone changes their mind about that.

## Scripts

```bash
pnpm --filter demo test       # 52 tests
pnpm --filter demo typecheck
pnpm --filter demo build      # typecheck + production bundle
```

`scripts/run-examples.mjs`, `scripts/trace-example.mjs` and `scripts/skipped-report.mjs` drive `server/runner.ts` directly — no browser, no dev server, the same code path the endpoint uses. `packages/mcp/scripts/generate-and-run-eval.mjs` uses the same runner to execute AI-written flows.

## License

[GNU AGPL v3 or later](../../LICENSE).
