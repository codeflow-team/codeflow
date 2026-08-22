# 06 — Patch Engine (Workflow → Code)

## 1. Editable fields

Mỗi node/tool definition khai báo phần source cho phép edit an toàn:

```ts
interface EditableField {
  name: string;               // "channel" — property trong argument object
  label?: string;
  editor?: "text" | "expression" | "select" | "code";
  options?: unknown[];
}

// Shorthand: chuỗi "channel" ≡ { name: "channel" } — normalize khi load definition
type EditableFieldInput = EditableField | string;
```

Ví dụ:

```ts
await tools.slack.send({
  channel: "#security",
  message: `Security PR: ${pr.title}`
});
```

với `editableFields: ["channel", "message"]` → inspector render:

```text
Channel   [#security            ]
Message   [Security PR: {{ pr.title }}]
```

Đổi `channel` chỉ được patch đúng property đó.

**Điều kiện editable — argument phải là object literal "nhìn thấy được":**

- argument là biến (`send(payload)`) → node hiển thị nhưng fields **không editable** + diagnostic info ("argument là biến — edit qua code view"); không đoán;
- object literal có spread (`{ ...defaults, channel: "#a" }`) → chỉ field đứng **sau** spread và thấy được là editable; field nằm trong spread → không editable; **không bao giờ** chèn property mới sau spread để override giá trị user không nhìn thấy (âm thầm đổi hành vi = vi phạm I6);
- shorthand property (`{ channel }`) → edit giá trị sẽ viết lại thành longhand (`channel: "#eng"`) — đây là hành vi **được định nghĩa là đúng** (diff kỳ vọng trong fixture), hệ quả data edge từ biến `channel` biến mất là chính xác về semantics;
- field có schema dạng TS ref (không phải JSON Schema) → inspector không dựng được form có validate, dùng **expression editor** ([03-data-model.md](03-data-model.md) §11).

## 2. Phạm vi edit được hỗ trợ (MVP)

- primitive arguments (string/number/boolean literal);
- object properties trong argument object (thêm/sửa/xóa property thuộc `inputSchema`);
- expressions (xem §3);
- condition expression của `if` và của `while`;
- iterable expression của `for...of`;
- xóa `jump` node (`break`/`continue`) và `output` node của early return (xóa statement — cũng qua dependency check như mọi delete);
- **đổi tool** của một tool node sang tool khác tương thích — định nghĩa tương thích: các input field user đã cấu hình map được sang tool mới (trùng tên + type), và output type của tool mới gán được cho biến hiện tại xét theo các chỗ dùng downstream (kiểm bằng type check sau patch). Không tương thích → UI vẫn cho đổi nhưng ở dạng "replace & reconfigure" (node về trạng thái needs-configuration). Identity của node giữ nguyên qua patch provenance ([03-data-model.md](03-data-model.md) §5.2 bước 0) dù semantic path/fingerprint đổi;
- **thêm node mới** từ palette — tool hoặc library function. Luồng đầy đủ:
  1. user chọn **điểm chèn** trên canvas (affordance "+" trên control edge giữa hai node, hoặc cuối một nhánh);
  2. patcher chèn statement `const <var> = await tools.x.y({...});` — tên biến sinh tự động từ tên tool (camelCase, thêm hậu tố số nếu trùng: `files`, `files2`); với library function, tự thêm `import` từ `modulePath` nếu chưa có;
  3. required input fields chưa có giá trị → điền placeholder từ schema default nếu có, không thì node vào trạng thái **needs-configuration** (diagnostic warning + badge trên node, inspector tự mở) — code vẫn parse được, user điền nốt qua inspector;
- tạo/promote library function ("Save to library" — ghi vào `FunctionLibraryStore`, thay local function bằng import);
- **xóa node** — có dependency check: nếu output binding của statement đang được node phía sau dùng (data edge — core đã track), từ chối xóa và chỉ rõ node nào đang phụ thuộc ("Slack Send đang dùng `files` — xóa/sửa node đó trước"). Không bao giờ âm thầm sinh code không compile;
- edit thân custom function qua Monaco (thay nguyên thân function — vùng opaque nên "patch tối thiểu" = thay cả vùng);
- edit **inline code node** qua Monaco (thay vùng statement opaque, cùng cơ chế trên).

**Chưa hỗ trợ ở MVP** (UI phải nói rõ "không hỗ trợ", không âm thầm làm sai): kéo node từ trong `if`/`for`/`try` ra ngoài hoặc ngược lại, bọc/bỏ wrapper `try` quanh node đang có, đổi thứ tự node có data dependency, mọi structural edit khác. Đây là ranh giới quan trọng — structural editing là phần khó nhất của bài toán và không cần cho vòng value đầu tiên.

## 3. Expressions — display syntax, không phải ngôn ngữ

Quy tắc hiển thị giá trị của một editable field: giá trị là **literal** → hiển thị nguyên văn; giá trị là **TypeScript expression** → bọc trong `{{ }}`:

```text
"#security"                    →  #security                        (string literal)
`Security PR: ${pr.title}`     →  Security PR: {{ pr.title }}      (template literal:
                                                                    từng interpolation bọc riêng)
pr                             →  {{ pr }}                          (identifier expression)
files.length                   →  {{ files.length }}               (expression bất kỳ)
```

