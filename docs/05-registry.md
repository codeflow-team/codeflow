# 05 — Registry, Typed Tools API, MCP, Function Library, Custom Code

The registry is where everything that can become a node is declared. All visual semantics are extended through the registry, never by changing core.

Nodes come from **3 sources**, all equal citizens in the palette:

```text
┌────────────────────────────────────────────────┐
│                    Registry                    │
│                                                │
│  Tools/MCP          Function Library   Node    │
│  (existing          (user-defined,     types   │
│   integrations)      stored            (plugin)│
│                      independently,            │
│                      input/output,             │
│                      reusable)                 │
└───────────┬──────────────┬─────────────────────┘
            ▼              ▼
        tool node     function node        code node
                                           (inline, fallback,
                                            no registry needed)
```

## 1. ToolDefinition

```ts
interface ToolDefinition {
  name: string;               // "github.getFiles" — namespace.method
  label: string;              // "Get PR Files"
  description?: string;
  icon?: string;

  // Schema = a JSON Schema object OR a TS type ref string — the definition and the
  // conversion rules are in 03-data-model.md §11. MCP tools carry JSON Schema;
  // the examples in these docs use TS refs for brevity.
  inputSchema: Schema;
  outputSchema?: Schema;

  editableFields?: EditableFieldInput[];  // see 06-patch-engine.md §1

  analyzer?: SemanticAnalyzer;        // override how this call is analyzed
  patcher?: NodePatcher;              // override how this call is patched
}
```

## 2. Typed Tools API codegen — the seam with Code Mode

The registry is not just passive metadata. From the list of `ToolDefinition`s, CodeFlow **generates a typed TypeScript API**:

```ts
// tools.d.ts — generated
export interface Tools {
  github: {
    /** Get files changed in a PR */
    getFiles(input: { pr: PullRequest }): Promise<File[]>;
    /** Get new pull requests */
    getNewPRs(input: { repo: string }): Promise<PullRequest[]>;
  };
  slack: {
    /** Send a Slack message */
    send(input: { channel: string; message: string }): Promise<unknown>;
  };
}
```

Namespaces and methods are emitted in alphabetical order, not registration order, so the generated file is byte-stable across runs (it is committed to the repo — [10-ai-codegen.md](10-ai-codegen.md) §2). A tool that declares no `outputSchema` produces `Promise<unknown>`, not `Promise<void>`: no declared output means "we were not told", not "there is no result" — an MCP tool with no output schema still answers with something, and code written against `void` either drops that value or misreports it.

This interface serves **three** consumers at once:

1. **The AI** — it goes into the context when generating flow code (exactly the Code Mode model: "the whole API in ~1,000 tokens"); the AI writes typed code with autocomplete-grade accuracy.
2. **The analyzer** — tool calls are resolved by symbol: a call expression is a tool node if and only if its symbol belongs to the `Tools` interface. No string matching, nothing that breaks under aliasing/renaming/destructuring.
3. **The sandbox runtime (future)** — `tools` is exactly the binding object injected at execution time; the interface is the contract between the code and the runtime.

The same codegen applies to the **function library**: from the `FunctionDefinition`s, a module declaration is generated for `modulePath` (e.g. `@flows/lib.d.ts`) so the AI knows what to import when generating a flow.

**One source of truth — the registry.** Generated files (`tools.d.ts`, `lib.d.ts`) are **derived artifacts**, never a source: each generated file carries a header comment containing the `registryHash` (a fingerprint of the registry at codegen time). `codeflow check` compares the hash in the generated files against the current registry — a mismatch produces a `stale-generated-artifacts` diagnostic ("run `codeflow generate`") instead of quietly yielding a wrong graph. (Core exposes the comparison; the CLI performs it, because core never touches a file system.) `WorkflowGraph.registryHash` lets the UI detect a stale graph when the registry changes while a flow is open ([06-patch-engine.md](06-patch-engine.md) §5). This is how the "no second representation to keep in sync" principle survives: there are two physical copies (in memory + on disk), but only one source, one generation direction, and any divergence is detectable.

**A tool changed or removed while a flow uses it** — same mechanism: a deleted tool turns the call into an `unknown` node (capabilities of `unknown`: [03-data-model.md](03-data-model.md) §11); a tool whose schema changed makes analysis validate `editableFields` against the new `inputSchema` (a field that no longer exists is dropped from the inspector + a diagnostic), and old arguments that no longer fit the new schema produce a diagnostic on the node; scan the whole workspace with `codeflow check`.

## 3. MCP Adapter (`@codeflow-team/mcp`)

```text
MCP Server → tool discovery → MCP schema → ToolDefinition → registry → codegen
```

MCP tools already carry a name/description/JSON Schema, so mapping them to a `ToolDefinition` is nearly 1-1. To the analyzer, whether a tool comes from MCP, a local function or a REST SDK is **indistinguishable and does not need to be distinguished** — they are all entries in `Tools`.

Core does not depend on MCP; the adapter is an optional package.

## 4. Function Library — user-defined functions, stored independently

**A first-class concept, on a par with a tool.** The user (or an AI) writes a function, declares its input/output and saves it to the library — from then on the function exists **independently of any flow**, appears in the node palette, and can be reused in any flow.

