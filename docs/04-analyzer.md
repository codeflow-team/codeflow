# 04 — Semantic Analyzer

Analyzer là lớp intelligence chính: nhận syntax tree + type information + registry, trả về `WorkflowGraph`. Toàn bộ quy tắc dưới đây áp dụng cho **thân function flow** theo [contract](01-flow-contract.md).

## 1. Nguyên tắc

1. **Projection gần 1:1**: mỗi construct được hỗ trợ → đúng một node. Không gộp nhiều statement thành node "thông minh" ở MVP (gộp làm mờ source mapping, khó patch, dễ vỡ round-trip). Smart merging để sau MVP.
2. **Resolve bằng binding, không bằng tên**: một call là tool call khi property-access chain của nó **bắt rễ ở binding của tham số `tools`** (tham số thứ hai của flow function — scope analysis, không phải string matching: alias `const t = tools` vẫn resolve, biến khác tên `tools` không bị nhận nhầm). Path còn lại (`github.getFiles`) tra vào registry: có entry → `tool` node; **không có entry → `unknown` node + diagnostic** (đây là quy tắc sinh `unknown`). Library function resolve tương tự qua binding của import từ `modulePath`. Cách này chỉ cần parse + scope analysis — **không cần full type check** — nên chạy nhanh cả ở browser; TS type checker là tầng **enrichment** (type cho ports, type-check khi validate) chạy khi có điều kiện (Node/CI), không phải điều kiện tiên quyết để dựng graph.
3. **Không chắc thì fallback**: construct ngoài danh sách hỗ trợ → custom code node + diagnostic, không đoán.
4. **Không nuốt side-effect call** (bảo vệ I1 — [11-testing.md](11-testing.md)): mọi **`await` expression** và mọi **tool call (bắt rễ ở `tools`)** nằm **bên trong expression** (condition của if/while, argument của call khác, phần tử tính toán, callback của `.map(...)`) — thay vì đứng thành statement riêng — làm **cả statement chứa nó** degrade thành `code` node + diagnostic `hidden-call-in-expression` ("tách ra `const` riêng để hiện thành node"). Mỗi hidden call = một diagnostic (không nhân đôi cho `await tools.x.y()`). Ví dụ: `if (await tools.github.hasLabel({pr}))`, `await Promise.all(prs.map(pr => tools.github.getFiles({pr})))` → code node, KHÔNG BAO GIỜ thành condition/parallel node "đẹp" mà giấu mất tool call bên trong.
   **Phạm vi có chủ đích — sync library/local function call KHÔNG kích hoạt rule này**: `if (isAdmin(user) && pr.draft)` vẫn là condition node với expression thô. Lý do: (a) mục đích của rule là side-effect visibility — sync predicate không mang side-effect quan sát được ở tầng flow (side-effect thật nằm ở await/tools, và thân function vốn đã opaque theo 01 §4); (b) áp nguyên văn sẽ mâu thuẫn §2.2b (condition phủ định/tổ hợp chứa registered function được giữ là condition node) và §2.6 (phần tử `Promise.all` được phép là một function call). Ngoại lệ reference: function *reference* làm callback (§2.2b) không phải call nên càng không kích hoạt. Style guide dạy AI hoist await/tool call ra `const` nên case này hiếm trong code chuẩn; quy tắc này là lưới an toàn để graph không bao giờ nói dối về side effect.

## 2. Quy tắc mapping

### 2.1 Tool call

```ts
const prs = await tools.github.getNewPRs({ repo: input.repository });
```

→ `tool` node `github.getNewPRs`, label/icon/schema lấy từ registry; output port `prs` (schema từ `outputSchema` hoặc TS return type); argument object → editable fields theo definition.

### 2.2 Function call (library / local)

Function call **dạng statement riêng** → `function` node:

```ts
const flagged = filterAuthChanges(files);   // library function → function node
```

### 2.2b Function reference trong expression — KHÔNG phải node riêng

```ts
if (files.some(isAuthChange)) { ... }
```

