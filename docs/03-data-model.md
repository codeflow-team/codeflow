# 03 — Data Model

## 1. WorkflowGraph

```ts
interface WorkflowGraph {
  id: string;
  version: number;            // tăng mỗi lần re-analyze
  source: SourceDocument;     // file path + content + content hash
  registryHash: string;       // fingerprint của registry lúc analyze — graph là hàm
                              // của (source, registry), nên staleness phải soi CẢ HAI
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  diagnostics: Diagnostic[];
}
```

## 2. WorkflowNode

```ts
interface WorkflowNode {
  id: string;                 // stable identity — xem §5
  type: NodeType;
  label: string;

  source: SourceMapping;      // node nào cũng map về source — xem §4

  inputs: NodePort[];
  outputs: NodePort[];

  // dữ liệu riêng theo node type: tool name, editable field values,
  // condition expression, loop variable, code snippet...
  data: Record<string, unknown>;

  capabilities: NodeCapabilities;  // editable? deletable? expandable?
}

interface NodePort {
  id: string;
  label: string;
  schema?: Schema;            // từ registry hoặc TS type
}
```

## 3. NodeType

```ts
type CoreNodeType =
  | "trigger"      // synthetic — từ signature flow function + TriggerMetadata (§9)
  | "tool"         // await tools.<ns>.<fn>(...)
  | "function"     // library function HOẶC local function — gọi dạng statement
  | "condition"    // if / else
  | "loop"         // for...of HOẶC while — body là subgraph; data.kind: "forOf" | "while"
  | "try"          // try/catch(/finally) — body/catch/finally là subgraph;
                   //   control edge "error" từ body sang catch
  | "jump"         // break | continue — terminal node trong loop subgraph;
                   //   data.kind: "break" | "continue"; data.label?: string (labeled jump)
  | "parallel"     // Promise.all
  | "merge"        // synthetic — điểm hội tụ sau parallel/condition
  | "code"         // fallback: construct KHÔNG được hỗ trợ — giữ nguyên source
  | "output"       // return của flow — cả return cuối lẫn early return
                   //   (mỗi return statement → một output node riêng, 1:1 với source)
  | "unknown";     // construct NHẬN DIỆN ĐƯỢC nhưng resolve THẤT BẠI
                   // (vd call dạng tools.x.y nhưng tool không có trong registry)

// Mở cho plugin: node type mới đăng ký qua registry, không sửa core
type NodeType = CoreNodeType | (string & {});
```

Phân biệt `code` vs `unknown`: `code` = "CodeFlow không cố hiểu, đây là vùng opaque hợp lệ" (info); `unknown` = "trông như thứ được hỗ trợ nhưng resolve thất bại — có thể là lỗi" (kèm diagnostic error/warning).

## 4. Source Mapping

Mọi node phải map về một vùng source:

```ts
interface SourceMapping {
  file: string;
  start: SourcePosition;      // line, column, offset
  end: SourcePosition;
  semanticPath: string;       // xem §5
  fingerprint: string;        // hash chuẩn hóa của AST subtree (bỏ trivia/formatting)
}
```

Source mapping không bao giờ chỉ dựa vào line number — line là thứ vỡ đầu tiên khi code đổi.

**Node tổng hợp (synthetic)**: `merge`, `trigger` — và `output` khi flow không có `return` tường minh — không có construct riêng trong source. Quy tắc: chúng map về source range của construct **sinh ra chúng** (merge của `if/else` → cả if statement; merge của `Promise.all` → statement đó; trigger → signature của flow function; output ẩn → cuối thân function), với semantic path mang role qualifier: `flow/if[0]#merge`, `flow#trigger`. Nhiều node được phép chia sẻ một source range, nhưng mỗi range chỉ có **một owner node** cho việc edit (capabilities của synthetic node: không editable trực tiếp). `output` từ `return` statement thật và `jump` (`break`/`continue`) map thẳng về statement của chúng — không phải synthetic.

## 5. Stable Node Identity

### 5.0 Sinh id, và hai chế độ identity

`node.id` là **opaque handle**, sinh lúc node xuất hiện lần đầu, **không encode nội dung** (không dẫn xuất từ tool name — nhờ đó đổi tool không đổi id):