**Ràng buộc cứng:** `{{ }}` chỉ là cách *hiển thị* TypeScript expression — mapping hai chiều 1-1, không thêm semantics. Không bao giờ phát triển thành expression language riêng (không filter/pipe kiểu `{{ x | upper }}`) — vì đó chính là "representation thứ hai" mà nguyên tắc cốt lõi cấm. Power user cần hơn thế → advanced mode viết TypeScript expression trực tiếp.

**Display không phải là encoding — chiều ngược đi qua AST, không parse display text.** Mỗi field giữ tham chiếu tới AST form gốc (string literal / template literal / expression). Edit được áp **tương đối với form gốc**:

- string literal sửa text → vẫn là string literal (kể cả khi text chứa `${` — không bao giờ tự "nâng cấp" thành template literal, vì đó là đổi semantics);
- template literal sửa phần text quanh interpolation → vẫn template literal; gõ thêm `{{ expr }}` trong friendly editor → thêm một interpolation;
- string literal thường + user gõ `{{ expr }}` → UI hỏi/chuyển tường minh sang expression mode (chuyển thành template literal là một edit có chủ đích, không ngầm định);
- field đang là bare expression (`{{ pr }}`) → edit trong expression editor, kết quả vẫn là expression; template một-interpolation (`` `${pr.title}` ``) và bare expression (`pr.title`) hiển thị giống nhau nhưng **không bao giờ lẫn khi patch** vì mỗi bên patch về đúng form gốc của mình;
- field kiểu boolean/number (biết từ JSON Schema) → typed editor, giá trị ghi thành literal đúng kiểu; xóa trắng field required → property bị xóa + node vào needs-configuration.

**Escaping/nhập nhằng:** trường hợp display không còn 1-1 (string literal chứa sẵn `{{`/`}}`; expression chứa `}` như `${ {a: 1} }` hay chứa `{{` trong string con) → UI **từ chối chế độ friendly cho field đó** và fallback sang hiển thị/edit dạng code (Monaco inline). Không phát minh escape syntax riêng — fallback là cơ chế degradation chuẩn, hiếm gặp trong flow code thực tế.

## 4. Patch pipeline

```text
patchNode(nodeId, changes)
  ↓
Resolve node → source mapping
  ↓
Verify vùng source chưa đổi từ lúc load graph
  ↓
Resolve AST node (ts-morph)
  ↓
Validate edit (schema của editable field)
  ↓
Tính patch trên CANDIDATE source (bản in-memory)
  ↓
Validate candidate (parse lại; type check khi có điều kiện —
  fail → HỦY, source thật không đổi một byte, trả diagnostics)
  ↓
Commit atomic: apply patch vào source thật
  ↓
Re-analyze → graph diff → UI update
```

**Ràng buộc byte-for-byte (I3)**: patch được tính bằng cách **thay text range của đúng node AST nhỏ nhất bị ảnh hưởng** — không bao giờ reprint node cha (reprint kéo theo quote style/indentation/trailing comma của printer, phá formatting xung quanh). Quote style, indentation, trailing comma của phần chèn mới đọc từ **chính source hiện tại** (file dùng nháy đơn → chèn nháy đơn), không lấy từ manipulation settings mặc định. Xóa property → xóa cả dòng của nó kèm comment cùng dòng; dấu phẩy còn thừa/thiếu của property kề chỉnh theo đúng style đang có. Mọi hành vi này có fixture diff kỳ vọng ([11-testing.md](11-testing.md) §3.2).

**Transactionality**: mọi edit — kể cả "đổi tool" cần type check downstream — đều validate trên candidate rồi mới commit; không tồn tại trạng thái "đã ghi source rồi mới phát hiện hỏng". Composite operation (promote local function → library: ghi store + xóa declaration + thêm import) chạy theo thứ tự an toàn: ghi store trước (fail → dừng, source nguyên vẹn), rồi patch flow một lần (hai vùng trong một commit); patch fail → entry trong store vẫn còn nhưng vô hại (chưa flow nào tham chiếu).

Ví dụ:

```ts
const result = await flow.patchNode("node_slack_01", {
  channel: "#security-team"
});
```

```diff
 await tools.slack.send({
-  channel: "#security",
+  channel: "#security-team",
   message: `Security PR: ${pr.title}`
 });
```

Kết quả trả về:

```ts
{
  source: string;          // source mới
  patches: TextPatch[];    // các vùng đã đổi
  graph: WorkflowGraph;    // graph sau re-analyze
  diagnostics: Diagnostic[];
}
```

## 5. Conflict detection

MVP giả định **single-user, single-editor tại một thời điểm** (một UI instance + có thể AI/dev sửa file bên ngoài). Trước khi patch:

0. so `registryHash` của graph với registry hiện tại — registry đã đổi (tool gỡ/đổi schema) → yêu cầu re-analyze trước khi cho edit;
1. so content hash của file với hash lúc load graph;
2. nếu file đã đổi → **re-analyze trước**, resolve lại node qua identity ([03-data-model.md](03-data-model.md) §5.2);
3. resolve được node + **raw text** của vùng đó không đổi (so text gốc, KHÔNG so fingerprint chuẩn hóa — fingerprint bỏ trivia nên sẽ bỏ sót thay đổi comment/formatting mà một edit-thay-cả-vùng có thể đè mất) → apply patch bình thường;
4. vùng đó đã đổi → từ chối patch, báo UI: "Node này đã thay đổi từ lúc load — reload workflow trước khi sửa."

Không bao giờ âm thầm overwrite thay đổi của user/AI. UI conflict resolution phức tạp hơn (review/merge) để sau MVP.