`isAuthChange` ở đây là callback truyền vào `Array.some` — nó **không sinh node riêng**. Cả `files.some(isAuthChange)` là condition expression của `condition` node (§2.4). Sugar label: chỉ áp dụng khi **toàn bộ** condition expression đúng dạng `fn(args)`, `xs.some(fn)` hoặc `xs.every(fn)` với `fn` resolve bằng **symbol** về một registered function — khi đó label node dùng label từ registry ("Is Auth Change?"). Có phủ định (`!files.some(...)`), tổ hợp (`&&`/`||`), hay bất kỳ dạng nào khác → hiển thị expression thô, KHÔNG dùng label (label sai nghĩa là failure mode I6 — thà thô còn hơn sai). Thuần display, không đổi cấu trúc graph, source mapping vẫn là cả `if`.

### 2.3 Sequential + data flow

```ts
const a = await foo();
const b = await bar(a);
```

→ hai node nối control edge `foo → bar`, kèm data edge `a`. Data dependency track qua binding/symbol ([03-data-model.md](03-data-model.md) §6 — shadowing resolve đúng, `let` nhiều writer có edge từ mỗi writer).

### 2.4 Condition

```ts
if (cond) { A } else { B }
```

→ `condition` node, hai control edge label `true`/`false` (if không có else → nhánh `false` đi thẳng tới điểm hội tụ), hội tụ ở `merge` node. Quy tắc merge là **của analyzer, thuần cấu trúc** (không liên quan layout): merge node được sinh **khi và chỉ khi** sau chỗ rẽ nhánh còn statement tiếp theo trong cùng block; nhánh là điểm kết thúc block (cuối thân loop, cuối thân flow) → KHÔNG sinh merge node — hai nhánh cùng trỏ tới ranh giới block (loop node/output). `cond` là editable expression trên inspector.

Chuỗi `else if`: là `IfStatement` lồng trong nhánh else → chiếu 1:1 thành condition node lồng nhau (semantic path `flow/if[0]/else/if[0]`), tất cả chung một merge ở điểm hội tụ ngoài cùng. Không có node "multi-branch" ở MVP.

### 2.5 Loop

```ts
for (const item of items) { ...body... }
```

→ `loop` node ("For Each `item` in `items`"); body là **subgraph lồng trong node** (nested layout), không phải edge vòng ngược — dễ đọc với non-dev hơn.

`for await...of` được xử lý như `for...of` (data.kind ghi nhận để patcher giữ nguyên `await`). `for (;;)` cổ điển và `do...while` KHÔNG được hỗ trợ → code node; nếu thân chứa tool call thì quy tắc hidden-call (§1.4) đảm bảo có diagnostic chứ không im lặng.

### 2.6 Parallel

```ts
const [a, b, c] = await Promise.all([
  tools.x.foo({}),
  tools.y.bar({}),
  isReady(input)
]);
```

→ `parallel` node fan-out, hội tụ ở `merge`. Quy tắc:

- chỉ nhận **array literal**; mỗi phần tử là **một call duy nhất** (tool/library/local function — không có `await` trong phần tử, await là của `Promise.all`) → phần tử đó thành node trong nhánh tương ứng;
- phần tử phức tạp hơn một call (expression tổ hợp, `.map(...)`, ternary...) → cả statement degrade theo quy tắc hidden-call (§1.4). `Promise.all(prs.map(...))` — dạng dynamic phổ biến — nằm ngoài MVP: code node + diagnostic, style guide hướng AI dùng `for...of` thay thế;
- destructuring `[a, b, c]` → output ports đặt trên `merge` node, mỗi port ghi metadata nhánh gốc (port `a` ← nhánh 1) để data edge downstream truy về đúng nguồn.

### 2.7 Try / Catch

```ts
try {
  await tools.payment.charge({ amount });
} catch (err) {
  await tools.slack.send({ channel: "#alerts", message: `Charge failed` });
}
```

