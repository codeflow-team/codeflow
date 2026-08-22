# NOTES — đọc sau khi ngủ dậy 😴

File này là nhật ký ngắn các quyết định t tự đưa ra trong lúc m ngủ + những gì cần m để mắt. Cập nhật liên tục, mục mới nhất ở trên.

---

## Update ~01:20 — Phase 2 (ANALYZER) nghiệm thu ✅ (commit `285d38e`)

- **Trái tim của lib đã chạy**: parser + mapper (semantic path/fingerprint/id deterministic) + analyzer đầy đủ theo 04-analyzer.md. Core giờ **456 tests xanh**, có **33 golden fixtures** (27 case khó theo yêu cầu + 6 case agent tự thêm).
- T đã verify tay: fixture canonical **khớp từng node/edge** với graph chuẩn 07 §6; case try/finally+break có đúng edge jump→finally; alias `const t = tools` resolve đúng còn object giả tên giống không bị nhận nhầm; smoke test live từ dist ra đúng condition/merge/code/unknown/output + diagnostics.
- **Quyết định specs t tự đưa** (theo phân tích của agent, t đồng ý và đã sửa 04 §1.4): hidden-call rule chỉ áp cho `await` + tool call (bắt rễ `tools`), KHÔNG áp cho sync library/local call trong expression — vì áp nguyên văn sẽ mâu thuẫn chính §2.2b/§2.6, và mục đích rule là side-effect visibility (sync predicate không có side-effect tầng flow).
- Giới hạn thừa nhận (đã document trong code, đúng specs): mutation ordering không model; nested try terminals chỉ route tới finally trong cùng, chưa transitively ra finally ngoài.

## Update ~03:40 — Phase 5 (AI CODEGEN + EVAL THẬT) nghiệm thu ✅ (commit `e579fcf`)

- `buildGenerationContext` + `renderSystemPrompt` + `validate` L0/L1/L2 xong. Core giờ **852 tests**.
- **EVAL THẬT VỚI `stealth/ox-alpha` — KẾT QUẢ: 12/12 đạt L2 (100%), 0 retries** trên 6 intents phủ đủ semantics MVP (while+bound, try/catch/finally, Promise.all, else-if, jumps...). Kết quả đầy đủ + code model sinh ra lưu ở `packages/core/test/ai/results/`.
- **Eval chứng minh giá trị ngay lần chạy đầu**: bắt được 1 lỗi conformance thật (model hoist promise ra const rồi Promise.all([xPromise,...]) → parallel biến mất khỏi graph, chỉ đạt 11/12). Sửa 1 câu trong style guide → chạy lại 12/12. Cả 2 bản kết quả đều được giữ để đối chiếu.
- Vòng retry feed-diagnostics đã verify với model thật: code seeded 5 lỗi → L0 → 1 vòng feedback → L2 sạch.
- Ablation: bỏ few-shot examples vẫn 6/6 L2 → khi cần tiết kiệm token có thể bỏ (~430 tokens).
- T đã fold định nghĩa L2 tinh chỉnh vào docs 10 §5 (code node chứa call chặn L2; code node plumbing không call thì được phép) và dedupe style guide: CLI giờ import rules từ core (một nguồn duy nhất).
- Chi phí: $0 (model free). Latency 20-120s/call (reasoning model).

## Update ~02:50 — Phase 4 (PATCH ENGINE) nghiệm thu ✅ (commit `5567457`) — VÒNG LÕI KHÉP KÍN 🎉

