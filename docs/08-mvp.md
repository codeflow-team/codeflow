# 08 — MVP: Scope, Build Order, Testing, Acceptance

## 1. MVP scope

### Input
- TypeScript theo [flow contract](01-flow-contract.md): 1 file flow + imports từ function library. Không JavaScript, không arbitrary code, không phân tích xuyên file vào thân library function.

### Semantics ([04-analyzer.md](04-analyzer.md))
- tool calls (resolve qua typed `Tools` interface); library function calls (resolve qua generated module declaration); local functions; `const` + data dependency; sequential `await`; `if/else`; `for...of`; `while` (kèm bound-check diagnostic); `try/catch(/finally)`; `return`/`break`/`continue`; `Promise.all`; custom code fallback.

### Editing ([06-patch-engine.md](06-patch-engine.md) §2 — danh sách đó là chuẩn)
- primitive arguments; object properties; expressions; condition (`if`/`while`) và iterable expressions; đổi tool tương thích; thêm node từ palette; xóa node (kể cả jump/output, đều qua dependency check); tạo/promote library function; edit custom function và inline code node qua Monaco. **Không structural editing.**

### UI ([07-ui.md](07-ui.md))
- React Flow canvas + ELK layout; inspector; palette; Monaco code view; diagnostics.

### Integration
- typed Tools API codegen; **function library** (FunctionDefinition + store interface + module declaration codegen + palette + save/promote); basic MCP adapter; **AI codegen support** — `buildGenerationContext` + workspace layout + CLI `codeflow generate` + `validate` L0/L1 ([10-ai-codegen.md](10-ai-codegen.md) §8).

## 2. Build order

Thứ tự bắt buộc — UI làm **cuối cùng**, vì UI làm sớm sẽ che bug của 4 phần lõi:

```text
1. core model      — graph/node/edge/mapping types + registry types
   + registry-lite — ToolDefinition/FunctionDefinition + codegen tools.d.ts/lib.d.ts
                     (analyzer resolve tool qua interface Tools, nên codegen phải
                      có TRƯỚC analyzer — dù chỉ ở mức đủ chạy fixtures)
2. analyzer        — code → graph, cùng lúc với ROUND-TRIP TEST HARNESS
                     (code → graph JSON → assert; chưa cần UI)
3. mapper          — stable identity + bộ test identity qua các kịch bản edit
4. patcher         — node edit → minimal patch, assert bằng text diff chính xác
5. registry đầy đủ + mcp — library store, MCP adapter, CLI codeflow generate/check
6. react UI        — canvas/inspector/palette/Monaco trên nền core đã được test
```

Bước 2 là điểm validate sớm nhất: nếu analyzer + harness chạy tốt trên bộ flow mẫu, phần còn lại là engineering đã biết cách làm.

## 3. Testing

Chiến lược test đầy đủ — goals, correctness invariants (I1–I7), 6 test layers, fixture corpus, CI gates — ở [11-testing.md](11-testing.md). Tóm tắt phần gắn với MVP:

- **Round-trip suite là gate quan trọng nhất** (`Code → Graph → Edit → Code' → Graph'` — diff đúng từng ký tự, identity giữ nguyên, idempotent) — toàn bộ trust model sống chết ở đây;
- golden fixture corpus (flow code → expected graph JSON có review) xây song song với analyzer từ bước 2 của build order;
- identity tests phủ kịch bản hiểm nhất: chèn call giống hệt trước call đang có — không được mis-bind ([03-data-model.md](03-data-model.md) §5.2);
- AI conformance evals (đo L0/L1/L2 rate của code AI sinh) chạy định kỳ, không chặn CI.

## 4. Acceptance criteria

Project được xem là validated khi vòng sau chạy được end-to-end:

```text
AI-generated TypeScript (theo contract)
  → workflow hiển thị tự động, đúng cấu trúc
  → user chọn node, edit một supported property
  → minimal source patch (đúng từng ký tự)
  → graph cập nhật, mọi node khác giữ nguyên identity
```

Acceptance test cụ thể (fixture phải type-check pass với `tools.d.ts` mẫu — đủ field bắt buộc):

```ts
await tools.slack.send({ channel: "#security", message: "Auth change detected" });
```

User đổi channel → `#engineering`. Expected:

```diff
- await tools.slack.send({ channel: "#security", message: "Auth change detected" });
+ await tools.slack.send({ channel: "#engineering", message: "Auth change detected" });
```

và **không có bất kỳ thay đổi source nào khác** — kể cả whitespace.

Tiêu chí thứ hai (đến từ mục tiêu Code Mode): flow ví dụ github→slack ([07-ui.md](07-ui.md) §6) với tools đến từ **MCP adapter thật** phải render đúng graph như dùng local registry.
