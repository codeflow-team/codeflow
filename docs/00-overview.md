# 00 — Tổng quan

## 1. Idea

CodeFlow là một **code-to-workflow compiler và bidirectional editing layer** cho TypeScript.

Bối cảnh: mô hình "Code Mode" (Cloudflare) đã chứng minh cách tốt nhất để AI dùng tools/MCP là **viết code TypeScript** gọi các tool đó — thay vì tool-calling từng bước — rồi chạy code trong sandbox. AI được train trên code thật nên viết code giỏi hơn hẳn dùng tool-call tokens; khi cần chain nhiều tool, code cho phép pipe output → input trực tiếp mà không phải đưa mọi kết quả trung gian qua model.

Hệ quả: ngày càng nhiều "workflow" sẽ tồn tại dưới dạng **code do AI viết**. Nhưng end user không đọc được code. CodeFlow là lớp còn thiếu:

```text
AI viết TypeScript flow code (gọi functions / MCP tools có sẵn)
        ↓
CodeFlow chiếu code thành workflow graph — user XEM được
        ↓
User chỉnh node trên UI — CodeFlow patch tối thiểu ngược vào code
        ↓
Code (đã sửa) chạy trong sandbox để thực hiện flow
```

CodeFlow chỉ đảm nhận hai mũi tên giữa. Việc generate (AI) và execute (sandbox runtime) nằm ngoài library này.

## 2. Ba mệnh đề bất biến

Đây là phần **idea** — mọi thứ khác trong specs là cách triển khai và có thể sửa; ba mệnh đề này thì không.

### 2.1 Code là source of truth, workflow chỉ là projection

Không bao giờ tồn tại representation thứ hai cần sync. Graph được **tính ra** từ code — như minimap được tính ra từ text. Nó không thể lệch với code vì nó không tồn tại độc lập với code.

### 2.2 Hai chiều nhưng bất đối xứng

- Code → workflow: **phân tích** (parse, hiểu semantics, dựng graph).
- Workflow → code: **patch tối thiểu** vào đúng vùng source liên quan. Không bao giờ regenerate file. Comment, formatting, code không liên quan — giữ nguyên tuyệt đối.

Đây là điểm phân biệt với mọi workflow builder hiện có: n8n/Zapier coi graph là truth rồi sinh code; CodeFlow làm ngược lại.

### 2.3 Không giả vờ hiểu hết

Code map được sang node có nghĩa (tool call, condition, loop, parallel) thì map. Code không map được thì hiển thị là **custom code node**, giữ nguyên source, không đoán bừa semantics. Nhờ đó expressiveness không bao giờ bị giới hạn — escape hatch luôn là chính TypeScript.

## 3. Vấn đề

- Code-first rất mạnh, AI generate code rất giỏi — nhưng non-developer không đọc/sửa được code.
- Visual workflow dễ tiếp cận — nhưng tạo ra representation thứ hai của logic, và giới hạn user trong programming model của các node.

CodeFlow giải mâu thuẫn này bằng cách giữ code làm representation chuẩn duy nhất và sinh workflow graph từ code, thay vì bắt một bên chiều theo bên kia.

> **Code dành cho AI và developer. Workflow dành cho con người.**

## 4. Mục tiêu

| # | Mục tiêu | Nội dung |
|---|---|---|
| G1 | Code → Workflow | Chuyển các semantics được hỗ trợ của flow code thành semantic workflow graph |
| G2 | Workflow → Code | Edit trên UI → source patch tối thiểu |
| G3 | Bảo toàn source | Không regenerate file; chỉ sửa đúng vùng cần sửa |
| G4 | Progressive disclosure | Beginner: visual nodes · Power user: node + config/expression · Developer: full source |
| G5 | Extensibility | Tool / MCP tool / library function (user viết, lưu độc lập, có input/output, tái sử dụng) / custom code — tất cả thành node qua registry, không sửa core |
| G6 | Graceful degradation | Code không hiểu được → custom code node, giữ nguyên, đánh dấu rõ |

## 5. Non-goals

Phiên bản đầu **không**:

- thực thi workflow (execution thuộc về sandbox runtime — Temporal, Inngest, isolate, v.v.);
- hỗ trợ **arbitrary application code** — input là flow code theo contract ([01-flow-contract.md](01-flow-contract.md)); đây là chốt chống scope creep quan trọng nhất;
- hỗ trợ mọi construct TypeScript dưới dạng visual node;
- tạo visual programming language mới;
- biến workflow JSON thành source of truth;
- execute custom code bên trong core library.

## 6. Nguyên tắc thiết kế

1. **Source là canonical** — mọi pipeline đều bắt đầu và kết thúc ở source code.
2. **Semantic projection, không phải AST visualization** — node biểu diễn *ý nghĩa* (một bước trong flow), không phải từng AST node. MVP giữ projection gần 1:1 với các construct được hỗ trợ; việc gộp thông minh (nhiều statement → một node "Transform") để sau MVP vì nó làm mờ source mapping.
3. **Minimal mutation** — một edit trên workflow chỉ được đụng vùng source tương ứng.
4. **Stable identity** — node identity tồn tại qua formatting, thêm dòng, thay đổi không liên quan. (Phạm vi cam kết: xem [03-data-model.md](03-data-model.md).)
5. **Thể hiện rõ uncertainty** — không chắc thì đánh dấu unknown/custom, không suy diễn.
6. **Runtime independence** — core không phụ thuộc workflow execution engine nào.
6b. **Tool agnosticism** — core không định nghĩa, không ship sẵn, không hardcode bất kỳ tool/MCP/integration cụ thể nào. Core chỉ có cái khung (`ToolDefinition`, registry, codegen); mọi tool cụ thể do host app đăng ký lúc runtime hoặc đến từ adapter optional (`@codeflow/mcp`). Registry rỗng → mọi call là unknown/code node, hệ thống vẫn đúng. Mọi tên tool trong docs (`github.*`, `slack.*`) chỉ là ví dụ.
7. **Không có expression language thứ hai** — mọi "expression syntax thân thiện" trên UI phải là display syntax 1-1 của TypeScript expression thật ([06-patch-engine.md](06-patch-engine.md)).

## 7. Core moat

Bốn phần cần tập trung engineering effort — mọi thứ khác là infrastructure lắp ráp:

1. **Semantic Analyzer** — code → workflow có ý nghĩa.
2. **Stable Node Identity** — node tồn tại ổn định qua source changes.
3. **Source Mapping** — node map chính xác về code.
4. **Minimal Patch Engine** — visual edit chỉ sửa đúng source cần sửa.

React Flow, ELK.js, Monaco, ts-morph, MCP SDK là infrastructure xung quanh core, không phải differentiator.