- Patch engine xong: **814 core tests** (897 toàn workspace), 30 edit cases trên 16 fixtures, transactional (fail → source không đổi 1 byte), KHÔNG dùng ts-morph reprint (chỉ thay text range nhỏ nhất, style đọc từ source).
- **ACCEPTANCE TEST CHÍNH THỨC CỦA MVP (08 §4) PASS** — t chạy live từ dist: đổi channel → đúng 1 dòng đổi, patch = `"#security"`→`"#engineering"`, sibling GIỐNG HỆT ngay dưới không bị đụng, MỌI node giữ id, round-trip idempotent, template literal nguyên vẹn. Đây là tiêu chí "project validated về mặt kỹ thuật" trong specs — ĐẠT.
- Encoding changes: field value = string thô (same-form) hoặc {kind: literal|expression|template|remove}; ops $condition/$iterable/$code/$tool/$delete/$insert. Bare expression + string thô bị TỪ CHỐI (bắt kind tường minh) — chống đổi kind ngầm, đúng 06 §3.
- Giới hạn ghi nhận: statement chèn mới luôn 1 dòng; đổi tool qua alias bị từ chối (nói rõ thay vì đoán); xóa positional arg của function node bị từ chối.

## Update ~02:55 — thả song song Phase 5 + Phase 6b (2 phase áp chót)

- **Phase 5** (Opus, core): buildGenerationContext + validate L0/L1/L2 + **AI CONFORMANCE EVAL CHẠY THẬT** với `stealth/ox-alpha`: 6 intents phủ semantics MVP, vòng generate→validate→feed-diagnostics-retry đúng 10 §5, kết quả lưu test/ai/results/.
- **Phase 6b** (Opus, react): bật editing trên UI — inspector Apply qua patchNode, palette insert, delete + dependency error, đổi tool, edit code node, diff preview — verify trong browser thật.
- Sau đó chỉ còn Phase 7: e2e Sonnet + Claude in Chrome.

## Update ~02:15 — Phase 6a (REACT UI + DEMO) nghiệm thu ✅ (commit `b10d54c`)

- `@codeflow/react` xong: canvas React Flow v12 + ELK hierarchical (loop/try là container thật), inspector với `{{ }}` display, Monaco sync 2 chiều, diagnostics panel, 3 mức progressive disclosure, light/dark. 37 tests + build sạch (t verify lại).
- **Demo app**: `pnpm dev` → http://localhost:5173 — preload sẵn ví dụ canonical, có thêm example try/catch và example degradation (unknown/code/hidden-call). Đây là app cho e2e Claude in Chrome.
- Agent đã tự verify TRONG BROWSER THẬT (Chrome DevTools): graph khớp 07 §6 từng node, sync chọn node↔highlight code chạy cả 2 chiều, và tự tìm+fix 1 bug thật (Monaco cursor listener bắt stale graph).
- Editing đang DISABLED có chủ đích (tooltip "Editing lands with the patch engine") — sẽ wire ở Phase 6b sau khi Phase 4 xong.

## Update ~01:45 — Phase 3 (IDENTITY) nghiệm thu ✅ (commit `edd9d3d`) → thả Phase 4

- Identity + diff xong: **563 tests xanh**. T smoke test tay kịch bản hiểm nhất: chèn call `slack.send` GIỐNG HỆT lên trước call cũ → id cũ ở đúng node cũ, node mới nhận id mới, không mis-bind; reformat toàn file → id giữ nguyên hết. Provenance hook sẵn sàng cho patcher.
- Điểm hay trong thuật toán của agent (t review và đồng ý): pass A match theo fingerprint **order-free** (LCS thuần không giải được hoán vị 2 call cùng tool), pass B mới là LCS; `tool` và `unknown` cùng một family để tool bị gỡ khỏi registry không làm mất id node.
- Giới hạn ghi nhận: edge chỉ có added/removed (specs không có edge.updated) → edge đổi mỗi label không hiện trong diff.
- **Phase 4 đã thả** (Opus, packages/core): patch engine + round-trip suite + acceptance test 08 §4 (đổi channel → diff đúng 1 dòng, byte-for-byte).

## Update ~01:25 — thả song song Phase 3 + Phase 6a

- **Phase 3** (Opus, packages/core): identity resolution (sibling alignment LCS fingerprint-first, provenance hook, code-node statement-fingerprint overlap) + session continuity + GraphChange diff + 11 kịch bản identity test bắt buộc (kể cả case hiểm: chèn call giống hệt trước call đang có — không được mis-bind).
- **Phase 6a** (Opus, packages/react + apps/demo): React Flow canvas + ELK hierarchical + inspector (fields hiển thị nhưng disabled chờ patch engine) + Monaco sync 2 chiều + demo app (sẽ là app cho e2e Claude in Chrome).

