# 05 — Registry, Typed Tools API, MCP, Function Library, Custom Code

Registry là nơi khai báo mọi thứ có thể trở thành node. Toàn bộ visual semantics mở rộng qua registry, không sửa core.

Node đến từ **3 nguồn**, đều ngang hàng trong palette:

```text
┌────────────────────────────────────────────────┐
│                    Registry                    │
│                                                │
│  Tools/MCP          Function Library   Node    │
│  (integration       (user-defined,     types   │
│   có sẵn)            lưu độc lập,      (plugin)│
│                      input/output,             │
│                      tái sử dụng)              │
└───────────┬──────────────┬─────────────────────┘
            ▼              ▼
        tool node     function node        code node
                                           (inline, fallback,
                                            không cần registry)
```

## 1. ToolDefinition

```ts
interface ToolDefinition {
  name: string;               // "github.getFiles" — namespace.method
  label: string;              // "Get PR Files"
  description?: string;
  icon?: string;

  // Schema = JSON Schema object HOẶC TS type ref string — định nghĩa và
  // quy tắc chuyển đổi ở 03-data-model.md §11. MCP tools mang JSON Schema;
  // ví dụ trong docs dùng TS ref cho gọn.
  inputSchema: Schema;
  outputSchema?: Schema;

  editableFields?: EditableFieldInput[];  // xem 06-patch-engine.md §1

  analyzer?: SemanticAnalyzer;        // override cách phân tích call này
  patcher?: NodePatcher;              // override cách patch call này
}
```

## 2. Typed Tools API codegen — điểm khớp với Code Mode

Registry không chỉ là metadata thụ động. Từ danh sách `ToolDefinition`, CodeFlow **sinh ra typed TypeScript API**:

```ts
// tools.d.ts — generated
export interface Tools {
  github: {
    /** Get new pull requests */
    getNewPRs(input: { repo: string }): Promise<PullRequest[]>;
    /** Get files changed in a PR */
    getFiles(input: { pr: PullRequest }): Promise<File[]>;
  };
  slack: {
    /** Send a Slack message */
    send(input: { channel: string; message: string }): Promise<void>;
  };
}
```

Interface này phục vụ **ba** bên cùng lúc:

1. **AI** — được đưa vào context khi generate flow code (đúng mô hình Code Mode: "cả API trong ~1.000 token"); AI viết code có type, có autocomplete-quality.
2. **Analyzer** — resolve tool call bằng symbol: một call expression là tool node khi và chỉ khi symbol của nó thuộc interface `Tools`. Không string matching, không vỡ khi alias/rename/destructure.
3. **Sandbox runtime (tương lai)** — `tools` chính là binding object được inject khi execute; interface là contract giữa code và runtime.

Codegen áp dụng cho cả **function library**: từ các `FunctionDefinition`, sinh ra module declaration cho `modulePath` (vd `@flows/lib.d.ts`) — AI biết import gì khi generate flow.

**Một nguồn sự thật duy nhất — registry.** Generated files (`tools.d.ts`, `lib.d.ts`) là **derived artifacts**, không bao giờ là nguồn: mỗi file sinh ra mang header comment chứa `registryHash` (fingerprint của registry lúc codegen). Khi analyze, CodeFlow so hash trong generated files với registry hiện tại — lệch → diagnostic `stale-generated-artifacts` ("chạy `codeflow generate`") thay vì âm thầm cho ra graph sai. `WorkflowGraph.registryHash` cho phép UI phát hiện graph stale khi registry đổi lúc đang mở ([06-patch-engine.md](06-patch-engine.md) §5). Đây là cách giữ nguyên tắc "không có representation thứ hai cần sync": có hai bản thể vật lý (in-memory + on-disk) nhưng chỉ một nguồn, một chiều sinh, và lệch thì phát hiện được.

**Tool đổi/xóa khi flow đang dùng** — cùng cơ chế: tool bị xóa → call thành `unknown` node (capabilities của unknown: [03-data-model.md](03-data-model.md) §11); tool đổi schema → analyze validate `editableFields` với `inputSchema` mới (field không còn tồn tại → bỏ khỏi inspector + diagnostic), argument cũ lệch schema mới → diagnostic trên node; quét toàn workspace bằng `codeflow check`.

## 3. MCP Adapter (`@codeflow/mcp`)

```text
MCP Server → tool discovery → MCP schema → ToolDefinition → registry → codegen
```

MCP tool có sẵn name/description/JSON Schema — map sang `ToolDefinition` gần như 1-1. Với analyzer, tool đến từ MCP hay local function hay REST SDK là **không phân biệt được và không cần phân biệt** — tất cả đều là entry trong `Tools`.

Core không phụ thuộc MCP; adapter là optional package.

## 4. Function Library — user-defined functions lưu độc lập

**First-class concept ngang hàng với tool.** User (hoặc AI) viết một function, khai báo input/output, lưu vào library — từ đó function tồn tại **độc lập với mọi flow**, xuất hiện trong node palette, và tái sử dụng được ở flow bất kỳ.