→ `try` node: body là subgraph chính, catch là subgraph thứ hai, nối bằng control edge label **`error`** (biến lỗi `err` làm data edge vào catch body; `catch {}` không có binding — hợp lệ, chỉ không có data edge). `finally` (nếu có) là subgraph thứ ba, control edge từ cả hai nhánh — **và từ mọi `jump`/`output` node bên trong body/catch** (break/return vẫn chạy finally trước khi thoát; thiếu edge này là graph nói dối về side effect trong finally). Sau try node, flow hội tụ như merge của condition. Thêm/bỏ wrapper try quanh node đang có là structural edit — chưa hỗ trợ ở MVP ([06-patch-engine.md](06-patch-engine.md) §2).

### 2.8 While

```ts
let attempts = 0;
while (attempts < 3) {
  ...
  attempts++;
}
```

→ `loop` node với `data.kind: "while"`, condition là editable expression. **Bound check** (best-effort, không phải chứng minh termination): analyzer nhận diện các idiom bounded phổ biến — condition so sánh số học với biến được cập nhật trong body, hoặc điều kiện trên biến được gán trong body. Không nhận diện được → diagnostic `warning: "unbounded-loop-risk"` trên node (flow vẫn hợp lệ; việc chặn hay không là chuyện của runtime, không phải CodeFlow).

### 2.9 Return / Break / Continue

- `return` (cuối flow hoặc early return trong if/loop) → `output` node ("End Flow"), mỗi return statement một node, 1:1 với source; return value hiển thị như expression.
- `break` / `continue` trong loop body → `jump` node (terminal chip trong loop subgraph, `data.kind` tương ứng): `break` cắt sang điểm sau loop, `continue` sang iteration kế — hiển thị bằng label trên node, không vẽ edge vòng ngược (giữ graph phẳng, dễ đọc). Labeled jump (`continue outer;`) → `data.label` lưu tên label, node hiển thị "continue → outer" chỉ rõ loop đích — không hiển thị giống continue thường.
- Guard pattern phổ biến (`if (!x) continue;`) nhờ đó hiển thị tự nhiên: condition node → nhánh `true` → jump node.

### 2.10 Trigger và Output

- `trigger` node dựng từ type tham số `input` + `TriggerMetadata` nếu được cung cấp ([03-data-model.md](03-data-model.md) §9).
- Flow không có `return` tường minh → synthetic `output` node ở cuối thân function.

### 2.11 Fallback

Mọi statement/expression ngoài các quy tắc trên:

```ts
const result = extremelyComplexAlgorithm(data);
```

→ `code` node giữ nguyên source, hiển thị:

```text
┌─────────────────────┐
│ </> Custom Code     │
│ extremelyComplex…   │
│ [View Code]         │
└─────────────────────┘
```

Các statement liên tiếp cùng không được hỗ trợ được gộp thành **một** code node (đây là kiểu gộp duy nhất ở MVP — gộp vùng opaque không ảnh hưởng mapping vì cả vùng là một source range). Semantic path của code node: `stmt[i..j]` theo vị trí trong block. **Identity của code node gộp**: node lưu fingerprint **từng statement** bên trong; khi re-analyze, code node mới match code node cũ nếu chia sẻ ≥1 statement fingerprint → `node.updated` (mở rộng/thu hẹp vùng), không phải removed+added — nhờ đó thêm một statement unsupported cạnh code node đang có không làm mất identity (invariant I5).

## 3. Function calls ngoài `tools`

Ba trường hợp, resolve đều qua symbol:

- **Library function** (import từ function library, [05-registry.md](05-registry.md) §4) → function node với schema/label/icon từ `FunctionDefinition`; analyzer không nhìn vào thân function;
- **Local function** (khai báo trong file flow) → function node dựng từ TS signature (tên, params, return type); thân function không được project thành graph ở MVP;
- **Import lạ / call không resolve được** → opaque code node + diagnostic.

## 4. Re-analysis

MVP: mỗi source change → full re-parse + re-analyze + **graph diff** so với graph trước (dựa trên identity resolution, [03-data-model.md](03-data-model.md) §5.2) → phát `GraphChange[]` cho UI. Incremental analysis thật (chỉ vùng ảnh hưởng) để sau, đằng sau cùng interface.
