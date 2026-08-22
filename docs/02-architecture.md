# 02 — Kiến trúc

## 1. Pipeline hai chiều

```text
                    AI / Developer
                         │ generate / edit
                         ▼
               ┌───────────────────┐
               │ TypeScript Source │  ◄── SOURCE OF TRUTH
               └─────────┬─────────┘
                         │
              ┌──────────▼──────────┐
              │       Parser        │  ts-morph / TS Compiler API
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │  Semantic Analyzer  │  control flow · data flow ·
              │                     │  tool resolution (qua type checker) ·
              │                     │  node mapping · diagnostics
              └──────────┬──────────┘
                         │              ┌──────────────┐
              ┌──────────▼──────────┐   │   Registry   │
              │   Workflow Graph    │◄──│  tools / MCP │
              │    (projection)     │   │  / functions │
              └──────────┬──────────┘   └──────────────┘
                         │
              ┌──────────▼──────────┐
              │    Layout (ELK)     │  chỉ tính x/y, không đổi semantics
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │   React Flow UI     │  canvas · inspector · Monaco
              └──────────┬──────────┘
                         │ user edit node
              ┌──────────▼──────────┐
              │    Patch Engine     │  resolve node → verify fingerprint →
              │                     │  transform AST → minimal patch
              └──────────┬──────────┘
                         │
                         ▼
               TypeScript Source  ──→  re-analyze → graph diff → UI update
```

Execution nằm ngoài pipeline: source được giao cho sandbox runtime (isolate + bindings kiểu Code Mode, hoặc Temporal/Inngest/custom) — xem [09-future.md](09-future.md).

## 2. Cấu trúc package (MVP)

Monorepo pnpm + Turborepo, **4 packages**:

```text
packages/
├── core/     @codeflow/core   — browser-safe, không Node API
├── react/    @codeflow/react
├── mcp/      @codeflow/mcp
└── cli/      codeflow (bin)   — Node-only: generate, check, watch
```

`cli` tách riêng vì cần fs/watch (Node API) — không được kéo vào core (core phải chạy được ở browser). CLI gồm: `codeflow generate` (sinh `generated/*.d.ts` từ config/registry), `codeflow check` (quét thư mục `flows/`, analyze từng flow, báo diagnostics toàn workspace — cơ chế bắt break cross-flow khi đổi/xóa tool hay library function), `codeflow generate --agent-md`.

### `@codeflow/core`

Toàn bộ engine, không phụ thuộc React, chạy được ở Node lẫn browser:

- domain model: graph, node, edge, source mapping, diagnostics, events;
- parser layer (ts-morph / TS Compiler API, đằng sau abstraction);
- semantic analyzer;
- mapper (stable identity, semantic path, fingerprint);
- patch engine;
- registry (tool/function/node definitions, typed API codegen);
- validation.

Nội bộ chia module theo đúng các phần trên (`core/src/{model,parser,analyzer,mapper,patcher,registry}`), nhưng **không tách package** — các phần này đổi API cùng nhau liên tục trong giai đoạn đầu, tách package chỉ tạo friction. Sau 1.0, khi API ổn định, có thể tách dần (parser, analyzer, patcher...) mà không đổi public API.

### `@codeflow/react`

UI layer:

- React Flow canvas, custom nodes/edges, minimap, controls, palette;
- ELK.js layout (async, chỉ trả về positions);
- Node inspector (forms từ schema, shadcn/ui);
- Monaco code view / custom-code editor / diff view;
- providers, hooks, state sync với core.

### `@codeflow/mcp`

Adapter optional: MCP tool discovery → `ToolDefinition` → registry. Core không phụ thuộc MCP.

## 3. Parser strategy

**MVP dùng duy nhất TypeScript Compiler API + ts-morph.** Lý do:

- Flow file theo contract chỉ vài trăm dòng — full re-parse + re-analyze vẫn nằm trong performance target (xem [08-mvp.md](08-mvp.md)); incremental parsing là premature optimization.
- Dựng graph chỉ cần **parse + scope analysis** (tool resolution là binding-rooted — [04-analyzer.md](04-analyzer.md) §1.2, không cần type checker); TS **type checker** là tầng enrichment/validation tách rời, chạy async ở Node/CI hoặc worker, không nằm trên đường nóng của việc dựng graph — nhờ đó core chạy được ở browser mà không phải nạp lib.d.ts trên đường render.
- Hai parser song song (Tree-sitter + TSC) là gánh phức tạp lớn nhất của draft v0.1 mà không mua được gì ở scale MVP.

Parser nằm sau abstraction để giữ cửa cho Tree-sitter (incremental) khi có nhu cầu thật:

```ts
interface Parser {
  parse(source: string): SyntaxTree;
  update(previous: SyntaxTree, source: string, changes: TextChange[]): SyntaxTree;
}
```

MVP: `update` = full re-parse. Contract không đổi khi sau này thay implementation.

## 4. Public API — `CodeFlowSession`

Object `flow` xuất hiện trong các ví dụ xuyên suốt specs (`flow.analyze`, `flow.patchNode`, `flow.validate`, `flow.buildGenerationContext`) là một **session**:

```ts
import { createCodeFlow } from "@codeflow/core";

const flow = createCodeFlow({
  registry,                    // bắt buộc — analyzer cần registry (04 §1)
  libraryStore?,               // FunctionLibraryStore
  parser?,                     // override Parser implementation
});
```

Session giữ state: registry (+ `registryHash`), warm parse tree/Project (phục vụ target <100ms), và **graph gần nhất** — nền cho identity continuity ([03-data-model.md](03-data-model.md) §5.0): re-analyze trong cùng session mang id qua bằng resolution; session mới là cold analyze. UI (`<CodeFlowProvider>`) nhận session (hoặc graph+registry lấy từ session) — một nguồn, không truyền registry rời rạc hai đường.

## 5. Technology stack

| Layer | Công nghệ | Ghi chú |
|---|---|---|
| Language | TypeScript | toàn bộ SDK |
| Parser + semantics | TS Compiler API + ts-morph | duy nhất ở MVP |
| Graph model | Custom | semantic representation |
| Layout | ELK.js | auto layout, async |
| Canvas | React Flow | workflow editor |
| Code editor | Monaco | developer / custom-code view |
| UI primitives | shadcn/ui | inspector forms |
| MCP | MCP SDK | adapter optional |
| Test | Vitest + Claude in Chrome | core (unit/fixture/property) + UI e2e agent-driven |
| Monorepo | pnpm + Turborepo | |
