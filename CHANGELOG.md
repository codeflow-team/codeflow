# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages in
this repository are versioned together under
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until `1.0.0`, a minor bump may contain a breaking change. Breaking changes are
always listed first in their release.

## [0.1.0] — unreleased

First public release. Everything below already existed and was tested before
this tag; `0.1.0` is the point at which it was licensed, packaged and published,
not the point at which it was written.

Published packages — `@codeflow-team/core`, `@codeflow-team/react`, `@codeflow-team/cli`,
`@codeflow-team/mcp`, `@codeflow-team/examples`. `apps/demo` is not published.

### Added

- **`@codeflow-team/core`** — the whole read/write loop over a TypeScript flow file:
  - parser and analyzer covering the supported constructs, including
    `try`/`catch`/`finally`, `while`, and jump statements;
  - a workflow graph with deterministic, stable node identity and provenance,
    so a node keeps its id across reformatting and unrelated edits;
  - a transactional patch engine that changes only the bytes the edit names —
    an empty edit is a no-op down to the byte, and the round trip is idempotent;
  - graph diff, and `validate` at conformance levels L0/L1/L2 with
    `GenerationContext` / `renderSystemPrompt` for AI codegen;
  - typed API codegen: a registry becomes `tools.d.ts` and `lib.d.ts`.
  - Browser-safe by construction: nothing in the package imports a Node API,
    and the core never executes the code it reads (invariant I7).
- **`@codeflow-team/react`** — the canvas: React Flow nodes with nested ELK
  hierarchical layout, three disclosure levels, a node inspector that edits
  through the patch engine, a Monaco code panel with two-way selection sync,
  diff preview, conflict handling, a diagnostics panel, and light/dark themes.
  Ships `styles.css` and `tokens.css`.
- **`@codeflow-team/cli`** — `codeflow init`, `codeflow generate`, `codeflow check`,
  over a `codeflow.config.ts` workspace, with a file-backed function library in
  `lib/` and a usage index.
- **`@codeflow-team/mcp`** — MCP JSON Schema to `ToolDefinition`, with safe name
  slugging, cursor paging and inline `$ref` resolution. No runtime dependency on
  the MCP SDK; it is an optional peer.
- **`@codeflow-team/examples`** — 11 example flows (four of them 261–345 lines) and
  the registries they run against, built from 65 tool schemas captured from
  eight real MCP servers.

### Notable fixes made while building this release

These were found by running the library against real MCP servers and a 206-case
adversarial suite rather than against mocks, and each one is locked by a
regression test:

- A `*/` inside a tool description terminated the generated JSDoc early and
  broke `tools.d.ts` — Anthropic's own filesystem server has `'**/*.ext'` in a
  description, so this was a build-breaker for a very common registry.
- `$ref` in an input schema emitted a type that was declared nowhere; every
  zod-based server hit it. References are now resolved inline.
- Deleting the body of a brace-less `if` let the `if` swallow the next
  statement. The result still parsed and still type-checked, and meant something
  different — the most serious class of bug in a patch engine.
- A quoted property key (`{"channel": x}`) caused a second property to be
  appended instead of the first being edited, silently overriding it.
- A byte-order mark shifted every offset by one character, so every patch on a
  BOM-prefixed file failed.
- Nested destructuring (`const { a: { b } }`) produced a binding named `{ b }`,
  losing the data edge and the dependency check that guards deletion.
- `isFieldValue` checked the discriminant but not the payload, so a wrongly
  encoded value wrote `undefined` over the user's value and reported success.
- A tool without an `outputSchema` was typed `Promise<void>`, which lied about
  the result.

### Known limitations

Stated because a diagram that quietly disagrees with the code is worse than a
missing feature:

- **Statement-level patching (insert/delete) is the weakest part of the engine.**
  Field edits are located through the AST; insert and delete still reason in
  offsets and do not know their parent statement. The transactional validator
  cannot catch this class of error, because a corrupted result still parses and
  still satisfies the flow contract.
- **The analyzer does not type-check.** The UI adds one narrow argument-type
  check the browser can make honestly; a value produced by an expression is
  taken on trust.
- Mutation ordering is not modelled; nested `try` terminals route only to the
  `finally` in the same statement, not transitively outward.
- `codeflow check --watch` does not exist yet.
- AI conformance is measured, not guaranteed: L0/L1 held at 100% across 47 runs
  on real registries, while L2 is sensitive to flow size and to the style guide.

### Requirements

- Node.js 20 or newer for `@codeflow-team/core`, `@codeflow-team/react`, `@codeflow-team/mcp`
  and `@codeflow-team/examples`.
- **Node.js 22.18+ or 23.6+ for `@codeflow-team/cli`**, which loads
  `codeflow.config.ts` with Node's own type stripping rather than adding a build
  dependency to your project. Earlier versions fail with
  `ERR_UNKNOWN_FILE_EXTENSION`.
- `@codeflow-team/react` needs React 18.2+ or 19 as a peer.

### License

The whole repository is licensed [AGPL-3.0-or-later](LICENSE) from this release
onward.
