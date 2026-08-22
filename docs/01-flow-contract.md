# 01 — Flow Code Contract

**Quyết định thiết kế quan trọng nhất của v0.2.** Input của CodeFlow không phải "TypeScript bất kỳ" mà là **flow code theo contract**. Điều này biến analyzer từ bài toán research (reverse-engineer arbitrary code) thành bài toán engineering (phân tích code có cấu trúc biết trước).

Vì code do AI generate và ta kiểm soát được prompt của AI, contract này không phải là giới hạn với user — nó là giao kèo giữa CodeFlow và AI. Code lệch contract vẫn hoạt động (rơi xuống custom code node), nhưng code đúng contract thì map được tối đa ra node.

## 1. Flow unit

**1 flow = 1 file TypeScript, export default một async function duy nhất.**

```ts
import type { Tools } from "../generated/tools";
import { isAuthChange } from "@flows/lib";   // library function — 05-registry.md §4

export default async function flow(
  input: { repository: string },
  tools: Tools
) {
  const prs = await tools.github.getNewPRs({ repo: input.repository });

  for (const pr of prs) {
    const files = await tools.github.getFiles({ pr });

    if (files.some(isAuthChange)) {
      await tools.slack.send({
        channel: "#security",
        message: `Security PR: ${pr.title}`
      });
    }
  }
}
```

> Ví dụ này là **ví dụ chuẩn** dùng xuyên suốt specs (analyzer [04](04-analyzer.md), UI [07](07-ui.md) §6, acceptance [08](08-mvp.md) §4) — graph kỳ vọng của nó được định nghĩa duy nhất tại [07-ui.md](07-ui.md) §6.

Contract này giải quyết đồng thời nhiều bài toán:

| Thành phần | Vai trò |
|---|---|
| `input` (tham số 1) | Trigger payload. **Trigger node** trên UI được dựng từ type của tham số này + metadata bên ngoài (webhook/cron/manual do runtime cấu hình) — không phải đoán từ code. |
| `tools` (tham số 2) | Điểm truy cập duy nhất tới tool/MCP. Typed interface do registry sinh ra ([05-registry.md](05-registry.md)). Analyzer resolve tool call qua **symbol** của interface này, không phải string matching. Đồng thời đây chính là bindings mà sandbox runtime inject khi chạy — hai tầng khớp nhau tự nhiên. |
| Library/local functions | Custom logic (escape hatch). Gọi dạng statement → `function` node; dùng làm callback trong expression → không phải node riêng (xem [04-analyzer.md](04-analyzer.md) §2.2b). |
| Return value | Kết quả flow, hiển thị ở node cuối (output). |

## 1b. Các nguồn callable trong flow

Một bước trong flow có thể gọi tới 4 loại callable — tất cả đều trở thành node, nhưng nguồn gốc và cách resolve khác nhau:

| Nguồn | Trong code | Node | Resolve |
|---|---|---|---|
| **Tool / MCP** | `await tools.github.getFiles({ pr })` | `tool` node | symbol thuộc interface `Tools` (registry sinh ra) |
| **Library function** — function user viết và **lưu độc lập**, có input/output schema, tái sử dụng giữa nhiều flow | `import { isAuthChange } from "@flows/lib"` rồi gọi `isAuthChange(files)` | `function` node (label/icon/schema từ registry) | symbol của import từ function library |
| **Local function** — named function trong cùng file flow | `function normalize(x) {...}` rồi gọi `normalize(data)` | `function` node (schema suy từ TS signature) hoặc node tối thiểu | symbol local |
| **Inline code** — statement/expression không thuộc loại nào ở trên | `const r = x.reduce(...)` | `code` node, giữ nguyên source | fallback |

Library function là first-class ngang hàng với tool: user có thể viết function mới (trên UI qua Monaco hoặc do AI generate), khai báo input/output, **lưu vào function library** — từ đó nó xuất hiện trong node palette như một tool bình thường và dùng lại được ở mọi flow. Xem [05-registry.md](05-registry.md) §4.