```ts
interface FunctionDefinition {
  name: string;               // unique trong library; PHẢI là TS identifier hợp lệ
                              // (không dấu chấm — registry validate khi save; tên có
                              //  namespace kiểu "github.getFiles" là của TOOL, không phải function)
  label: string;              // "Is Auth Change"
  description?: string;
  icon?: string;

  inputSchema: Schema;        // named-fields map { files: "File[]" } (dạng thứ 3 của
                              // union Schema — 03-data-model.md §11); key PHẢI trùng tên
                              // tham số trong `code` (validate khi save) — đây là cầu nối
                              // named-schema ↔ positional args: editable field "files"
                              // ↔ tham số cùng tên ở vị trí tương ứng
  outputSchema: Schema;       // "boolean"

  code: string;               // source TypeScript — với default store (file-based),
                              // đây CHÍNH LÀ nội dung file trong lib/ của workspace:
                              // file là storage duy nhất, không có bản sao thứ hai
  modulePath: string;         // MVP: một module duy nhất "@flows/lib";
                              // đa module (@flows/lib/http, ...) sau MVP

  editableFields?: EditableFieldInput[];
}
```

```ts
registry.registerFunction({
  name: "isAuthChange",
  label: "Is Auth Change",
  inputSchema: { files: "File[]" },
  outputSchema: "boolean",
  code: `export function isAuthChange(files: File[]) {
  return files.some(f => /auth|login|oauth|permission/i.test(f.path));
}`,
  modulePath: "@flows/lib"
});
```

```text
┌───────────────────────┐
│ 🔐 Is Auth Change     │
│ File[] → boolean      │
│ [Edit Code]           │
└───────────────────────┘
```

Vòng đời:

1. **Tạo**: viết trên UI (Monaco) hoặc AI generate, hoặc "promote" một local function / custom code node đang có trong flow thành library function;
2. **Lưu**: qua `FunctionLibraryStore` ([03-data-model.md](03-data-model.md) §11 — save có conflict check theo tên, remove/rename có usage-check guard). Default store là **file-based trên `lib/` của workspace** — source thật trong `lib/` là storage duy nhất, `code` field chỉ là nội dung file đó; host app có thể thay store khác (DB) nhưng luôn một nguồn. Type resolution của flow trỏ về source thật qua tsconfig paths (`@flows/lib` → `lib/`); `generated/lib.d.ts` chỉ phục vụ AI context ([10-ai-codegen.md](10-ai-codegen.md) §1), không tham gia compile. Analyzer vẫn không phân tích thân library function (lựa chọn của analyzer); type checker thì thấy source thật — hai tầng, hai vai;
3. **Dùng**: kéo từ palette vào flow → patcher chèn `import { isAuthChange } from "@flows/lib"` + call statement;
4. **Sửa**: "Edit Code" mở Monaco với source của function. Đổi signature → signature-mismatch diagnostics, với phạm vi thực tế: flow **đang mở** hiện diagnostic ngay (re-analyze); các flow khác hiện khi được load/analyze lần sau (data model là per-flow, core không giữ index "flow nào dùng function nào"); kiểm tra toàn workspace một lượt là việc của CLI `codeflow check` quét thư mục `flows/` ([10-ai-codegen.md](10-ai-codegen.md) §2);
5. **Trong graph**: là `function` node với schema từ definition — analyzer không cần nhìn vào thân function.

Giống tool ở chỗ có schema và ở trong palette; khác tool ở chỗ implementation là code TypeScript do user sở hữu và sửa được, không phải integration bên ngoài. Khi execute, code library được bundle cùng flow vào sandbox (runtime concern — [09-future.md](09-future.md)).

## 4b. Local functions và inline code

- **Local function** (named function trong file flow, chưa lưu vào library): node dựng từ TS signature ([04-analyzer.md](04-analyzer.md) §3); UI cho phép "Save to library" để promote. Trùng tên với một library function đang được import trong cùng file → TS duplicate-identifier error, bị chặn từ L0/type check; label sugar và mọi resolve đều theo **symbol** nên local function trùng tên với một registered function KHÔNG bị gán nhầm metadata của registry.
- **Inline custom code** (statement không map được): `code` node, không cần registry, giữ nguyên source, edit qua Monaco.

Escape hatch nhiều tầng: inline code → local function → library function — logic càng ổn định càng được kéo lên tầng tái sử dụng cao hơn, và không tầng nào bắt buộc.

## 5. NodeDefinition (plugin system)

```ts
interface NodeDefinition {
  type: string;                       // NodeType mới — union mở, 03-data-model.md §3
  label: string;
  description?: string;
  inputSchema?: Schema;
  outputSchema?: Schema;
  editableFields?: EditableFieldInput[];
  renderer?: NodeRenderer;            // custom React component (đăng ký phía @codeflow/react)
  analyzer?: SemanticAnalyzer;
  patcher?: NodePatcher;
}

// Mỗi register nhận đúng definition type của nó:
registry.registerTool(def: ToolDefinition);
registry.registerFunction(def: FunctionDefinition);
registry.registerNode(def: NodeDefinition);
registry.registerAnalyzer(fn: SemanticAnalyzer);
```

## 6. Security

Core **không bao giờ execute** user/AI code — chỉ parse, analyze, display, patch. Execution thuộc về sandbox runtime bên ngoài với isolation phù hợp (isolate + bindings, không network access chung, API key giấu sau binding — mô hình Code Mode). Xem [09-future.md](09-future.md).

Ranh giới "code nào được chạy" nói tường minh: `codeflow.config.ts` là **cấu hình do chủ workspace viết**, được CLI thực thi như một build script (ngang hàng `vite.config.ts`) — đây không phải flow/user source. Flow code, library function `code`, và mọi thứ AI generate thì **không bao giờ** được core/CLI execute.
