# CodeFlow — Specs

**Trạng thái:** Draft v0.2 (viết lại từ `../codeflow-specs-vi.md` v0.1 sau khi chốt lại idea và scope)

**Nguyên tắc cốt lõi:** Code là source of truth. Workflow là projection trực quan, chỉnh sửa được, của code.

## Mục lục

| File | Nội dung |
|---|---|
| [00-overview.md](00-overview.md) | Idea, vấn đề, mục tiêu, non-goals, nguyên tắc thiết kế |
| [01-flow-contract.md](01-flow-contract.md) | **Flow code contract** — input của CodeFlow là gì, AI style guide |
| [02-architecture.md](02-architecture.md) | Kiến trúc tổng thể, pipeline hai chiều, cấu trúc package |
| [03-data-model.md](03-data-model.md) | WorkflowGraph, node, edge, source mapping, stable identity |
| [04-analyzer.md](04-analyzer.md) | Semantic analyzer — quy tắc map code → graph |
| [05-registry.md](05-registry.md) | Tool registry, typed API codegen, MCP adapter, **function library** (user-defined, lưu độc lập), custom code |
| [06-patch-engine.md](06-patch-engine.md) | Workflow → code: editable fields, expressions, patch, conflict |
| [07-ui.md](07-ui.md) | UI architecture, components, progressive disclosure |
| [08-mvp.md](08-mvp.md) | MVP scope, build order, testing, acceptance criteria |
| [09-future.md](09-future.md) | Hướng mở rộng sau MVP, quan hệ với sandbox runtime |
| [10-ai-codegen.md](10-ai-codegen.md) | AI generate code: GenerationContext, workspace layout, cách nạp cho AI, validate L0/L1/L2 |
| [11-testing.md](11-testing.md) | Correctness goals, invariants I1–I7, test layers, fixture corpus, CI gates |

## Đọc nhanh

Nếu chỉ đọc một file: [00-overview.md](00-overview.md).

Nếu muốn hiểu vì sao project này khả thi hơn "visualize TypeScript tổng quát": [01-flow-contract.md](01-flow-contract.md) — đây là quyết định thiết kế quan trọng nhất của v0.2.
