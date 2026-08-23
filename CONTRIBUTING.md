# Contributing to CodeFlow

Thanks for looking. This file covers the two rules that are not negotiable, then
how to get the repository running, then how a change gets reviewed.

## The two rules

Everything else here is a convention. These two are load-bearing, and a pull
request that breaks either will be asked to change regardless of how good the
rest of it is.

### 1. The core never executes user code — invariant I7

`@codeflow/core` reads a flow file, understands it, and writes bytes back into
it. It never runs it. No `eval`, no `new Function`, no dynamic `import()` of
user source, anywhere in `packages/core`. See
[`docs/11-testing.md`](docs/11-testing.md) §2, invariant I7.

This is not a stylistic preference. The trust model of the product is that a
non-developer looks at a diagram instead of the code, so the analyzer has to be
safe to point at code nobody has read yet. There are exactly two places in the
repository that do run something, both deliberate and both outside the core:

- `packages/cli` runs `codeflow.config.ts` — the workspace owner's own build
  script, exactly like `vite.config.ts` ([`docs/05-registry.md`](docs/05-registry.md) §6).
- `apps/demo/server` runs a flow in a worker thread for the demo's Run feature,
  which is why it lives in the demo and not in a library.

Flow code, library `code` values, and anything an AI generated are never
executed by either of them.

### 2. A real bug gets a failing test before it gets a fix

If something was actually broken, the first commit of the fix is a test that
reproduces it and **fails**. Watch it go red, then write the fix, then watch it
go green. A fix that arrives without a test that would have caught it is not
finished, because nothing stops it coming back.

This is how every bug in the `0.1.0` changelog was closed, and the catalogue in
`packages/core/test/hardening/README.md` says for each case why it was hard and
which invariant it protects. Add yours there when it belongs to that family.

Related: `it.todo` is how known, unfixed gaps stay visible. Leaving one is fine.
Deleting a failing test to make CI green is not.

## Setup

