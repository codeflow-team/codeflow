# 10 — AI Code Generation: Context, Feeding the AI, Validating the Output

CodeFlow is not only a lens for reading code — it is also **the side that prepares the context so the AI generates conforming code in the first place**. The closer the AI's output is to the contract, the better the graph, so this is first-class, not an appendix.

The division of roles is explicit: **core never calls an LLM**. CodeFlow builds the context and validates the output; the host app owns the AI call loop (which model, which transport). This is the analogue of runtime independence — call it *model independence*.

```text
User intent
    ↓
CodeFlow: build GenerationContext  ← registry (tools + function library)
    ↓                              ← flow contract + style guide
Host app: call the LLM with the context
    ↓
AI produces flow code
    ↓
CodeFlow: parse + analyze + validate → diagnostics
    ↓                    ↑
    │  errors? ──── feed the diagnostics back to the AI (bounded retry) ──┘
    ↓
Graph rendered for the user
```

## 1. GenerationContext — what CodeFlow builds for the AI

```ts
interface GenerationContext {
  files: GeneratedFile[];       // the files the AI needs to "see"
  promptSections: PromptSection[]; // the text blocks assembled into the system prompt
  estimatedTokens: number;
}

const ctx = await flow.buildGenerationContext({
  namespaces?: string[];        // scope the tools — see §4
  includeExamples?: boolean;    // few-shot examples
  existingSource?: string;      // when editing rather than creating
  parameterDocs?: boolean;      // also emit an @param line per argument (off by default:
                                // it trades context tokens for argument accuracy)
});
```

What goes into the bundle, in priority order:

| Component | Source | Role |
|---|---|---|
| `tools.d.ts` | codegen from the registry ([05-registry.md](05-registry.md) §2) | the AI learns which tools exist, with what signatures and what JSDoc — "the whole API in ~1,000 tokens", in the spirit of Code Mode |
| `lib.d.ts` (the module declaration for `@flows/lib`) | codegen from the function library | the AI learns which library functions it can import and what they take/return |
| Flow contract | static, shipped with the library | 1 file, `export default async function`, 2 parameters |
| Style guide | static, shipped with the library (`prompts/flow-style.md`, [01-flow-contract.md](01-flow-contract.md) §3) | so the code maps to as many nodes as possible |
| Few-shot examples | static + host additions | 1–2 model flows |
| Existing source | passed in by the host | when the AI is editing an existing flow |

`tools.d.ts` and `lib.d.ts` are **one source serving three consumers** (AI context, analyzer symbol resolution, sandbox binding contract) — nobody is allowed to hand-write a separate copy for the AI, because any divergence means the AI writes code that will not resolve.

## 2. Workspace layout on disk

The standard layout of a "flows workspace" — readable by an AI/agent and loadable by CodeFlow:

```text
my-flows/
├── codeflow.config.ts        # registers tools, MCP servers, the library store
├── flows/
│   ├── security-alert.flow.ts    # one flow per file, .flow.ts extension
│   └── daily-report.flow.ts
├── lib/                      # function library — source owned by the user
│   ├── index.ts              # re-exports every function
│   └── is-auth-change.ts
├── generated/                # produced by CodeFlow, never hand-edited
│   ├── tools.d.ts
│   └── lib.d.ts
└── prompts/
    └── flow-style.md         # the style guide (copied from the library, host-customizable)
```

- `generated/` is regenerated whenever the registry/library changes (`codeflow generate`); it is committed to the repo so an agent harness can read it without running anything.
- `.flow.ts` files import from `../generated/tools` (types) and `@flows/lib` (an alias pointing at `lib/`) — the tsconfig paths are produced by the config.
- A host app is not required to use this layout (everything is reachable through the API), but this is the default convention so that all tooling — AI, CLI, UI — agrees on the same thing.

## 3. Feeding it to the AI — 3 delivery modes

CodeFlow supplies the context; how it is delivered is up to the host:

1. **Direct prompt assembly** — the host app calls the LLM API itself: concatenate `ctx.promptSections` into the system prompt and attach `ctx.files` as fenced code blocks. This is for products with their own chat loop.
2. **File-based, for an agent harness** (Claude Code, Cursor, …) — the workspace layout in §2 *is* the context: the agent reads `generated/*.d.ts` and `prompts/flow-style.md` as ordinary files, and a section in the workspace's `CLAUDE.md`/`AGENTS.md` points the agent at them. `codeflow generate --agent-md` emits that section.
3. **MCP** — `@codeflow/mcp` exposes CodeFlow itself as an MCP server: a `codeflow://context` resource (returning the GenerationContext) and a `codeflow.validate(source)` tool (returning diagnostics). Any MCP-capable agent can then generate and self-validate flow code without a dedicated host app.

