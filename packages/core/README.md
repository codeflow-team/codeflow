# `@codeflow/core`

The library CodeFlow actually is. It reads a TypeScript flow file into a `WorkflowGraph`, keeps node identity stable across edits, and writes a change to a node back into the file as the smallest possible text patch. It also carries the pieces an AI needs to write a flow in the first place — a generation context and a conformance validator.

Browser-safe by construction: nothing in this package imports a Node API. The fs-backed parts live in [`@codeflow/cli`](../cli/README.md).

See the [root README](../../README.md) for what CodeFlow is and why.

## Install

Prepared for npm as v0.1.0; until the first release lands, use the workspace copy:

```jsonc
// package.json
"dependencies": { "@codeflow/core": "workspace:*" }
```

Its only runtime dependency is `ts-morph`.

## The five things you will use

### 1. A registry — what tools exist

Core ships no tools and hardcodes no integration. You describe what exists; everything else follows from that. With an empty registry every call becomes an unknown node and the system is still correct.

```js
import { createRegistry } from "@codeflow/core";

const registry = createRegistry({
  tools: [
    {
      name: "slack.send",
      label: "Slack Send",
      description: "Send a message to a Slack channel",
      inputSchema: { channel: "string", message: "string" },
      editableFields: ["channel", "message"],
    },
  ],
});

registry.registryHash(); // fingerprint — generated artifacts carry it
```

Tools can also come from an MCP server through [`@codeflow/mcp`](../mcp/README.md), or from a `codeflow.config.ts` through the CLI. Nothing downstream can tell the difference, which is the point.

### 2. `createCodeFlow(...).analyze(source)` — code → graph

```js
import { createCodeFlow, createRegistry } from "@codeflow/core";
import { EXAMPLES, registryFor } from "@codeflow/examples";

const example = EXAMPLES.find((e) => e.id === "canonical");
const { tools, functions } = registryFor(example);

const session = createCodeFlow({ registry: createRegistry({ tools, functions }) });
const graph = await session.analyze(example.source, { file: "canonical.flow.ts" });

for (const node of graph.nodes) {
  console.log(`${node.type.padEnd(10)} ${node.label}`);
}
console.log(`${graph.nodes.length} nodes, ${graph.edges.length} edges`);
```

```text
trigger    Trigger
tool       Get New PRs
loop       For Each pr in prs
tool       Get PR Files
condition  Is Auth Change
tool       Slack Send
output     End Flow
7 nodes, 11 edges
```

Each node carries a `source` range (`file`, `start`/`end` with line, column and offset, plus a semantic path and a fingerprint), so every node maps back to exactly the code it came from.

A **session** is the unit of continuity. The first `analyze` is cold — the graph, node ids included, is a pure function of (source, registry). Every analyze after that resolves identity against the graph the session already holds, so ids survive reformatting, inserted lines and unrelated edits:

```js
const before = await session.analyze(example.source, { file: "flow.ts" });
const edited = example.source.replace("#security", "#engineering");
const after = await session.analyze(edited, { file: "flow.ts" });

console.log(before.nodes.every((n) => after.nodes.some((m) => m.id === n.id)));  // true
console.log(session.lastChanges());  // [{ type: "node.updated", nodeId: "n_…", changes: { … } }, …]
```

`session.lastChanges()` is the graph diff — `node.added` / `node.removed` / `node.updated` and the edge equivalents — which is how a UI knows what to re-render and what to keep selected.

### 3. `session.patchNode(id, changes)` — graph → code

One edit, one transactional patch. The result carries the new source, the new graph, and the exact ranges that were rewritten. If the patch cannot be made safely it throws a `CodeFlowError` with a `patch-*` code and the source is not touched at all.

```js
const slack = graph.nodes.find((n) => n.data.toolName === "slack.send");
const { patches, source, graph: next } = await session.patchNode(slack.id, {
  channel: "#engineering",
});

console.dir(patches, { depth: null });
```

```text
[
  {
    range: {
      start: { line: 15, column: 18, offset: 462 },
      end: { line: 15, column: 29, offset: 473 }
    },
    oldText: '"#security"',
    newText: '"#engineering"'
  }
]
```

Nothing is reprinted. The template literal on the next line, the comment two lines up and the identical sibling call below it come out byte-for-byte identical — there is a test that asserts exactly that.

Field values are either a raw string (keep the current form) or an explicit `{ kind: "literal" | "expression" | "template" | "remove", … }`. A bare expression string is **refused** rather than guessed, so an edit can never silently change a literal into an expression. Structural operations have their own ops: `$condition`, `$iterable`, `$code`, `$tool`, `$delete`, `$insert`.

### 4. `session.validate(source)` — score AI output

Three levels, and it never mutates the session:

| Level | Means |
|---|---|
| `L0` | Parses and honours the flow contract |
| `L1` | Every name resolves — no invented tools, no wrong arguments |
| `L2` | Projects to a clean graph: no unknown nodes, no code node hiding a call |

```js
const result = await session.validate(sourceFromTheModel, { file: "flow.ts" });
console.log(result.level);
for (const d of result.diagnostics) console.log(`${d.severity} ${d.code} — ${d.message}`);
```

```text
L0
error unresolved-tool — Tool `github.getAuditLog` is not in the registry — the call is shown as an unknown node (04 §1.2).
```

`session.buildGenerationContext()` is the other half: it returns `{ files, promptSections, estimatedTokens }` — the generated type declarations, the flow-style rules and the registry summary, i.e. everything a model needs to see before it writes.

### 5. `generateToolsDts` / `generateLibDts` — the typed API

The registry is the source of truth; the `.d.ts` files are derived artifacts, sorted alphabetically so they are byte-stable across regenerations.

```js
import { generateToolsDts } from "@codeflow/core";
console.log(generateToolsDts(registry));
```

```ts
// Generated by CodeFlow — DO NOT EDIT.
// The registry is the only source of truth; this file is a derived artifact.
// registryHash: ef5ca9cc4ea42b98b5570ed2e060b1250df22b1c07e39e6a5efedfca7e38b29b
// Regenerate with `codeflow generate`.

export interface Tools {
  fs: {
    /** Read a file from disk. Supports '**\/*.md' globs. */
    readTextFile(input: { path: string; head?: number }): Promise<unknown>;
  };
}
```

(That escaped `*\/` is not decoration. A description containing `*/` closes the JSDoc comment early and breaks the whole file — Anthropic's own filesystem server does exactly that, and it produced 379 TypeScript errors before it was fixed.)

## Also exported

- `InMemoryFunctionLibraryStore` — the browser-side implementation of the function library (the CLI has the file-backed one).
- `CodeFlowError` with a typed `code`, so a caller always learns *why* a patch was refused.
- `sha256Hex`, `canonicalJson` — written in-package rather than taken from `node:crypto`, to keep core browser-safe and hashing synchronous.
- The full model types: `WorkflowGraph`, `WorkflowNode`, `WorkflowEdge`, `Diagnostic`, `ToolDefinition`, `FunctionDefinition`, `PatchResult`, `GraphChange`, `ValidationResult`, `GenerationContext`.

## Tests

```bash
pnpm --filter @codeflow/core test                                        # 1,185 tests
pnpm --filter @codeflow/core exec vitest run test/stress/performance.test.ts
```

The performance test prints the whole table it asserts on. A 345-line, 101-node flow analyzes cold in about 21 ms against a 500 ms budget, and re-analyzes warm in about 26 ms against a 100 ms budget.

`test/hardening/README.md` catalogues 206 adversarial cases and says, per case, why it is hard and which invariant protects it.

## License

[GNU AGPL v3 or later](LICENSE).