You need **Node.js 20+** and **pnpm 9**. pnpm's version is pinned in the root
`package.json` (`packageManager`), so [Corepack](https://nodejs.org/api/corepack.html)
will pick the right one:

```bash
corepack enable
git clone https://github.com/codeflow-team/codeflow.git
cd codeflow
pnpm install
```

One caveat worth knowing before you file a bug about it: **`@codeflow/cli` needs
Node 22.18+ or 23.6+**, not 20. It loads `codeflow.config.ts` with Node's native
TypeScript type stripping so that a CodeFlow workspace needs no build step of
its own; on an older Node the config import fails with
`ERR_UNKNOWN_FILE_EXTENSION`. Everything else in the repository is happy on 20,
and CI runs the suite on both 20 and 22.

```bash
pnpm build                  # turbo, respects the dependency graph
pnpm test                   # ~1640 tests across six packages
pnpm -r exec tsc --noEmit   # type-check every package
pnpm dev                    # the demo at http://localhost:5173
```

All three of the first commands must be green before a pull request is ready.
CI runs exactly them.

### Optional: the AI features

The chat panel in the demo and the conformance evals call a model through
OpenRouter. Put a key in a repo-root `.env`:

```
OPENROUTER_API_KEY=sk-or-v1-…
OPENROUTER_MODEL=stealth/ox-alpha
```

The key is read by the Vite dev server and never reaches the browser bundle.
`.env` is gitignored; do not commit one.

Nothing about this is required. Without a key, the AI tests skip themselves, the
demo's chat panel offers to use a key you paste into the browser instead, and
the rest of the suite is unaffected. **The evals are not a CI gate** — they cost
money and are non-deterministic ([`docs/11-testing.md`](docs/11-testing.md) §3,
layer 6). Run them deliberately:

```bash
node packages/core/scripts/ai-eval.mjs
```

## Repository layout

```text
packages/
  core/       @codeflow/core      model, registry, parser, analyzer, patch engine,
                                  graph diff, codegen. Browser-safe. No Node APIs.
  react/      @codeflow/react     the canvas: React Flow + ELK layout, inspector,
                                  Monaco panel, diagnostics, styles.css/tokens.css
  cli/        @codeflow/cli       the `codeflow` binary: init / generate / check
  mcp/        @codeflow/mcp       MCP tool schemas -> ToolDefinition
  examples/   @codeflow/examples  11 example flows + the registries they need
apps/
  demo/       (private)           the app at localhost:5173; also the e2e target
docs/                             the design specs, numbered 00-11
e2e/                              browser e2e reports and evidence
```

The dependency direction is one way: `core` depends on nothing in the workspace,
everything else depends on `core`, and nothing depends on `react`, `cli` or
`demo`. `core`'s stress suite reads `@codeflow/examples` *from source* through a
path mapping rather than depending on it, because a real dependency would make
the build graph cyclic.

The specs in `docs/` are the reference for behaviour; code comments cite them by
number (`04 §1.4`, `06 §2`, and so on).
When behaviour and spec disagree, say which one is wrong in the pull request —
the spec has been corrected three times during development and that is fine, as
long as it is deliberate.

## Tests

Vitest everywhere. Per package:

```bash
pnpm --filter @codeflow/core test
pnpm --filter @codeflow/core test -- --watch
```

The layers, from [`docs/11-testing.md`](docs/11-testing.md) §3:

1. **Unit tests** — per module, fast.
2. **Golden fixture corpus** — `packages/core/test/fixtures/<case>/` holds
   `input.flow.ts`, `registry.json`, `expected-graph.json` and an `edits/`
   directory with the exact expected diff. Snapshots here are reviewed, never
   blindly accepted; if a fixture changes, explain in the pull request why the
   new output is the correct one.
3. **Property-based tests** and **round-trip suites** — these encode the
   invariants (determinism, patch minimality, byte-for-byte round trip,
   identity stability, graceful degradation).
4. **UI e2e** through a real browser, for changes that touch the UI.
5. **AI conformance evals** — periodic, not a gate.

Layers 1–4 must be green on every pull request.

## Style

- TypeScript, `strict`, ESM only. `verbatimModuleSyntax` is on, so use
  `import type` for types; relative imports carry the `.js` extension.
- Comments explain *why*, and cite the spec section when there is one. A comment
  that restates the code is noise; a comment that records the reasoning behind a
  non-obvious decision is the point.
- If a feature cannot do something, the UI says so, in words, with what to do
  instead ([`docs/07-ui.md`](docs/07-ui.md) §5). Never a silent failure, never a
  dead control, never a plausible-looking approximation.

## Releasing

Versions are kept in lockstep across the published packages.

1. Bump `version` in each `packages/*/package.json` (and the root, for tidiness).
2. Add the release to [`CHANGELOG.md`](CHANGELOG.md).
3. Merge to `main`.

That is the whole procedure. `.github/workflows/release.yml` runs on every push
to `main`, but it publishes a package only when that package's version is not
already on the registry — so an ordinary commit publishes nothing, and a version
bump publishes exactly the packages that were bumped. It builds, tests and
type-checks first, and it publishes with
[npm provenance](https://docs.npmjs.com/generating-provenance-statements) so a
consumer can verify the tarball was built from this repository.

Two things to know if you ever publish by hand:

- Use **`pnpm pack` / `pnpm publish`, never `npm pack` / `npm publish` from a
  package directory.** Only pnpm rewrites the `workspace:^` specifiers into real
  version ranges; npm would upload a manifest that says
  `"@codeflow/core": "workspace:^"`, which no consumer can install.
- The release workflow needs a repository secret named `NPM_TOKEN` (an npm
  automation token with publish rights on the `@codeflow` scope).

If manual version bumps become tedious, `pnpm -r exec npm version patch` is the
next step up, and [changesets](https://github.com/changesets/changesets) after
that. Neither is set up today, deliberately: five packages released in lockstep
do not yet need the ceremony.

## Pull requests

- One concern per pull request.
- Say what you verified and how. "Tests pass" is not a verification; "added
  `test/patcher/brace-less-if.test.ts`, confirmed it fails on `main` and passes
  here" is.
- Bug fixes: link the failing test.
- New behaviour: say which spec section it implements, or propose the spec
  change alongside it.

## License

CodeFlow is [AGPL-3.0-or-later](LICENSE). By contributing you agree that your
contribution is licensed under the same terms.