- **Cold analyze** (không có graph trước): id = hash deterministic của semantic path tại thời điểm sinh → cùng (source, registry) luôn cho cùng graph, cùng ids (invariant I2). Fixture `expected-graph.json` so sánh trên đường này.
- **Session re-analyze** (một `CodeFlowSession` đang giữ graph trước — xem [02-architecture.md](02-architecture.md) §5): id được **mang qua** bằng cơ chế resolve §5.2 — node cũ giữ id cũ, node mới nhận id mới. Id trong session vì vậy có thể khác với id nếu cold-analyze cùng source — đây là chủ đích: I2 cam kết determinism cho cold analyze; session cam kết **continuity**. View state, selection, `GraphChange` đều là khái niệm trong phạm vi session.

`edge.id` = hash deterministic của (source node id, target node id, kind, port) — không cần resolve riêng.

### 5.1 Semantic path

Đường dẫn cấu trúc từ gốc flow tới construct, **kèm sibling index** để phân biệt hai construct giống nhau cùng scope:

```text
flow/for[0]/if[0]/call:slack.send[0]
flow/for[0]/if[0]/call:slack.send[1]   // lần gọi thứ hai của cùng tool trong cùng block
```

### 5.2 Thứ tự resolve identity

Khi source đổi, resolve node cũ → node mới:

0. **Patch provenance** — patch do **patch engine** sinh ra ([06-patch-engine.md](06-patch-engine.md)) biết trước nó chèn/sửa/xóa gì, nên kèm sẵn mapping `oldNodeId → newRange` chính xác. Đường này **không dùng heuristic** — mọi edit qua inspector/palette giữ identity tuyệt đối, kể cả chèn một call trùng hệt trước call đang có. **Lưu ý**: edit source trực tiếp trong Monaco (dù là UI của CodeFlow) KHÔNG có provenance — nó đi đường heuristic 1–4 như mọi source change bên ngoài.
1. **Sibling-group alignment** — với thay đổi không có provenance: các node cùng cha được match theo **alignment bảo toàn thứ tự** (kiểu LCS/diff), trong đó "bằng nhau" so theo thứ tự ưu tiên: fingerprint trùng → call signature trùng. Nhờ so fingerprint trước, hoán vị hai call cùng tool nhưng khác argument vẫn match đúng từng cái (không gán chéo). Chèn một `slack.send` mới trước `slack.send` cũ → alignment nhận ra phần tử cũ trượt xuống, giữ nguyên id. Sibling index trong semantic path (§5.1) chỉ là **cách đặt tên ổn định sau khi đã resolve**, không phải chìa khóa match. **Giới hạn thừa nhận**: hai sibling giống nhau *đến từng byte* thì về nguyên lý không phân biệt được từ source diff — xóa một trong hai có thể báo removed "nhầm cái" (hệ quả chỉ ở tầng cosmetic: view state/selection); đường provenance (xóa qua UI) không dính giới hạn này.
2. **Fingerprint** khớp (node bị di chuyển trong cây, nội dung không đổi).
3. **Source range** gần đúng + node type khớp.
4. **Structural context** xung quanh (best-effort).

Không match được → node cũ coi như removed, node mới coi như added (graph diff phản ánh đúng như vậy). **Quy tắc an toàn**: thà báo removed+added còn hơn gán nhầm id cũ cho node khác — mis-binding là lỗi nghiêm trọng hơn mất identity (test bắt buộc: [11-testing.md](11-testing.md) I5).

### 5.3 Phạm vi cam kết

Identity **được cam kết** tồn tại qua:

- formatting, thêm/xóa dòng không liên quan;
- edit nội dung node khác;
- patch do patch engine sinh ra (kể cả đổi tool — id là opaque handle, §5.0).

(Thao tác thuần visual như pan/zoom/select không đụng source nên hiển nhiên không ảnh hưởng identity; MVP không persist vị trí manual — §8.)

Identity **chỉ best-effort** (mất là chấp nhận được) khi:

- AI regenerate toàn bộ file — fingerprint matching cứu được phần nào, phần còn lại là graph mới thay graph cũ;
- refactor lớn làm đổi cả cấu trúc lẫn nội dung node.

Draft v0.1 hứa identity tồn tại qua "source regeneration" — v0.2 rút cam kết này vì không giữ được và không cần giữ.

## 6. WorkflowEdge