## 4. Scoping the context — keep it small so the AI stays accurate

A large registry (hundreds of tools) cannot all go into the context. The strategy has tiers:

1. the host app knows the domain up front → pass `namespaces: ["github", "slack"]`;
2. it does not → two-stage: stage 1 gives the AI a **short catalogue** (namespaces + a one-line description per tool) to choose from, stage 2 builds the full context for the chosen subset only;
3. the function library would be scoped the same way, by tag/category on `FunctionDefinition` (no such field exists in the MVP shape — this belongs with the post-MVP items in §8).

The target: a typical context under ~2,000 tokens for the tools/lib portion (the Code Mode reference point: the whole API in ~1,000 tokens).

## 5. Validating the output — what "conforming code" means

When the AI returns code, CodeFlow scores it at 3 conformance levels (plus `invalid` for code that does not parse or does not follow the flow contract at all — no default export, not `async`, wrong parameter count):

| Level | Condition | What happens on failure |
|---|---|---|
| **L0 — valid** (required) | parses; follows the flow contract (1 default export, right signature); value imports are in the allowlist (default: `@flows/lib` plus every registered library module path; the host can extend it — e.g. to allow `zod`); **type-only imports are allowed from anywhere in the workspace**; type-check passes (when the validating environment has a type checker) | `error` diagnostics → **feed them back to the AI**, at most N times (default 2); still failing → return the error to the host. An import outside the allowlist that still resolves → **warning + code node** (degradation, matching [01-flow-contract.md](01-flow-contract.md) §4), not a hard fail. The one hard fail is a **value import from `generated/*`**: those artifacts are `.d.ts`, so such an import cannot resolve by construction in any workspace, and it is a mistake models do make |
| **L1 — everything resolves** | every tool/library call resolves to a node; nothing is called that does not exist | as above — usually the AI invented a tool name; the diagnostic spells it out: "tool `x.y` is not in the registry, closest matches: …". `unresolved-tool`, `unresolved-library-function` and any `unknown` node in the graph all drop the result back to L0 |
| **L2 — maps well** (the quality target) | zero hidden-call diagnostics (`hidden-call-in-expression`, `unsupported-optional-chaining`) and no **code node containing a call** (`inline-logic-in-code-node` — a call hidden inside a code node is a step missing from the graph). A code node with **no call** (e.g. `let attempt = 0`, `attempt += 1` for a while-counter) is permitted plumbing — an absolute "zero code nodes" rule would make L2 unreachable, because the style guide itself requires that counter. `unbounded-loop-risk` and `multiple-exports` stay warnings that do **not** block L2 | not blocking — the code still runs correctly; it is measured as a **conformance rate** in the eval suite ([11-testing.md](11-testing.md) §3.6) and used to improve the style guide / context builder |

The retry loop uses the analyzer's own `Diagnostic[]` as feedback — there is no separate error system for the AI. Diagnostics therefore have to be written so **an AI can read and act on them**: a code, a position, a concrete suggestion.

## 6. AI editing an existing flow

Two paths, both going through the standard machinery:

1. **Node-level** (preferred): the user describes a change to one node → the AI produces new values for the editable fields → they are applied through the patch engine exactly like a manual edit ([06-patch-engine.md](06-patch-engine.md)). Minimal, safe, identity preserved.
2. **Source-level**: the AI edits/regenerates the whole file (large, structural changes) → CodeFlow treats it as "the source changed externally": re-analyze, best-effort identity ([03-data-model.md](03-data-model.md) §5.3), conflict detection if the UI is open.

## 7. API sketch

```ts
const ctx = await flow.buildGenerationContext({ namespaces: ["github", "slack"] });

// the host app calls the LLM with ctx …

const check = await flow.validate(generatedSource);
// { level: "L0" | "L1" | "L2" | "invalid", diagnostics: Diagnostic[] }

const graph = await flow.analyze(generatedSource); // once it is valid
```

## 8. MVP scope

In the MVP: `buildGenerationContext` (direct + file-based delivery), the workspace layout, the CLI `codeflow generate` and `codeflow check` (workspace-wide scanning — needed for the change/remove loop on tools and library functions, [05-registry.md](05-registry.md) §4), and `validate` with L0/L1; the retry loop is the host's responsibility (CodeFlow only supplies good enough diagnostics). After the MVP: MCP server mode, two-stage tool selection, an automated conformance eval harness.
