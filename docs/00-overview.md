# 00 — Overview

## 1. Idea

CodeFlow is a **code-to-workflow compiler and bidirectional editing layer** for TypeScript.

Context: the "Code Mode" model (Cloudflare) showed that the best way for an AI to use tools/MCP is to **write TypeScript** that calls them — instead of step-by-step tool calling — and then run that code in a sandbox. Models are trained on real code, so they write code far better than they emit tool-call tokens; and when several tools have to be chained, code pipes output → input directly instead of routing every intermediate result back through the model.

The consequence: more and more "workflows" will exist as **code written by an AI**. But end users cannot read code. CodeFlow is the missing layer:

```text
AI writes TypeScript flow code (calling available functions / MCP tools)
        ↓
CodeFlow projects the code into a workflow graph — the user can SEE it
        ↓
User edits a node in the UI — CodeFlow patches minimally back into the code
        ↓
The (edited) code runs in a sandbox to carry the flow out
```

CodeFlow owns only the two middle arrows. Generation (AI) and execution (sandbox runtime) are outside this library.

## 2. Three invariant propositions

This is the **idea**. Everything else in these specs is implementation and can change; these three cannot.

### 2.1 Code is the source of truth, the workflow is only a projection

There is never a second representation that has to be kept in sync. The graph is **computed** from the code — the way a minimap is computed from text. It cannot drift from the code because it does not exist independently of the code.

### 2.2 Bidirectional, but asymmetric

- Code → workflow: **analysis** (parse, understand semantics, build the graph).
- Workflow → code: a **minimal patch** into exactly the relevant region of source. Never regenerate the file. Comments, formatting, unrelated code — preserved absolutely.

This is what separates CodeFlow from every existing workflow builder: n8n/Zapier treat the graph as truth and emit code from it. CodeFlow goes the other way.

### 2.3 Do not pretend to understand everything

Code that maps to a meaningful node (tool call, condition, loop, parallel) gets mapped. Code that does not map is shown as a **custom code node**, kept verbatim, with no guessed semantics. Expressiveness is therefore never capped — the escape hatch is TypeScript itself.

## 3. The problem

- Code-first is powerful and AI generates code well — but non-developers can neither read nor edit code.
- Visual workflows are approachable — but they create a second representation of the logic, and they confine the user to the programming model of the available nodes.

CodeFlow resolves the tension by keeping code as the single canonical representation and deriving the workflow graph from it, instead of forcing one side to follow the other.

> **Code is for AI and developers. Workflows are for humans.**

## 4. Goals

| # | Goal | Content |
|---|---|---|
| G1 | Code → Workflow | Turn the supported semantics of flow code into a semantic workflow graph |
| G2 | Workflow → Code | An edit in the UI → a minimal source patch |
| G3 | Source preservation | Never regenerate the file; change only the region that has to change |
| G4 | Progressive disclosure | Beginner: visual nodes · Power user: node + config/expression · Developer: full source |
| G5 | Extensibility | Tool / MCP tool / library function (user-written, stored independently, with input/output, reusable) / custom code — all become nodes through the registry, with no changes to core |
| G6 | Graceful degradation | Code that cannot be understood → custom code node, kept verbatim, clearly marked |

## 5. Non-goals

The first version does **not**:

- execute workflows (execution belongs to a sandbox runtime — Temporal, Inngest, isolates, etc.);
- support **arbitrary application code** — the input is flow code that follows a contract ([01-flow-contract.md](01-flow-contract.md)); this is the single most important barrier against scope creep;
- support every TypeScript construct as a visual node;
- invent a new visual programming language;
- turn workflow JSON into the source of truth;
- execute custom code inside the core library.

## 6. Design principles

1. **Source is canonical** — every pipeline starts and ends at source code.
2. **Semantic projection, not AST visualization** — a node represents *meaning* (one step of the flow), not an individual AST node. The MVP keeps the projection close to 1:1 with the supported constructs; smart merging (several statements → one "Transform" node) is deferred past the MVP because it blurs source mapping.
3. **Minimal mutation** — one edit in the workflow may touch only the corresponding source region.
4. **Stable identity** — node identity survives formatting, added lines and unrelated changes. (What exactly is guaranteed: see [03-data-model.md](03-data-model.md).)
5. **Make uncertainty visible** — when unsure, mark unknown/custom; never infer.
6. **Runtime independence** — core depends on no workflow execution engine.
6b. **Tool agnosticism** — core defines, ships and hardcodes no specific tool/MCP/integration. Core only has the frame (`ToolDefinition`, registry, codegen); every concrete tool is registered by the host app at runtime or comes from an optional adapter (`@codeflow/mcp`). With an empty registry every call becomes an unknown/code node and the system is still correct. Every tool name in these docs (`github.*`, `slack.*`) is an example only.
7. **No second expression language** — any "friendly expression syntax" in the UI must be a 1-1 display syntax for a real TypeScript expression ([06-patch-engine.md](06-patch-engine.md)).

## 7. Core moat

Four parts deserve the engineering effort; everything else is assembled infrastructure:

1. **Semantic Analyzer** — code → a workflow that means something.
2. **Stable Node Identity** — nodes that survive source changes.
3. **Source Mapping** — nodes that map back to code precisely.
4. **Minimal Patch Engine** — a visual edit that changes exactly the source it has to.

React Flow, ELK.js, Monaco, ts-morph and the MCP SDK are infrastructure around the core, not differentiators.