## Update ~00:45 — CLI nghiệm thu ✅ (commit `2e06ca0`)

- `@codeflow/cli` xong: FileFunctionLibraryStore trên `lib/` (metadata nằm trong header comment của chính file — không có bản sao thứ hai), `codeflow generate` (load `codeflow.config.ts` bằng Node 24 type-stripping, không thêm dep), `codeflow init` scaffold workspace mẫu. 46/46 tests, tsc sạch.
- **CLI agent bắt được 1 bug thật trong specs** (có từ draft GPT v0.1): `files.some(isAuthChange)` (ví dụ canonical) mâu thuẫn signature `isAuthChange(files: File[])` — callback của `.some` nhận 1 phần tử. **T quyết: đổi thành per-file predicate `isAuthChange(file: File)`** (giữ nguyên ví dụ canonical + quy tắc sugar, chỉ sửa definition 05 §4 + templates/tests CLI). Đã sửa, test lại xanh.
- Deviation đáng chú ý của CLI (đều hợp lý, chi tiết trong transcript): scaffold tsconfig dùng `moduleResolution: "Bundler"` (vì flow contract import không đuôi); `rename` trong file-store có sửa tên declaration trong chính file function (để workspace còn type-check) nhưng KHÔNG sửa flow đang import (đúng specs); vitest chưa vào devDeps của cli (cấm sửa lockfile khi agent khác đang chạy) — **TODO: `pnpm install` bổ sung sau khi Phase 2 xong**.

## Trạng thái lúc m đi ngủ (2026-08-23 ~00:30)

- ✅ **Phase 0**: môi trường OK; model AI `stealth/ox-alpha` (OpenRouter) đã test — chạy được, cost = 0. Key lưu ở `.env` (đã gitignore). Lưu ý: là reasoning model → khi gọi phải để `max_tokens` cao.
- ✅ **Phase 1 nghiệm thu**: monorepo 4 packages; `@codeflow/core` có model types + registry + codegen; 106/106 tests xanh, tsc sạch, browser-safe. T đã smoke-test codegen bằng tay từ dist — đúng shape specs.
- 🔄 **Phase 2 đang chạy** (Opus): analyzer + 27 fixture cases khó (code→workflow).
- 🔄 **CLI đang chạy** (Opus, song song, phạm vi tách biệt): FileFunctionLibraryStore + `codeflow generate/init`.

## Kế hoạch t sẽ tự chạy tiếp (không chờ m)

1. Verify Phase 2 (chạy corpus, tự đối chiếu expected-graph với specs) → fix nếu lệch.
2. Phase 3 (mapper identity) + Phase 4 (patcher + round-trip suite) — Opus agents, t verify.
3. Phase 5: AI codegen (`buildGenerationContext`, `validate` L0/L1) + integration test gọi thật `ox-alpha` đo conformance.
4. Phase 6: React UI + demo app.
5. Phase 7: e2e bằng Claude in Chrome (Sonnet agent). ⚠️ Bước này điều khiển Chrome trên máy m — nếu extension/permission chặn thì t sẽ ghi lại đây và để dành khi m dậy.

## Quyết định t đã tự đưa (kèm lý do ngắn)

- **Git đã init** (m yêu cầu trước khi ngủ) — baseline commit `c4bd8d3` gồm docs + Phase 1 + WIP. Từ giờ t commit sau mỗi phase nghiệm thu xong → rollback/diff theo phase được. `.env` (chứa API key) đã kiểm tra KHÔNG bị commit.
- Codegen output **sort alphabet** thay vì theo thứ tự đăng ký — để file generated byte-stable (file này commit vào repo theo specs 10 §2).
- `sha256` tự viết trong core (không dùng node:crypto/crypto.subtle) — giữ core browser-safe + hash sync.

## Cần m quyết sau (không gấp, t đã chọn hướng an toàn)

- (chưa có — sẽ thêm nếu phát sinh)

## Sự cố / lưu ý

- (chưa có)
