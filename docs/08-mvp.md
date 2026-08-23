# 08 — MVP: Scope, Build Order, Testing, Acceptance

## 1. MVP scope

### Input
- TypeScript following the [flow contract](01-flow-contract.md): 1 flow file + imports from the function library. No JavaScript, no arbitrary code, no cross-file analysis into a library function's body.

### Semantics ([04-analyzer.md](04-analyzer.md))
- tool calls (resolved through the typed `Tools` interface); library function calls (resolved through the generated module declaration); local functions; `const` + data dependencies; sequential `await`; `if/else`; `for...of`; `while` (with a bound-check diagnostic); `try/catch(/finally)`; `return`/`break`/`continue`; `Promise.all`; the custom code fallback.

### Editing ([06-patch-engine.md](06-patch-engine.md) §2 — that list is authoritative)
- primitive arguments; object properties; expressions; condition (`if`/`while`) and iterable expressions; changing to a compatible tool; adding a node from the palette; deleting a node (including jump/output, all through the dependency check); creating/promoting a library function; editing a custom function and an inline code node through Monaco. **No structural editing.**

### UI ([07-ui.md](07-ui.md))
- React Flow canvas + ELK layout; inspector; palette; Monaco code view; diagnostics.

### Integration
- typed Tools API codegen; the **function library** (FunctionDefinition + store interface + module declaration codegen + palette + save/promote); a basic MCP adapter; **AI codegen support** — `buildGenerationContext` + workspace layout + the CLI `codeflow generate` + `validate` L0/L1 ([10-ai-codegen.md](10-ai-codegen.md) §8).

## 2. Build order

This order is mandatory — the UI comes **last**, because building it early would hide bugs in the four core pieces:

```text
1. core model      — graph/node/edge/mapping types + registry types
   + registry-lite — ToolDefinition/FunctionDefinition + codegen of tools.d.ts/lib.d.ts
                     (the analyzer resolves tools through the Tools interface, so codegen
                      has to exist BEFORE the analyzer — even if only well enough to run
                      the fixtures)
2. analyzer        — code → graph, together with the ROUND-TRIP TEST HARNESS
                     (code → graph JSON → assert; no UI needed yet)
3. mapper          — stable identity + an identity test suite across edit scenarios
4. patcher         — node edit → minimal patch, asserted with exact text diffs
5. full registry + mcp — library store, MCP adapter, CLI codeflow generate/check
6. react UI        — canvas/inspector/palette/Monaco on top of a tested core
```

Step 2 is the earliest validation point: if the analyzer and the harness work on the sample flows, the rest is engineering we already know how to do.

## 3. Testing

The full test strategy — goals, correctness invariants (I1–I7), 6 test layers, the fixture corpus, CI gates — is in [11-testing.md](11-testing.md). The MVP-relevant summary:

- **The round-trip suite is the most important gate** (`Code → Graph → Edit → Code' → Graph'` — character-exact diff, identity preserved, idempotent). The entire trust model lives or dies here;
- the golden fixture corpus (flow code → reviewed expected graph JSON) is built alongside the analyzer from step 2 of the build order;
- identity tests cover the nastiest scenario: inserting a call identical to an existing one — it must not mis-bind ([03-data-model.md](03-data-model.md) §5.2);
- AI conformance evals (measuring the L0/L1/L2 rate of AI-generated code) run periodically and do not block CI.

## 4. Acceptance criteria

The project counts as validated when this loop runs end to end:

```text
AI-generated TypeScript (following the contract)
  → the workflow renders automatically, with the right structure
  → the user selects a node and edits one supported property
  → a minimal source patch (character-exact)
  → the graph updates and every other node keeps its identity
```

The concrete acceptance test (the fixture must type-check against a sample `tools.d.ts` — with all required fields present):

```ts
await tools.slack.send({ channel: "#security", message: "Auth change detected" });
```

The user changes the channel to `#engineering`. Expected:

```diff
- await tools.slack.send({ channel: "#security", message: "Auth change detected" });
+ await tools.slack.send({ channel: "#engineering", message: "Auth change detected" });
```

and **no other source change whatsoever** — not even whitespace.

A second criterion (coming from the Code Mode goal): the github→slack example flow ([07-ui.md](07-ui.md) §6), with tools coming from a **real MCP adapter**, must render the same graph as it does with a local registry.