```ts
interface WorkflowEdge {
  id: string;
  source: string;             // node id
  target: string;
  kind: "control" | "data";
  sourcePort?: string;
  targetPort?: string;
  label?: string;             // vd: "true" / "false" trên nhánh condition,
                              // tên biến trên data edge
}
```

- **Control edge**: thứ tự thực thi (sequential, nhánh condition, vòng loop).
- **Data edge**: track qua **identifier bindings, resolve theo symbol** (không phải theo tên — shadowing trong scope lồng resolve về đúng binding gần nhất). Bindings gồm: `const`/`let` declarations, tham số flow function (`input`), biến loop (`pr`), destructured names (`const { data, error } = await tools.x.y()` → tool node có output ports `data`, `error`). Dùng một binding (kể cả property access, như `input.repository`) → data edge từ node sản sinh: một binding dùng ở N node → N edge từ cùng port. `let` được **reassign** trong nhiều nhánh → edge từ **mỗi** node ghi giá trị (union các writer). Chỉ trong cùng file, không alias analysis.
- **Giới hạn thừa nhận (mutation)**: data edge biểu diễn quan hệ def-use, không phải mutation ordering — `files.push(x)` trong một code node không làm đổi hướng edge `files` đang có; code node tham chiếu binding vẫn nhận reader edge nên nó hiện diện trong chuỗi, và control edge giữ đúng thứ tự thực thi, nhưng graph không tuyên bố "giá trị đã bị B sửa trước khi tới C". Đây là trade-off có chủ đích của MVP.

## 7. Diagnostics

```ts
interface Diagnostic {
  severity: "info" | "warning" | "error";
  code: string;               // vd: "unsupported-construct", "unresolved-tool"
  message: string;
  source?: SourceMapping;
}
```

Ví dụ:

- `info` — "Custom code được giữ nguyên, không có semantic projection."
- `warning` — "`hidden-call-in-expression`: tool call nằm trong expression — tách ra `const` riêng để hiện thành node." ([04-analyzer.md](04-analyzer.md) §1.4)
- `warning` — "`unbounded-loop-risk`: không nhận diện được điều kiện dừng của `while`."
- `error` — "Không resolve được tool `github.getFiles` — không có trong registry." (node → `unknown`)
- `error` — "`stale-generated-artifacts`: generated/tools.d.ts không khớp registry hiện tại — chạy `codeflow generate`."

## 8. View state — vị trí node KHÔNG phải semantic state

Vị trí node trên canvas do ELK auto-layout tính ra ([07-ui.md](07-ui.md)) — **derive được từ graph, không lưu trong graph**. User kéo node = thao tác thuần visual, không đụng source, identity hiển nhiên giữ nguyên.

Nếu host app muốn nhớ vị trí user tự đặt: đó là **view state của UI layer**, lưu ngoài `WorkflowGraph` (vd `Record<nodeId, {x, y}>` keyed theo stable node id), mất là chấp nhận được (cosmetic). Quy tắc này giữ nguyên tắc "không có representation thứ hai cần sync": graph semantic không bao giờ chứa thông tin không derive được từ code. MVP: auto-layout luôn, không persist vị trí manual.

## 9. AnalyzeOptions và TriggerMetadata

```ts
interface AnalyzeOptions {
  trigger?: TriggerMetadata;    // do host/runtime cung cấp — không nằm trong code
}

interface TriggerMetadata {
  kind: "webhook" | "cron" | "manual" | (string & {});
  label?: string;
  config?: Record<string, unknown>;   // vd cron expression
}

flow.analyze(source, options?: AnalyzeOptions): Promise<WorkflowGraph>;
```

Trigger node dựng từ type của tham số `input` (luôn có) + `TriggerMetadata` (nếu host cung cấp — làm label/icon cụ thể hơn: "⏰ Every day 9am" thay vì "⚡ Trigger").

## 10. GraphChange (graph diff)

Sau mỗi lần re-analyze, core phát ra diff thay vì graph mới toàn phần — cho UI update incremental và cho debugging:

```ts
interface GraphChange {
  type: "node.added" | "node.removed" | "node.updated"
      | "edge.added" | "edge.removed";
  nodeId?: string;
  edgeId?: string;
  changes?: Record<string, unknown>;
}
```

## 11. Phụ lục — các type phụ trợ

Định nghĩa tối thiểu của các type được tham chiếu trong specs:

