# 10 — AI Code Generation: Context, Nạp cho AI, Validate Output

CodeFlow không chỉ là lens đọc code — nó còn là **bên chuẩn bị context để AI generate code đúng chuẩn ngay từ đầu**. Code AI sinh ra càng đúng contract thì graph càng đẹp, nên phần này là first-class, không phải tài liệu phụ.

Phân vai rõ: **core không gọi LLM**. CodeFlow build context + validate output; host app sở hữu vòng gọi AI (model nào, transport nào). Tương tự runtime independence — đây là *model independence*.

```text
User intent
    ↓
CodeFlow: build GenerationContext  ← registry (tools + function library)
    ↓                              ← flow contract + style guide
Host app: gọi LLM với context
    ↓
AI sinh flow code
    ↓
CodeFlow: parse + analyze + validate → diagnostics
    ↓                    ↑
    │  errors? ──── feed diagnostics lại AI (bounded retry) ──┘
    ↓
Graph render cho user
```

## 1. GenerationContext — CodeFlow build gì cho AI

```ts
interface GenerationContext {
  files: GeneratedFile[];       // các file AI cần "nhìn thấy"
  promptSections: PromptSection[]; // các đoạn text ghép vào system prompt
  estimatedTokens: number;
}

const ctx = await flow.buildGenerationContext({
  namespaces?: string[];        // scope tools — xem §4
  includeExamples?: boolean;    // few-shot examples
  existingSource?: string;      // khi là edit, không phải tạo mới
});
```

Nội dung bundle, theo thứ tự ưu tiên:

| Thành phần | Nguồn | Vai trò |
|---|---|---|
| `tools.d.ts` | codegen từ registry ([05-registry.md](05-registry.md) §2) | AI biết có tool gì, signature gì, JSDoc mô tả gì — "cả API trong ~1.000 token" đúng tinh thần Code Mode |
| `lib.d.ts` (module declaration của `@flows/lib`) | codegen từ function library | AI biết có library function nào để import, input/output gì |
| Flow contract | static, ship kèm lib | 1 file, export default async function, 2 tham số |
| Style guide | static, ship kèm lib (`prompts/flow-style.md`, [01-flow-contract.md](01-flow-contract.md) §3) | code map được tối đa ra node |
| Few-shot examples | static + host bổ sung | 1–2 flow mẫu chuẩn |
| Existing source | host truyền vào | khi AI đang sửa flow có sẵn |

`tools.d.ts` và `lib.d.ts` là **một nguồn duy nhất phục vụ 3 bên** (AI context, analyzer symbol resolution, sandbox binding contract) — không được viết tay bản riêng cho AI, vì lệch nhau là AI sinh code không resolve được.

## 2. Cấu trúc workspace trên disk

Layout chuẩn cho một "flows workspace" — vừa cho AI/agent đọc, vừa cho CodeFlow load:

```text
my-flows/
├── codeflow.config.ts        # đăng ký tools, MCP servers, library store
├── flows/
│   ├── security-alert.flow.ts    # mỗi flow 1 file, đuôi .flow.ts
│   └── daily-report.flow.ts
├── lib/                      # function library — source do user sở hữu
│   ├── index.ts              # re-export mọi function
│   └── is-auth-change.ts
├── generated/                # CodeFlow sinh ra, không sửa tay
│   ├── tools.d.ts
│   └── lib.d.ts
└── prompts/
    └── flow-style.md         # style guide (copy từ lib, host tùy biến được)
```

- `generated/` được re-generate mỗi khi registry/library đổi (watch hoặc CLI `codeflow generate`); commit vào repo để agent harness đọc được mà không cần chạy gì.
- `.flow.ts` import từ `../generated/tools` (types) và `@flows/lib` (alias trỏ `lib/`) — tsconfig paths do config sinh.
- Host app không bắt buộc dùng layout này (mọi thứ đi qua API đều được), nhưng đây là convention mặc định để mọi tooling — AI, CLI, UI — cùng hiểu.

## 3. Cách nạp vào AI — 3 delivery modes

CodeFlow cung cấp context; nạp bằng đường nào tùy host:

