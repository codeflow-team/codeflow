# `@codeflow/cli`

The Node-only half of CodeFlow. It owns everything that touches the filesystem — the workspace scaffold, the generated type declarations, the function library stored in `lib/`, and a workspace-wide check you can put in CI — so that [`@codeflow/core`](../core/README.md) can stay browser-safe.

Every command is also a plain function, so a host app can run the same generate pass without shelling out.

See the [root README](../../README.md) for what CodeFlow is.

## Install

Prepared for npm as v0.1.0. Until the first release lands, the binary is `packages/cli/dist/cli.js` after `pnpm build`, and the package is added as a dependency the workspace way:

```jsonc
"dependencies": { "@codeflow/cli": "workspace:*" }
```

Needs Node 22.18+ or 23.6+ — `codeflow.config.ts` is loaded with Node's own type-stripping rather than a bundler, so the CLI adds no build dependency to your project.

## Commands

```text
codeflow init [dir] [--force]     scaffold codeflow.config.ts, flows/, lib/, tsconfig.json
codeflow generate [--agent-md]    regenerate generated/tools.d.ts + generated/lib.d.ts
codeflow check [--json]           analyze every flow, report diagnostics, flag stale artifacts
```

A full round trip, run end to end:

```console
$ codeflow init myflows
codeflow init — /tmp/myflows
  write package.json
  write codeflow.config.ts
  write tsconfig.json
  write flows/README.md
  write lib/is-auth-change.ts
  write lib/index.ts

Next: codeflow generate

$ cd myflows && codeflow generate
codeflow generate — codeflow.config.ts
  registry: 3 tool(s), 1 library function(s)  [registryHash 0b84875efe85]
    ok  lib/index.ts
  write generated/tools.d.ts
  write generated/lib.d.ts
  write prompts/flow-style.md

$ codeflow check
codeflow check — /tmp/myflows/codeflow.config.ts
  registry: 3 tools, 1 library function  [registryHash 0b84875efe85]

flows/canonical.flow.ts — L2, 7 nodes
  no diagnostics

library function usage (@flows/lib)
  isAuthChange  ← flows/canonical.flow.ts

ok — 1 flow checked, 0 warnings
```

`check` exits 1 on any error diagnostic or any generated artifact that no longer matches the registry, which makes it a CI gate. `--json` prints the same result machine-readably. `generate --agent-md` additionally prints the `CLAUDE.md` / `AGENTS.md` section that points a coding agent at the generated files and the flow-style rules.

## The API entry points that matter

| Export | What it is for |
|---|---|
| `generate(options)` | The generate pass. Returns which files it wrote and the registry it used. |
| `check(options)` / `checkToJson` / `formatCheck` | Workspace analysis: per-flow level and diagnostics, stale-artifact detection, and the library usage index. |
| `init(options)` | The scaffold. |
| `loadWorkspace` / `findConfig` / `loadConfigFile` / `registryFromConfig` | Read `codeflow.config.ts` and turn it into a `Registry` — the piece to reuse if you want the registry without the CLI. |
| `FileFunctionLibraryStore` / `createLibraryStore` | The function library over `lib/`. Metadata lives in a header comment inside each function's own file, so there is never a second copy to drift. |
| `buildUsageIndex` / `findFlowFiles` / `loadFlows` | Which flow uses which library function — the guard behind "you cannot delete a function three flows still call". |
| `defineConfig` | Typed `codeflow.config.ts` authoring. |

```js
import { check, formatCheck } from "@codeflow/cli";

const result = await check({ cwd: process.cwd() });
console.log(formatCheck(result).join("\n"));   // formatCheck returns lines
process.exit(result.ok ? 0 : 1);
```

## Notable behaviour

- The generated `prompts/flow-style.md` is imported from core rather than duplicated here — one source of truth for the rules an AI is given.
- Renaming a library function rewrites the declaration inside its own file so the workspace still type-checks, but it does **not** rewrite the flows that import it. That is deliberate: the CLI says what it did instead of guessing at call sites.
- The scaffolded `tsconfig.json` uses `moduleResolution: "Bundler"`, because the flow contract imports without file extensions.

## Tests

```bash
pnpm --filter @codeflow/cli test   # 63 tests
```

## License

[GNU AGPL v3 or later](LICENSE).
