# 11 — Testing & Correctness Goals

## 1. Goal: "output cuối cùng đúng" nghĩa là gì

Trust model của CodeFlow: **non-dev user không đọc code — họ chỉ nhìn graph và tin graph**. Toàn bộ sản phẩm đứng vững khi và chỉ khi ba output sau đúng:

| Output | Định nghĩa "đúng" |
|---|---|
| **O1 — Graph** | Graph phản ánh trung thực code: không có bước nào của flow vắng mặt trên graph, không có node nào nói một đằng code làm một nẻo |
| **O2 — Code sau edit** | Đúng ý user đã thao tác trên UI, và **chỉ** thay đổi đúng vùng đó — mọi ký tự khác giữ nguyên |
| **O3 — Code AI sinh** | Hợp lệ theo contract (L0), resolve đủ (L1), map đẹp (L2) — [10-ai-codegen.md](10-ai-codegen.md) §5 |

Sai lệch nguy hiểm nhất là **graph nói A, code làm B** — user approve một flow mà họ hiểu sai. Vì vậy nguyên tắc xuyên suốt: thà hiển thị code/unknown node (user biết là mình không biết) còn hơn map sai (invariant I6). Mọi tầng test dưới đây tồn tại để bảo vệ O1–O3.

## 2. Correctness invariants

Đây là các bất biến phải giữ trong mọi trường hợp — mỗi invariant có test tương ứng, vi phạm là bug nghiêm trọng:

- **I1 — Faithful projection**: mỗi statement trong thân flow thuộc về đúng một node (phủ kín, không bỏ sót); node tổng hợp (merge…) chia sẻ source range theo quy tắc [03-data-model.md](03-data-model.md) §4. Mọi side-effect call trong thân flow hoặc **hiện thành node riêng**, hoặc nằm trong một **`code` node opaque kèm diagnostic** ([04-analyzer.md](04-analyzer.md) §1.4) — không bao giờ bị nuốt vào expression text của một node semantic "đẹp" (condition/parallel) mà không có dấu vết.
- **I2 — Determinism (cold analyze)**: cùng (source, registry) → cùng graph, kể cả node IDs, khi analyze không có graph trước ([03-data-model.md](03-data-model.md) §5.0). Trong một session, id được mang qua bằng resolution (continuity) — id session được phép khác id cold-analyze; fixture so sánh trên đường cold.
- **I3 — Patch minimality**: patch chỉ đụng vùng source của node + đúng phần tử được edit; mọi ký tự ngoài vùng đó giữ nguyên **byte-for-byte** (kể cả whitespace, comment).
- **I4 — Round-trip stability**: edit rỗng → source không đổi một byte; `analyze(patch(analyze(s), e))` → graph chỉ khác đúng phần bị edit; chạy lại vòng → ổn định (idempotent).
- **I5 — Identity stability, không mis-bind**: node id không đổi qua format lại / thêm code không liên quan / patch do chính CodeFlow sinh; đặc biệt **không bao giờ gán nhầm id cũ cho node khác** trong kịch bản chèn sibling giống hệt nhau ([03-data-model.md](03-data-model.md) §5.2).
- **I6 — Graceful degradation**: không chắc → `code`/`unknown` node + diagnostic. **Không bao giờ** map một construct thành node có nghĩa sai.
- **I7 — No execution**: core không bao giờ execute code input — enforce bằng lint rule (cấm `eval`, `new Function`, dynamic import của user source trong core) + test.

## 3. Test layers

```text
6. AI conformance evals            (định kỳ, không chặn CI)
5. UI e2e — Claude in Chrome       (PR chạm UI)
4. Round-trip suite            ┐
3. Property-based tests        │ bắt buộc xanh
2. Golden fixture corpus       │ mọi PR
1. Unit tests                  ┘
```

### 3.1 Unit tests (Vitest)

Per-module: parser, analyzer, mapper, patcher, registry codegen. Nhanh, hẹp, chạy mọi save.

### 3.2 Golden fixture corpus — xương sống

Mỗi case là một thư mục tự chứa:

```text
fixtures/<case-name>/
├── input.flow.ts          # flow code đầu vào
├── registry.json          # tools + library functions — DẠNG DECLARATIVE (JSON):
│                          #   không chứa được analyzer/patcher/renderer hooks;
│                          #   plugin hooks test ở layer unit (code), không trong corpus
├── expected-graph.json    # graph kỳ vọng (snapshot CÓ REVIEW, không snapshot mù)
└── edits/                 # các edit áp lên case này
    ├── change-channel.edit.json
    └── change-channel.expected.diff   # diff kỳ vọng, đúng từng ký tự
```

