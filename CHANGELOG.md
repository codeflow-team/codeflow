# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the packages in
this repository are versioned together under
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Until `1.0.0`, a minor bump may contain a breaking change. Breaking changes are
always listed first in their release.

## [0.2.0] — unreleased

The release that came out of watching someone use it. Almost everything here
began as a person opening the demo, trying to do an ordinary thing, and finding
they could not — so the entries are written as what was wrong, not as features.

### Changed

- **`RunPhase` gained a member, `"pass"`.** A container reporting another lap is
  not a lifecycle transition: a loop that runs three times started once and
  finished once. While each pass was reported as a `started`, `NodeRunState.runs`
  read 4 and the canvas drew `×4` beside a three-pass loop. A consumer
  exhaustively switching on `RunPhase` needs a case for it.
- **`WorkflowGraph.scopes` is a required field.** Anything constructing a graph
  literal (test fixtures, mocks) must supply it, `{}` included.
- **Removing a field warns only when the schema says the field is required.** It
  used to warn for any field the schema knew, including optional ones. A warning
  that fires on a correct edit is one people learn to skip past. Requiredness is
  now three answers — a JSON Schema with a `required` array says required or
  optional; a named-fields map and a type ref say *nothing*, and that case gets
  its own message naming the gap rather than asserting the field was required.
- **The default model is `openrouter/free`.** The previous default,
  `stealth/ox-alpha`, was retired from OpenRouter, so every AI feature was
  calling a model that no longer existed — a dead constant nothing could catch,
  because the id stayed perfectly valid-looking. A router across whatever free
  models exist cannot rot the same way.

### Added

- **`WorkflowGraph.scopes` and `CodeFlowSession.scopeAt(nodeId)`** — what is in
  scope *at* each node, so a UI can offer the values that are legal to reference
  there. Built at the one point every node passes through, capturing the visible
  scope at the moment the node is emitted, so a later declaration cannot leak in.
- **The patch engine refuses an expression that references a name nothing binds
  here**, naming the offender and listing what *is* available. Written verbatim,
  a mis-drag produced code that parses, type-checks nowhere in a browser, and
  fails at run time while the node looks configured.
- **A three-pane node editor** (`@codeflow-team/react`): the values available at
  this step, the step's fields, and what it produced — with dragging a value into
  a field going through the same patch engine and the same diff preview as every
  other edit. Every decision is a pure exported function, because this package's
  tests run without a DOM.
- **`data.argumentStyle`** on call nodes, and editable fields for **positional**
  library-function calls. The engine had been patching positional arguments all
  along; only the UI believed it could not, which left twelve everyday steps
  unconfigurable.
- **The flow's `input` carries a shape** when it is declared as an object type
  literal, so `input.ticketsPath` is a draggable row rather than one opaque
  string. A bare type name still yields nothing — a name is not a shape.
- **A loop item carries the array's item schema**, derived by the analyzer.
- **`RunEmit`** — a step reporting something mid-flight without pretending to be
  a lifecycle transition — plus `iteration` on `RunEvent`, `graphId`/`sourceHash`
  on `RunTrace`, and `traceMatches`, so a run can be told apart from the graph it
  no longer belongs to.
- **`sampleFromSchema`** moves into core, so the runner's stub value and the
  editor's sample come from one implementation and cannot disagree.
- **`NodeDefinition.renderer` is read**, and `previewRenderers` lets a host
  render a value its own way. No image renderer ships: nothing here produces an
  image yet, and it could only be tested against a mock.
- **Twelve everyday steps** in `@codeflow-team/examples` — Edit Fields, Filter,
  Sort, Limit, Aggregate, Format Text, Date & Time, Wait, Extract JSON and
  friends — with real bodies that really run, and two flows built from them.

### Fixed

- **A blank page.** `"value" in preview` threw the moment a step produced a
  string, unmounting React. Unreachable while only tool calls reported values.
- **Steps that were not tool calls reported no value at all**, because the
  probe's closing marker could not see what the statement had bound. It is
  handed the binding now — an extra argument to a call that already existed, so
  no wrapper, no inserted `await`, no change to timing.
- **Rows for properties nobody bound.** One statement binding several names had
  its single recorded value handed to every one of them, producing draggable
  rows like `triaged.skipped`.
- **Inserting a step could put it somewhere else.** Inserting after the step in
  `if (pr.draft) await slack.send(…)` placed it *outside* the branch, where it
  ran for every item; inserting after a `continue` or a `return` wrote
  unreachable code. All refused now, with a reason, leaving the source
  byte-identical.
- **Hovering a value row moved the page** — an icon-only button entering a
  baseline row grew it by 1px and stepped everything below.
- **Typing `50` into a `number` field wrote `"50"`**, and clearing a field wrote
  `""` instead of removing the property. Fixing the first exposed that field
  schemas were only read at the top level, so every real MCP tool's fields
  arrived with no schema at all.
- **A run stayed attached to a flow it no longer described.** Node ids are
  stable across patches by design, so editing a step left the old values on the
  very step whose code had just changed. They are labelled now, not discarded.
- **The demo builds and tests on Node 20 again**, and says out loud which five
  tests it cannot run there and why.

## [0.1.0] — 2026-08-31

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