1. **Direct prompt assembly** — host app gọi LLM API trực tiếp: ghép `ctx.promptSections` vào system prompt, đính `ctx.files` dạng fenced code blocks. Dùng cho product có vòng chat riêng.
2. **File-based cho agent harness** (Claude Code, Cursor, …) — workspace layout ở §2 chính là context: agent đọc `generated/*.d.ts` + `prompts/flow-style.md` như file thường; một đoạn trong `CLAUDE.md`/`AGENTS.md` của workspace trỏ agent tới đó. CLI `codeflow generate --agent-md` sinh sẵn đoạn này.
3. **MCP** — `@codeflow/mcp` expose ngược CodeFlow như một MCP server: resource `codeflow://context` (trả về GenerationContext), tool `codeflow.validate(source)` (trả về diagnostics). Agent bất kỳ có MCP đều generate + tự validate được flow code mà không cần host app riêng.

## 4. Scope context — giữ nhỏ để AI chính xác

Registry lớn (hàng trăm tool) → không nhét hết vào context. Chiến lược theo tầng:

1. host app biết trước domain → truyền `namespaces: ["github", "slack"]`;
2. không biết trước → two-stage: stage 1 đưa AI **danh mục ngắn** (namespace + mô tả 1 dòng mỗi tool) để nó chọn, stage 2 build context đầy đủ chỉ với phần đã chọn;
3. function library scope tương tự theo tag/category trong `FunctionDefinition`.

Mục tiêu: context điển hình dưới ~2.000 token cho phần tools/lib (tham chiếu Code Mode: cả API trong ~1.000 token).

## 5. Validate output — định nghĩa "code chuẩn"

AI trả code về, CodeFlow chấm theo 3 mức conformance:

| Mức | Điều kiện | Xử lý khi fail |
|---|---|---|
| **L0 — hợp lệ** (bắt buộc) | parse được; đúng flow contract (1 default export, đúng signature); value-imports thuộc allowlist (mặc định: `generated/tools`, `@flows/lib`; host mở rộng được — vd cho phép `zod`); **type-only imports được phép từ mọi nơi trong workspace**; type-check pass (khi môi trường validate có type checker) | diagnostics dạng `error` → **feed lại AI sửa**, tối đa N lần (mặc định 2); vẫn fail → trả lỗi cho host. Import ngoài allowlist nhưng resolve được → **warning + code node** (degradation, khớp [01-flow-contract.md](01-flow-contract.md) §4), không phải hard fail |
| **L1 — resolve đủ** | mọi tool/library call resolve ra node; không call tới thứ không tồn tại | như trên — thường là AI bịa tool name; diagnostic ghi rõ "tool `x.y` không có trong registry, các tool gần nhất: …" |
| **L2 — map đẹp** (mục tiêu chất lượng) | không có custom-code node *ngoài ý muốn* (logic lẽ ra là tool call/named function lại viết inline; hidden-call diagnostics = 0) | không chặn — code vẫn chạy đúng; đo bằng **conformance rate** trong eval suite ([11-testing.md](11-testing.md) §3.6) để cải thiện style guide/context builder |

Vòng retry dùng chính `Diagnostic[]` của analyzer làm feedback — không có hệ thống lỗi riêng cho AI. Diagnostics vì vậy phải viết **cho AI đọc được và sửa được**: có code, vị trí, gợi ý cụ thể.

## 6. AI sửa flow đang có

Hai đường, cả hai đều đi qua cơ chế chuẩn:

1. **Node-level** (khuyến khích): user mô tả thay đổi trên một node → AI sinh giá trị mới cho editable fields → apply qua patch engine như user edit tay ([06-patch-engine.md](06-patch-engine.md)). Minimal, an toàn, identity giữ nguyên.
2. **Source-level**: AI sửa/regenerate cả file (thay đổi lớn, structural) → CodeFlow xử lý như "source đổi từ bên ngoài": re-analyze, identity best-effort ([03-data-model.md](03-data-model.md) §5.3), conflict detection nếu UI đang mở.

## 7. API sketch

```ts
const ctx = await flow.buildGenerationContext({ namespaces: ["github", "slack"] });

// host app tự gọi LLM với ctx …

const check = await flow.validate(generatedSource);
// { level: "L0" | "L1" | "L2" | "invalid", diagnostics: Diagnostic[] }

const graph = await flow.analyze(generatedSource); // khi đã hợp lệ
```

## 8. Phạm vi MVP

Trong MVP: `buildGenerationContext` (direct + file-based delivery), workspace layout + CLI `codeflow generate` và `codeflow check` (quét toàn workspace — cần cho vòng đổi/xóa tool và library function, [05-registry.md](05-registry.md) §4), `validate` với L0/L1, retry loop là trách nhiệm host (CodeFlow chỉ cung cấp diagnostics đủ tốt). Sau MVP: MCP server mode, two-stage tool selection, conformance eval harness tự động.