Danh mục corpus phải phủ:

- từng construct được hỗ trợ, đứng riêng;
- tổ hợp lồng nhau (if trong for, parallel trong if…);
- edge cases hiểm: hai call giống hệt cùng scope, comment/formatting dị, unicode trong string, template literal phức tạp, argument shorthand;
- các case degradation: construct không hỗ trợ, tool không resolve, import lạ.

### 3.3 Property-based tests (fast-check)

Sinh ngẫu nhiên các biến đổi **không liên quan** (format lại, chèn statement độc lập, đổi comment) lên fixtures → assert I2/I5 (graph tương đương, identity giữ nguyên). Sinh ngẫu nhiên edit hợp lệ → assert I3/I4. Property tests bắt các tổ hợp mà fixture viết tay không nghĩ tới.

### 3.4 Round-trip suite — gate quan trọng nhất

Với **mọi fixture × mọi editable field**: edit → patch → re-analyze → assert:

1. diff đúng bằng expected, không một ký tự thừa;
2. graph mới chỉ khác đúng node bị edit; mọi node khác giữ nguyên id;
3. chạy lại vòng trên source mới → ổn định.

Đây chính là acceptance criteria của MVP ([08-mvp.md](08-mvp.md) §4) ở dạng tự động hóa.

### 3.5 UI e2e (Claude in Chrome — agent-driven)

UI được test bằng **Claude in Chrome** điều khiển browser thật thay vì Playwright script: mỗi test case là một kịch bản mô tả (checklist các bước + expected), agent thực thi trên demo app, screenshot + đối chiếu kết quả, báo pass/fail kèm bằng chứng.

Kịch bản phủ: inspector edit → code đổi đúng; code edit trong Monaco → graph đổi đúng; select node ↔ highlight source; unsupported operation → thông báo rõ; conflict flow; palette insert (cả luồng "needs configuration").

Trade-off chấp nhận: agent-driven chậm và tốn hơn script, đổi lại kịch bản viết bằng ngôn ngữ tự nhiên (dễ thêm/sửa), bắt được lỗi UX mà selector-based script bỏ qua (element che khuất, layout vỡ, text khó hiểu). Vì vậy layer này chạy theo checklist trên PR chạm UI chứ không chạy mọi commit; logic đúng/sai của core đã được layers 1–4 (deterministic, rẻ) gánh toàn bộ.

### 3.6 AI conformance evals

Bộ intent prompts chuẩn (cố định, versioned) × N lần generate qua LLM thật → đo tỷ lệ đạt L0/L1/L2 ([10-ai-codegen.md](10-ai-codegen.md) §5). Non-deterministic nên **không chặn CI** — chạy scheduled + trước release, theo dõi trend. Đây là công cụ regression cho style guide và context builder: sửa prompt/context → eval cho biết conformance rate tăng hay giảm.

## 4. CI gates

- Layers 1–4: bắt buộc xanh trên mọi PR — đây là các gate deterministic duy nhất.
- Layer 5: chạy theo checklist Claude in Chrome trên PR chạm `@codeflow/react`, output là **evidence report** (screenshot + pass/fail từng mục) cho reviewer con người quyết định merge — KHÔNG phải gate tự động chặn (agent-driven không deterministic, cùng lý do layer 6 không chặn CI; "agent hiểu sai kịch bản" và "sản phẩm hỏng" cần người phân xử).
- Layer 6: scheduled + release; báo cáo trend, threshold cảnh báo (vd L1 rate < 90% → investigate).
- **Quy tắc fix bug**: mọi bug thật tìm thấy (kể cả từ review/production) → viết fixture/test tái hiện **trước**, rồi mới fix. Corpus chỉ phình ra, không co lại.

## 5. Coverage kỳ vọng

Với các module core moat (analyzer, mapper, patcher), thước đo chính không phải % line mà là **construct × edit-type matrix**: bảng chéo mọi construct được hỗ trợ với mọi loại edit — mỗi ô hoặc có fixture phủ, hoặc được đánh dấu unsupported rõ ràng trong specs. Ô nào không thuộc hai loại đó là lỗ hổng test.
