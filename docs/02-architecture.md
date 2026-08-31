# 02 — Architecture

## 1. The bidirectional pipeline

```text
                    AI / Developer
                         │ generate / edit
                         ▼
               ┌───────────────────┐
               │ TypeScript Source │  ◄── SOURCE OF TRUTH
               └─────────┬─────────┘
                         │
              ┌──────────▼──────────┐
              │       Parser        │  ts-morph / TS Compiler API
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │  Semantic Analyzer  │  control flow · data flow ·
              │                     │  tool resolution (via the type checker) ·
              │                     │  node mapping · diagnostics
              └──────────┬──────────┘
                         │              ┌──────────────┐
              ┌──────────▼──────────┐   │   Registry   │
              │   Workflow Graph    │◄──│  tools / MCP │
              │    (projection)     │   │  / functions │
              └──────────┬──────────┘   └──────────────┘
                         │
              ┌──────────▼──────────┐
              │    Layout (ELK)     │  computes x/y only, never semantics
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │   React Flow UI     │  canvas · inspector · Monaco
              └──────────┬──────────┘
                         │ user edits a node
              ┌──────────▼──────────┐
              │    Patch Engine     │  resolve node → verify fingerprint →
              │                     │  transform AST → minimal patch
              └──────────┬──────────┘
                         │
                         ▼
               TypeScript Source  ──→  re-analyze → graph diff → UI update
```

Execution sits outside the pipeline: the source is handed to a sandbox runtime (isolate + bindings, Code Mode style, or Temporal/Inngest/custom) — see [09-future.md](09-future.md).

## 2. Package structure (MVP)

pnpm + Turborepo monorepo. Four published packages, plus an examples package and a demo app used for testing and for the e2e loop:

```text
packages/
├── core/      @codeflow-team/core   — browser-safe, no Node APIs
├── react/     @codeflow-team/react
├── mcp/       @codeflow-team/mcp
├── cli/       @codeflow-team/cli    — bin `codeflow`; Node-only: init, generate, check
└── examples/  @codeflow-team/examples — example flow corpus used at real scale
apps/
└── demo/      the demo app the UI e2e checklist runs against
```

`cli` is a separate package because it needs fs/watch (Node APIs) — those must not be pulled into core, which has to run in a browser. The CLI provides: `codeflow init` (scaffold a workspace), `codeflow generate` (emit `generated/*.d.ts` from the config/registry, plus `prompts/flow-style.md`; `--agent-md` also prints the `CLAUDE.md`/`AGENTS.md` section that points an agent at them), and `codeflow check` (walk the `flows/` directory, analyze each flow, report diagnostics workspace-wide — this is the mechanism that catches cross-flow breakage when a tool or a library function changes or disappears).

### `@codeflow-team/core`

The whole engine, no React dependency, runs in both Node and the browser:

- domain model: graph, node, edge, source mapping, diagnostics, events;
- parser layer (ts-morph / TS Compiler API, behind an abstraction);
- semantic analyzer;
- mapper (stable identity, semantic path, fingerprint);
- patch engine;
- registry (tool/function/node definitions, typed API codegen);
- validation.

Internally it is split into modules along exactly those lines (`core/src/{model,parser,analyzer,mapper,patcher,registry}`), but **not into separate packages** — these parts change APIs together, constantly, in the early phase, and splitting them would only create friction. After 1.0, once the APIs settle, they can be split off gradually (parser, analyzer, patcher...) without changing the public API.

### `@codeflow-team/react`

The UI layer:

- React Flow canvas, custom nodes/edges, minimap, controls, palette;
- ELK.js layout (async, returns positions only);
- node inspector (schema-driven forms, shadcn/ui);
- Monaco code view / custom-code editor / diff view;
- providers, hooks, state sync with core.

### `@codeflow-team/mcp`

An optional adapter: MCP tool discovery → `ToolDefinition` → registry. Core does not depend on MCP.

## 3. Parser strategy

**The MVP uses only the TypeScript Compiler API + ts-morph.** Reasons:

- A flow file under the contract is a few hundred lines; a full re-parse + re-analyze still fits inside the performance target (see [08-mvp.md](08-mvp.md)). Incremental parsing is premature optimization.
- Building the graph needs only **parse + scope analysis** (tool resolution is binding-rooted — [04-analyzer.md](04-analyzer.md) §1.2, no type checker required). The TS **type checker** is a separate enrichment/validation layer that runs asynchronously in Node/CI or in a worker; it is not on the hot path for building the graph. That is what lets core run in a browser without loading lib.d.ts on the render path.
- Running two parsers side by side (Tree-sitter + TSC) was the largest complexity burden of the v0.1 draft and bought nothing at MVP scale.

The parser sits behind an abstraction to keep the door open for Tree-sitter (incremental) if a real need appears:

```ts
interface Parser {
  parse(source: string): SyntaxTree;
  update(previous: SyntaxTree, source: string, changes: TextChange[]): SyntaxTree;
}
```

In the MVP, `update` is a full re-parse. The contract does not change when the implementation is replaced later.

## 4. Public API — `CodeFlowSession`

The `flow` object that appears in examples throughout the specs (`flow.analyze`, `flow.patchNode`, `flow.validate`, `flow.buildGenerationContext`) is a **session**:

```ts
import { createCodeFlow } from "@codeflow-team/core";

const flow = createCodeFlow({
  registry,                    // required — the analyzer needs the registry (04 §1)
  libraryStore?,               // FunctionLibraryStore
  parser?,                     // override the Parser implementation
});
```

The session holds state: the registry (+ `registryHash`), a warm parse tree/Project (which is what makes the <100 ms target reachable), and **the most recent graph** — the basis for identity continuity ([03-data-model.md](03-data-model.md) §5.0): re-analyzing inside the same session carries ids across through resolution, while a new session is a cold analyze. The UI (`<CodeFlowProvider>`) takes the session (or a graph plus the registry obtained from it) — one source, not a registry passed separately down two paths.

## 5. Technology stack

| Layer | Technology | Notes |
|---|---|---|
| Language | TypeScript | the whole SDK |
| Parser + semantics | TS Compiler API + ts-morph | the only one in the MVP |
| Graph model | Custom | semantic representation |
| Layout | ELK.js | auto layout, async |
| Canvas | React Flow | workflow editor |
| Code editor | Monaco | developer / custom-code view |
| UI primitives | shadcn/ui | inspector forms |
| MCP | MCP SDK | optional adapter |
| Test | Vitest + Claude in Chrome | core (unit/fixture/property) + agent-driven UI e2e |
| Monorepo | pnpm + Turborepo | |