```ts
// Schema — dùng cho port/input/output. Ba dạng, cùng một union:
// - JSON Schema object (nguồn MCP; inspector render form + validate được)
// - TS type reference string ("File[]", "boolean") — nguồn codegen/TS;
//   inspector KHÔNG dựng form từ dạng này → field dùng expression editor
// - Named-fields map ({ files: "File[]" }) — shorthand cho object input,
//   key là tên tham số/property; đây là dạng dùng trong các ví dụ của docs
// Quy tắc chuyển đổi: MCP JSON Schema → TS types khi codegen tools.d.ts
// (json-schema-to-typescript); TS ref dùng nguyên văn trong d.ts;
// named-map → object type / danh sách tham số khi codegen.
type Schema = JsonSchema | TsTypeRef | Record<string, JsonSchema | TsTypeRef>;
type TsTypeRef = string;
type JsonSchema = Record<string, unknown>;  // JSON Schema draft chuẩn — không định nghĩa lại

interface SourceDocument {
  file: string;
  content: string;
  contentHash: string;
}

interface SourcePosition {
  line: number;      // 1-based
  column: number;    // 1-based
  offset: number;    // 0-based, đơn vị chuẩn cho mọi tính toán patch
}
// TextChange dùng offset; TextPatch dùng SourcePosition (có offset bên trong)
// → quy đổi qua offset, line/column chỉ để hiển thị. NodePatcher trả về
// nhiều TextPatch thì các range KHÔNG được overlap — patcher validate trước khi apply.

interface NodeCapabilities {
  editable: boolean;        // có editable fields không
  deletable: boolean;
  expandable: boolean;      // có subgraph (loop) / code view không
}

// Thay đổi text — input của Parser.update
interface TextChange {
  start: number;            // offset
  end: number;
  newText: string;
}

// Output của patch engine — một vùng source bị thay
interface TextPatch {
  range: { start: SourcePosition; end: SourcePosition };
  oldText: string;
  newText: string;
}

// Storage của function library — host app implement.
// MVP: default impl file-based trên thư mục lib/ của workspace (10-ai-codegen.md §2)
interface FunctionLibraryStore {
  list(): Promise<FunctionDefinition[]>;
  get(name: string): Promise<FunctionDefinition | null>;
  save(def: FunctionDefinition, opts?: { overwrite?: boolean }): Promise<void>;
  // name đã tồn tại + không có overwrite:true → reject (UI hiện conflict prompt)
  remove(name: string, opts?: { force?: boolean }): Promise<void>;
  // remove/rename một function đang được dùng: UI/CLI phải chạy usage check
  // (codeflow check hoặc scan flows đang mở) và cảnh báo trước — cùng chuẩn
  // an toàn với delete-node của patch engine; force chỉ sau khi user xác nhận.
  rename(oldName: string, newName: string): Promise<void>;
  // rename KHÔNG tự sửa các flow đang import tên cũ — việc đó là một patch
  // trên từng flow (codeflow check liệt kê; host/user quyết định chạy)
}

// Extension points của registry (05-registry.md) — chữ ký tối giản.
// AstNode: node của syntax tree (MVP: ts-morph Node — opaque với plugin ổn định qua interface).
// AnalyzeContext: { source, registry, resolveBinding(...), addDiagnostic(...) }
// PatchContext:   { source, resolveRange(nodeId), addDiagnostic(...) }
// Hai context này là bề mặt plugin API — chi tiết chốt khi implement, nguyên tắc:
// plugin không bao giờ nhận quyền ghi source trực tiếp, chỉ trả về TextPatch[].
type SemanticAnalyzer = (ctx: AnalyzeContext, node: AstNode) => WorkflowNode | null;
type NodePatcher = (ctx: PatchContext, node: WorkflowNode,
                    changes: Record<string, unknown>) => TextPatch[];
type NodeRenderer = unknown;  // React component type — định nghĩa ở @codeflow/react,
                              // core chỉ giữ opaque reference

// Capabilities mặc định theo node type:
// tool/function/condition/loop-config: editable
// synthetic (merge, trigger*, output ẩn): editable=false, deletable=false
// unknown: editable=false, deletable=true (qua dependency check),
//          expandable=false; output binding của nó VẪN được track data edge;
//          được phép "replace & reconfigure" sang tool khác (06 §2)
// code: editable qua Monaco, deletable (qua dependency check)
```
