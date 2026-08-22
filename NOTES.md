# NOTES — đọc sau khi ngủ dậy 😴

---

# 🏁 TỔNG KẾT (~05:50): MVP CODEFLOW HOÀN CHỈNH — 100% theo specs

**Toàn bộ 08-mvp.md đã được implement, test và verify. Không còn gap.**

## Con số cuối

- **1005 tests xanh** (core 852 · react 66 · cli 63 · mcp 24) + 1 skipped (AI live test, cần key), tsc + build sạch 5/5 packages.
- **10 commits** sạch theo phase (`git log --oneline` xem lịch sử; rollback theo phase được).
- **Acceptance test chính thức 08 §4: PASS** (cả trong test suite lẫn live từ dist lẫn trên browser thật): đổi channel → đúng 1 dòng đổi byte-for-byte, mọi node giữ id, round-trip idempotent.
- **AI conformance (yêu cầu của m): 12/12 đạt L2 (100%)** với model free `stealth/ox-alpha` — kết quả + code AI sinh lưu ở `packages/core/test/ai/results/`. Eval còn bắt được 1 lỗi conformance thật ngay lần chạy đầu → sửa style guide → 100%.
- **E2E browser: 12/12 PASS** (`e2e/report.md` + screenshots).

## Chạy thử ngay

```bash
pnpm dev                                    # demo UI → http://localhost:5173
pnpm test                                   # 1005 tests
node packages/core/scripts/ai-eval.mjs      # chạy lại AI eval (free, ~10 phút)
npx codeflow init <dir> && npx codeflow generate && npx codeflow check   # CLI (từ packages/cli)
```

Demo preload ví dụ canonical: xem graph → click node → sửa channel trong inspector → Apply → thấy code đổi đúng 1 dòng. Có example try/catch + degradation trong dropdown.

## Những gì đã build (map vào specs)

| Package | Nội dung | Specs |
|---|---|---|
| `@codeflow/core` | model + registry + codegen tools.d.ts/lib.d.ts · parser/analyzer (mọi construct MVP kể cả try/catch/while/jump) · stable identity + provenance · graph diff · patch engine transactional byte-for-byte · validate L0/L1/L2 + GenerationContext | 03,04,05,06,10 |
| `@codeflow/react` | React Flow canvas + ELK nested · inspector editing đầy đủ · palette · Monaco sync 2 chiều · diff preview · conflict flow · diagnostics · 3 mức disclosure · dark/light | 07 |
| `@codeflow/cli` | init/generate/check · FileFunctionLibraryStore trên lib/ · usage index | 02,05,10 |
| `@codeflow/mcp` | MCP JSON Schema → ToolDefinition (slugging tên an toàn, cursor paging, zero runtime dep) | 05 §3 |
| `apps/demo` | app demo đầy đủ vòng xem + sửa | — |

## ⚠️ Cần m để mắt / quyết sau

1. **Claude in Chrome cho e2e**: extension bắt chọn browser tương tác (3 browser đang connect) nên subagent phải fallback chrome-devtools (vẫn Chrome thật, evidence đủ). Muốn chạy đúng qua extension → bảo t chạy lại lúc m thức.
2. **Backlog nhỏ không block** (chi tiết trong e2e/report.md + các mục dưới): cursor cột-1 chọn container cha; inspector inputs thiếu id/name (a11y); edge label-only change không hiện trong diff; component tests jsdom chưa có; `--watch` cho check chưa làm.
3. **Specs đã được sửa 3 lần trong lúc build** (đều ghi lý do ở các mục dưới): isAuthChange per-file predicate; hidden-call rule thu hẹp về await/tools; L2 cho phép code node không chứa call. Code và docs hiện khớp nhau.
4. API key OpenRouter nằm ở `.env` (không vào git). Model là reasoning model — gọi cần max_tokens ≥ 8000.

---