```ts
interface FunctionDefinition {
  name: string;               // unique in the library; MUST be a valid TS identifier
                              // (no dots — the registry validates on save; a namespaced
                              //  name like "github.getFiles" belongs to a TOOL, not a function)
  label: string;              // "Is Auth Change"
  description?: string;
  icon?: string;

  inputSchema: Schema;        // a named-fields map { files: "File[]" } (the third shape of
                              // the Schema union — 03-data-model.md §11); the keys MUST match
                              // the parameter names in `code` (validated on save) — this is the
                              // bridge between a named schema and positional args: the editable
                              // field "files" ↔ the parameter of the same name at that position
  outputSchema: Schema;       // "boolean"

  code: string;               // TypeScript source — with the default (file-based) store this
                              // IS the content of the file in the workspace lib/ directory:
                              // the file is the only storage, there is no second copy
  modulePath: string;         // MVP: a single module, "@flows/lib";
                              // multiple modules (@flows/lib/http, ...) come after the MVP

  editableFields?: EditableFieldInput[];
}
```

```ts
// A predicate over ONE file — which is what lets it be used directly as a callback:
// `files.some(isAuthChange)` (canonical example 01 §1, label sugar 04 §2.2b)
registry.registerFunction({
  name: "isAuthChange",
  label: "Is Auth Change",
  inputSchema: { file: "File" },
  outputSchema: "boolean",
  code: `export function isAuthChange(file: File) {
  return /auth|login|oauth|permission/i.test(file.path);
}`,
  modulePath: "@flows/lib"
});
```

```text
┌───────────────────────┐
│ 🔐 Is Auth Change     │
│ File → boolean        │
│ [Edit Code]           │
└───────────────────────┘
```

Lifecycle:

1. **Create**: write it in the UI (Monaco), have the AI generate it, or "promote" an existing local function / custom code node from a flow into a library function;
2. **Save**: through `FunctionLibraryStore` ([03-data-model.md](03-data-model.md) §11 — save has a name conflict check, remove/rename have a usage-check guard). The default store is **file-based over the workspace `lib/` directory** — the real source in `lib/` is the only storage, and the `code` field is just that file's content; a host app can swap in a different store (a DB), but there is always one source. Type resolution for a flow points at the real source through tsconfig paths (`@flows/lib` → `lib/`); `generated/lib.d.ts` exists only to serve AI context ([10-ai-codegen.md](10-ai-codegen.md) §1) and takes no part in compilation. The analyzer still does not analyze the body of a library function (an analyzer choice), while the type checker does see the real source — two layers, two roles;
3. **Use**: drag it from the palette into a flow → the patcher inserts `import { isAuthChange } from "@flows/lib"` plus the call statement;
4. **Edit**: "Edit Code" opens Monaco with the function's source. Changing the signature produces signature-mismatch diagnostics, with a realistic scope: the **currently open** flow shows them immediately (it re-analyzes); other flows show them the next time they are loaded/analyzed (the data model is per-flow, and core keeps no index of "which flow uses which function"); checking the whole workspace in one pass is the job of the CLI `codeflow check`, which walks the `flows/` directory ([10-ai-codegen.md](10-ai-codegen.md) §2);
5. **In the graph**: it is a `function` node with the schema from the definition — the analyzer never has to look inside the function body.

It is like a tool in that it has a schema and lives in the palette; it differs from a tool in that its implementation is TypeScript owned and editable by the user, not an external integration. At execution time the library code is bundled with the flow into the sandbox (a runtime concern — [09-future.md](09-future.md)).

## 4b. Local functions and inline code

- **Local function** (a named function in the flow file, not yet saved to the library): the node is built from the TS signature ([04-analyzer.md](04-analyzer.md) §3); the UI offers "Save to library" to promote it. Naming it the same as a library function already imported in the same file is a TS duplicate-identifier error, caught at L0/type check; label sugar and every resolution go **by symbol**, so a local function that happens to share a name with a registered function is never given the registry's metadata by mistake.
- **Inline custom code** (a statement that does not map): a `code` node — no registry entry needed, source kept verbatim, edited through Monaco.

The escape hatch has several tiers: inline code → local function → library function. The more stable a piece of logic gets, the further up the reuse ladder it can move — and no tier is mandatory.

## 5. NodeDefinition (plugin system)

```ts
interface NodeDefinition {
  type: string;                       // a new NodeType — the union is open, 03-data-model.md §3
  label: string;
  description?: string;
  inputSchema?: Schema;
  outputSchema?: Schema;
  editableFields?: EditableFieldInput[];
  renderer?: NodeRenderer;            // custom React component (registered on the @codeflow-team/react side)
  analyzer?: SemanticAnalyzer;
  patcher?: NodePatcher;
}

// Each register call takes exactly its own definition type:
registry.registerTool(def: ToolDefinition);
registry.registerFunction(def: FunctionDefinition);
registry.registerNode(def: NodeDefinition);
registry.registerAnalyzer(fn: SemanticAnalyzer);
```

## 6. Security

Core **never executes** user/AI code — it only parses, analyzes, displays and patches. Execution belongs to an external sandbox runtime with appropriate isolation (isolate + bindings, no general network access, API keys hidden behind the binding — the Code Mode model). See [09-future.md](09-future.md).

The line between "code that gets run" and "code that does not" is drawn explicitly: `codeflow.config.ts` is **configuration written by the workspace owner** and is executed by the CLI as a build script (like `vite.config.ts`) — it is not flow/user source. Flow code, the `code` of a library function, and anything an AI generates are **never** executed by core or the CLI.
