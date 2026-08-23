# CodeFlow — Specs

**Status:** design record. These documents were written before implementation and are what the MVP was built against; the MVP is implemented and the code matches them (a handful of statements were corrected during the build and are noted where they occur). For installing and using CodeFlow, see the root [README.md](../README.md).

**Version:** Draft v0.2 — a rewrite of the v0.1 draft, done after the idea and the scope were settled.

**Core principle:** code is the source of truth. The workflow is a visual, editable projection of the code.

## Contents

| File | Content |
|---|---|
| [00-overview.md](00-overview.md) | Idea, problem, goals, non-goals, design principles |
| [01-flow-contract.md](01-flow-contract.md) | **Flow code contract** — what CodeFlow takes as input, AI style guide |
| [02-architecture.md](02-architecture.md) | Overall architecture, the bidirectional pipeline, package structure |
| [03-data-model.md](03-data-model.md) | WorkflowGraph, node, edge, source mapping, stable identity |
| [04-analyzer.md](04-analyzer.md) | Semantic analyzer — the rules that map code → graph |
| [05-registry.md](05-registry.md) | Tool registry, typed API codegen, MCP adapter, **function library** (user-defined, stored independently), custom code |
| [06-patch-engine.md](06-patch-engine.md) | Workflow → code: editable fields, expressions, patch, conflict |
| [07-ui.md](07-ui.md) | UI architecture, components, progressive disclosure |
| [08-mvp.md](08-mvp.md) | MVP scope, build order, testing, acceptance criteria |
| [09-future.md](09-future.md) | Post-MVP directions, relationship to the sandbox runtime |
| [10-ai-codegen.md](10-ai-codegen.md) | AI code generation: GenerationContext, workspace layout, how to feed it to an AI, L0/L1/L2 validation |
| [11-testing.md](11-testing.md) | Correctness goals, invariants I1–I7, test layers, fixture corpus, CI gates |

## Where to start

If you read only one file: [00-overview.md](00-overview.md).

If you want to know why this project is more tractable than "visualize arbitrary TypeScript": [01-flow-contract.md](01-flow-contract.md) — the most important design decision in v0.2.