File này là nhật ký ngắn các quyết định t tự đưa ra trong lúc m ngủ + những gì cần m để mắt. Cập nhật liên tục, mục mới nhất ở trên.

---

## Update ~01:20 — Phase 2 (ANALYZER) nghiệm thu ✅ (commit `285d38e`)

- **Trái tim của lib đã chạy**: parser + mapper (semantic path/fingerprint/id deterministic) + analyzer đầy đủ theo 04-analyzer.md. Core giờ **456 tests xanh**, có **33 golden fixtures** (27 case khó theo yêu cầu + 6 case agent tự thêm).
- T đã verify tay: fixture canonical **khớp từng node/edge** với graph chuẩn 07 §6; case try/finally+break có đúng edge jump→finally; alias `const t = tools` resolve đúng còn object giả tên giống không bị nhận nhầm; smoke test live từ dist ra đúng condition/merge/code/unknown/output + diagnostics.
- **Quyết định specs t tự đưa** (theo phân tích của agent, t đồng ý và đã sửa 04 §1.4): hidden-call rule chỉ áp cho `await` + tool call (bắt rễ `tools`), KHÔNG áp cho sync library/local call trong expression — vì áp nguyên văn sẽ mâu thuẫn chính §2.2b/§2.6, và mục đích rule là side-effect visibility (sync predicate không có side-effect tầng flow).
- Giới hạn thừa nhận (đã document trong code, đúng specs): mutation ordering không model; nested try terminals chỉ route tới finally trong cùng, chưa transitively ra finally ngoài.

## Update ~05:20 — Phase 7 (E2E) nghiệm thu ✅ (commit `ba13a4a`) — 12/12 PASS

- E2e Sonnet chạy đủ 12 mục checklist theo 11 §3.5: **12/12 PASS, không bug chặn release**. Report: `e2e/report.md`, 31 screenshots ở `e2e/screenshots/` (19MB, để ngoài git).
- ⚠️ **Claude in Chrome không dùng được cho subagent khi m ngủ**: extension yêu cầu chọn 1 trong 3 browser đang kết nối qua hộp thoại tương tác → agent fallback sang chrome-devtools MCP (vẫn Chrome thật, evidence đầy đủ). Nếu m muốn chạy đúng qua Claude in Chrome extension: lúc m thức, bảo t chạy lại — chỉ cần m chọn browser 1 lần.
- 2 ghi nhận phụ vào backlog (không block): cursor cột 1 chọn container cha thay vì statement; inspector inputs thiếu id/name (a11y).
- **Gap cuối đang đóng** (agent Opus đang chạy): `@codeflow/mcp` adapter (MVP scope 08 §1) + `codeflow check` (đang là stub). Xong 2 cái này là MVP đủ 100% theo specs.

## Update ~04:50 — Phase 6b (EDITING UI) nghiệm thu ✅ (commit `5f76f38`) → thả Phase 7 e2e

- Editing đầy đủ trên UI: inspector Apply (multi-field, 1 patchNode), Preview diff, palette insert (needs-configuration flow), delete 2-bước + dependency error, đổi tool + warnings, Edit Code modal, conflict flow (Monaco edit → patch-conflict → Re-analyze → retry OK), `{{ }}` trong string literal bị từ chối đúng specs rồi cho convert tường minh.
- Agent verify 10 kịch bản TRONG BROWSER THẬT, screenshots ở `.codeflow-verify/` (17 files, để ngoài git), tìm + fix 4 bug UI thật (stale debounce, selection drop sau patch, changedNodeIds quá rộng, unknown node fields).
- Toàn workspace: **964 tests** (core 852 + react 66 + cli 46), tsc sạch.
- **Phase 7 đã thả** (SONNET + Claude in Chrome, đúng phân công): 12 mục checklist e2e theo 11 §3.5, report sẽ ở `e2e/report.md`. Có fallback chrome-devtools nếu extension bị chặn permission (sẽ ghi rõ trong report).

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