## 2. Semantics được hỗ trợ (MVP)

Trong thân function `flow`, analyzer hiểu:

| Construct | Node |
|---|---|
| `await tools.<ns>.<fn>(args)` | Tool node |
| gọi library function (import từ function library) | Function node |
| gọi local named function | Function node / code node |
| `const x = await ...` | Data output (port) của node |
| `if / else` | Condition node + 2 nhánh control |
| `for...of` | Loop node (body là subgraph) |
| `while (cond)` | Loop node (kind: `while`, condition editable) + bound-check diagnostic |
| `try / catch (/ finally)` | Try node — body/catch(/finally) là subgraph, edge `error` |
| `return` sớm | Output node ("End Flow") |
| `break` / `continue` trong loop | Jump node trong loop subgraph |
| `Promise.all([...])` | Parallel node + merge |
| Template literal trong argument | Expression hiển thị dạng `{{ }}` |
| `for await...of` | Như `for...of` |
| Mọi thứ khác | Custom code node (giữ nguyên). Gồm cả: `for(;;)` cổ điển, `do...while`, optional chaining trên tools (`tools.github?.getFiles?.()`), await/tool call giấu trong expression ([04-analyzer.md](04-analyzer.md) §1.4 — kèm diagnostic, không bao giờ im lặng) |

Danh sách này chỉ được mở rộng có chủ đích (xem [09-future.md](09-future.md)); mỗi construct thêm vào làm độ phức tạp của analyzer + patcher nhân lên, không cộng thêm.

## 3. AI style guide

Một system prompt chuẩn (ship kèm library, ví dụ `codeflow/prompts/flow-style.md`) hướng dẫn AI generate code CodeFlow-friendly:

- Mỗi bước của flow là một `await` call **đứng thành statement riêng** (`const x = await tools...`), ở top level của thân flow hoặc trong body của if/for/try — KHÔNG BAO GIỜ đặt tool call bên trong expression: không trong condition (`if (await tools.x.y())` ❌ — hoist ra `const ok = await tools.x.y()` trước), không trong argument của call khác, không trong callback (`Promise.all(prs.map(...))` ❌ — dùng `for...of`, hoặc `Promise.all([...])` với array literal).
- Gán kết quả vào `const` có tên có nghĩa — tên biến trở thành tên data edge trên UI.
- Điều kiện phức tạp → tách ra named function với tên mô tả (`isAuthChange`) — trở thành node đọc được thay vì expression dài.
- Logic biến đổi dữ liệu phức tạp → tách ra named function — trở thành custom code node gọn thay vì rải rác nhiều statement.
- `try/catch` bọc quanh **nhóm bước có thể fail** (một tool call hoặc vài bước liền nhau), không bọc cả thân flow — catch càng hẹp, graph càng đọc được.
- `while` phải có **điều kiện dừng thấy được trong code** (counter/attempt limit được cập nhật trong body) — analyzer cảnh báo khi không nhận diện được bound.
- `return`/`break`/`continue` dùng cho guard/early-exit bình thường; không dùng recursion trong thân flow — nếu cần, gói vào named function.

Style guide là khuyến nghị cho AI, không phải validator chặn code. Code lệch style → nhiều custom code node hơn, ít node có nghĩa hơn — vẫn đúng, chỉ kém đẹp.

## 4. Phạm vi MVP

- **Flow là 1 file** + **imports từ function library**. Library function được resolve qua registry metadata (schema, label) — analyzer KHÔNG phân tích xuyên file vào thân library function (thân nó chỉ mở ra khi user bấm "Edit Code"). Import từ nguồn khác ngoài library → opaque code node.
- **TypeScript only**: JavaScript bỏ khỏi MVP (AI generate TS; thiếu type làm tool resolution kém tin cậy). Thêm lại sau nếu cần.
- **Một flow mỗi file**: nhiều export → chỉ default export được phân tích, còn lại là diagnostics warning.
