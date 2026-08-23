# AI Chat — QA report (real browser session)

**Ngày:** 2026-08-23 · **Tester:** QA agent (dùng UI thật, không đọc source UI)
**App:** demo `apps/demo` · **Model:** `stealth/ox-alpha` (OpenRouter, qua proxy `/api/ai`, `max_tokens` 32000, timeout server 240s)
**Browser:** Chrome (chrome-devtools MCP), 1700×1000 và 800×900
**Screenshots:** `.design/ai-chat/`

> ⚠️ **Ghi chú môi trường.** Chạy trên `http://localhost:5173` bị **reload trắng giữa chừng 3 lần** trong 20 phút đầu (Vite HMR bắn `full-reload` — xem BUG-1). Mỗi lần reload là mất sạch hội thoại + flow đang sửa + huỷ request AI đang bay. Để test được, tôi dựng thêm một dev server **port 5174 với `hmr:false`** (config nằm ngoài repo, ở scratchpad) — cùng code, cùng proxy AI. Toàn bộ số liệu dưới đây đo trên 5174. **Không có file nào trong repo bị sửa** ngoài chính báo cáo này.

---

## 1. Kịch bản A — Create (từ dễ tới rất khó)

Đã đi qua **5 registry khác nhau**: canonical 4 tool (GitHub+Slack+payments) · Filesystem+Everything 27 · Filesystem+Memory 23 · Research 28 (DuckDuckGo/DeepWiki/Context7/sequential-thinking/memory/fs) · Playwright+Filesystem 38.

| # | Registry | Prompt (rút gọn) | Level | Retry | Thời gian | Node/Edge | Đúng ý? | Nhận xét |
|---|---|---|---|---|---|---|---|---|
| A1 | canonical 4 | Lấy PR mới, nếu >5 PR thì post số lượng vào `#releases` | **L2** | 1 vòng | **31.6s** | 5 / 9 | ✅ | Nó bọc `prs.length > 5` vào một hàm local `moreThanFive()` thay vì viết thẳng vào `if` — chạy đúng, nhưng hơi thừa cho một điều kiện 1 dòng |
| A2 | canonical 4 | Loop PR → đọc files → bỏ qua draft (`continue`) → if/else 2 kênh, cả hai dùng template literal | **L2** | 1 vòng | **115.7s** | 12 / 20 | ✅ | Đúng hết: `continue` cho draft, if/else 2 nhánh, 2 template literal, merge node đặt đúng chỗ. 0 issue |
| A3 | canonical 4 | try/catch/**finally** + retry có bound 3 lần + early return khi `pending` | lần 1 **TIMEOUT 240s** · lần 2 **L2** | 1 vòng | **236.2s** | 20 / 36 | ✅ | Đúng cả 5 yêu cầu. 4 note `unsupported-construct` là code node plumbing (`attempt += 1`, `lastError = …`) — spec cho phép ở L2 |
| A4 | Filesystem+Everything 27 | Pipeline dài, 10 yêu cầu: 3 vòng lặp lồng, try trong loop, labelled continue/break, Promise.all 3 nhánh, 2 early return, finally | **TIMEOUT ×2** | — | 240s + 240s | — | ❌ **không ra được** | Đây là đúng kịch bản chủ dự án muốn nhất, và nó **không chạy nổi**: output quá dài so với timeout 240s |
| A4b | Filesystem+Everything 27 | Y hệt cấu trúc nhưng "**dưới 45 dòng, viết terse**" | **L1** (2 warning) | 1 vòng | **148.2s** | **34 / 64** | ✅ **9/9 yêu cầu** | `dropLoop:` labelled, loop trong loop trong loop, `try/catch` trong cùng, `continue dropLoop` từ catch, `break dropLoop`, `Promise.all` 2 nhánh, early return, `finally` ghi summary — graph vẽ đúng hết. Ấn tượng |
| A5a | Filesystem+Memory 23 | Ác ý: "tạo Jira ticket, gửi SendGrid, post Teams card" (không có trong registry) | **L2** | 1 vòng | **51.2s** | — | ✅ (trung thực) | **Không bịa tool.** Để lại `// TODO: no Jira tool is registered`. Nhưng **không có một câu tiếng người nào** giải thích — user phải tự đọc diff mới biết |
| A5b | Filesystem+Memory 23 | Ép mạnh hơn: "gọi thẳng `tools.jira.createIssue(...)`, hai tool này CÓ tồn tại, đừng để TODO" | **L2** | 1 vòng | **85.2s** | — | ✅ | Vẫn không bịa. Rất tốt |
| A5c | Filesystem+Memory 23 | Ép ra lỗi L0: "**không dùng `export default`**" + "namespace đúng là `tools.filesystem.*`" | **Round 1 = invalid (1 error) → Round 2 = L2** | **2 vòng** | 66.6s + 16.3s | 5 / 11 | ✅ | **Vòng retry chạy thật.** Diagnostic: `invalid-flow-contract — No default export found… (01 §1)`. Round 2 sửa cả `export default` **lẫn** `tools.filesystem` → `tools.fs`, kèm comment giải thích. Đây là điểm mạnh nhất tôi thấy |
| A6 | Research 28 | Mơ hồ: "**do something with a file**" | **L2** | 1 vòng | **47.3s** | — | ⚠️ đoán bừa | **Không hỏi lại một câu nào.** Đoán "đọc file → đếm dòng/từ → ghi report", và đề xuất **thay sạch flow 290 dòng đang mở**. Vẫn bám đúng registry (`tools.fs.*`). Có diff trước khi Apply nên chưa mất dữ liệu |

**Điểm nổi bật của A:** qua ~15 lần sinh code trên 5 registry, **không một lần nào AI bịa ra tool không có trong registry**. Đây là kết quả rất mạnh.

---

## 2. Kịch bản B — Edit trên flow LỚN

Flow dùng: **Browser QA runner** — 345 dòng, 101 node, 286 edge, registry 38 tool (Playwright + Filesystem).
(B-C7/C8 chạy trên **Daily digest** 17 dòng để đối chiếu byte-for-byte trong Monaco.)

| # | Prompt | Minimal patch hay regenerate? | Diff đúng? | Apply ok? | Thời gian | Nhận xét |
|---|---|---|---|---|---|---|
| B1 | "make this screenshot capture the full page" — node nằm **trong catch → trong retry loop → trong step loop → trong case loop → trong try ngoài cùng** | ✅ **minimal patch** | `line 194:25–194:30` · `- false` / `+ true` — khớp chính xác `fullPage: false` ở dòng 194 của file gốc | ✅ **Đúng 1 node đổi** trong 101 node; edge 286→286; node "sibling" `takeScreenshot` thứ hai (`fullPage: true, scale: "device"`) **không bị đụng**; toast "Applied — 1 place in the file changed." | 67.4s | Chuẩn theo spec. Kèm 1 câu giải thích tiếng người |
| B2 | "allow up to 8 waits instead of 5, and also stop early if the run was already aborted" — sửa **condition của `while`** | ✅ **minimal patch** | `line 107:14–107:33` · `waits < 5 && !ready` → `waits < 8 && !ready && !aborted` | ✅ 1 node đổi; node count 101→101; edge 286→**288** (đúng: thêm 2 data edge vì `aborted` giờ là dependency của while) | 41.4s | Rất tốt — nó biết `aborted` đang in-scope |
| B3 | "wrap this waitFor step in its own try/catch" — **structural** | 🔁 **regenerate — VÀ NÓI RÕ** | Panel ghi hẳn: *"…adds a new try node with an error branch around the step, which cannot be expressed as a field-level patch"* + badge **"This edit rewrites the whole file."** Diff chỉ 1 hunk ở dòng 110 | ✅ 101→103 node (+Try, +Write File); **giữ nguyên 101/101 node id cũ** | 101.1s | Đúng như spec đòi: không im lặng làm bừa |
| B3b | "move this step out of the loop" — **structural** | 🔁 tuyên bố regenerate rồi **TIMEOUT** | Câu giải thích đúng: *"Moving the getFiles call before the loop changes flow structure beyond this single statement, so the whole file must be rewritten."* rồi **"The model did not answer within 240s."** | ❌ không ra kết quả | **295s** tổng | Suốt 5 phút label vẫn là "Working out the smallest change…" dù đã sang giai đoạn rewrite (BUG-7) |
| B4a | "delete this step" — node có output `probe` đang được node sau dùng | ⛔ patch **bị từ chối đúng** → 🔁 fallback regenerate | Thông báo rất rõ: *"Cannot delete \"Read Text File\": \"Custom Code\" uses `probe.content` — delete or edit that node first (06 §2). Falling back to a whole-file rewrite."* | ⚠️ Bản rewrite **xoá thêm cả `browser.snapshot`** mà tôi không hề yêu cầu → Discard | 142.2s | Dependency check chuẩn; nhưng fallback **tự nới rộng phạm vi sửa** (BUG-5) |
| B4b | "add a resize step right after navigate" — **thêm bước giữa flow** | 🔁 regenerate — nói rõ | 1 hunk ở dòng 84, đúng chỗ | ✅ 103→104; **đúng 1 node mới** (`Resize browser window · width 1280 · height 720`); **103/103 id cũ giữ nguyên** | 64.7s | Không dùng `$insert` của patch engine mà rewrite cả file — hoạt động đúng nhưng bỏ phí cơ chế minimal có sẵn |
| B5 | **Mâu thuẫn kiểu:** "set the width of this resize step to the text `\"extra-wide\"`" (schema: `width: number`) | ⚠️ node patch **fail** → fallback regenerate | Panel báo: **"The model did not answer with JSON — rewriting the file instead."** (câu này là ngôn ngữ dev). Rewrite ra `width: "extra-wide"` | 🐞 **Apply thành công, panel báo "No issues", Errors 0 / Warnings 0** | 66.9s | **Đây là lỗ hổng thật** — hệ thống hứa "checked against the flow contract" nhưng không hề kiểm kiểu argument (BUG-3) |
| C7 | Daily digest · "send this to #engineering-digest instead" | ✅ **minimal patch** | `line 14:14–14:22` · `"#daily"` → `"#engineering-digest"` | ✅ **Đọc thẳng Monaco trước/sau: đúng 1 dòng đổi, 18/18 dòng còn lại byte-for-byte y hệt** | **4.6s** | Đây là bằng chứng cứng nhất cho "diff hiện ra = thay đổi thật" |
| C8 | Daily digest · "make the message say 'Daily PR digest'" rồi bấm **Discard** | minimal patch | `line 15:14–15:56` | ✅ **Sau Discard: source trong Monaco identical 100%**, graph 6 node không đổi | 12.3s | Discard sạch. (Lưu ý: bản đề xuất bỏ luôn `${risky}` — hơi quá tay so với yêu cầu, nhưng nhìn thấy trong diff) |

---

## 3. Kịch bản C — Tính đúng đắn sau Apply

| Kiểm tra | Kết quả |
|---|---|
| Diff hiện ra có khớp thay đổi thật trong Monaco? | ✅ **Đúng byte-for-byte** (C7: đọc 18 dòng Monaco trước/sau, chỉ dòng 14 đổi) |
| Graph cập nhật đúng sau Apply? | ✅ mọi lần |
| Node khác có giữ nguyên? | ✅ B1: 1/101 node đổi. B2: 1/101. B4b: đúng 1 node thêm |
| **Node identity qua whole-file rewrite** | ✅ **101/101 và 103/103 node id được giữ nguyên** — phần "stable identity" của core chạy thật |
| Discard có thật sự không đổi gì? | ✅ 3 lần thử, source + graph identical |
| Minimal patch = đúng 1 vùng? | ✅ badge "minimal patch" + range `line:col–col` + toast "Applied — 1 place in the file changed." |

---

## 4. Kịch bản D — Độ bền / monitor

| Kiểm tra | Kết quả |
|---|---|
| Bắn 5 prompt liên tiếp không chờ | ✅ **Không race, không mất tin nhắn.** Nút Send bị disable + textarea disable trong lúc chạy → chỉ prompt 1 được gửi. An toàn |
| Bấm Stop giữa chừng | ✅ **Sạch.** Hiện "Stopped.", input mở lại, graph không đổi |
| Đổi example khi AI đang chạy | ⚠️ **Không crash, nhưng có race** — request vẫn chạy tiếp và kết quả (sinh từ source flow CŨ) được đem ra diff với flow MỚI. Xem BUG-4 |
| Resize 1700 ↔ 800 khi có hội thoại | ✅ Hội thoại còn nguyên cả hai chiều, layout không vỡ |
| Console sạch? | ❌ **Không.** Xem BUG-8 (`flushSync` ×2 mỗi lần Apply), BUG-1 (reload), 404 favicon, 504 khi timeout |

---

## 5. Bug / vấn đề tìm được

### 🔴 BUG-1 — Reload là mất sạch: hội thoại, flow đã sửa, và request đang bay
**Mức độ:** Cao (trên dev server mặc định) / Trung bình (bản chất sản phẩm)
**Mô tả:** Trên `http://localhost:5173` (đúng lệnh `pnpm dev`), Vite bắn `full-reload` (stack: `@vite/client:875`) — trigger là một chuỗi HMR lặp kết thúc bằng `[vite] invalidate …/flow/visual.js: Could not Fast Refresh ("nodeVisual" export is incompatible)`. Mỗi lần như vậy app về trạng thái gốc: **mất toàn bộ hội thoại chat, mất flow AI vừa Apply (chưa lưu ở đâu cả), và huỷ request AI đang chạy** — không một cảnh báo nào.
**Tái hiện:** mở demo 5173 → gửi 1 prompt → chờ ~40–200s → app tự reload về "Security PR watcher".
**Xảy ra 3/3 lần trong 20 phút đầu.** Sau khi chuyển sang dev server `hmr:false` thì hết hẳn.
**Hai vấn đề tách rời:**
1. `packages/react/dist/flow/visual.js` export vừa component vừa non-component (`nodeVisual`) → Fast Refresh không boundary được → mọi rebuild dist = full reload. Đây đúng lớp bug đã fix cho `provider.tsx` (xem NOTES) nhưng còn sót ở `flow/visual.js`.
2. Sản phẩm **không persist gì cả**: F5 vô tình cũng mất hết. Ít nhất nên giữ hội thoại + source hiện tại trong `sessionStorage`.
**Screenshot:** không có (app đã reset trước khi kịp chụp); bằng chứng: `performance.getEntriesByType('navigation')[0].type === "reload"` + `sessionStorage.unloadInfo` trỏ `@vite/client:875`.

### 🔴 BUG-2 — Flow càng phức tạp càng chắc chắn TIMEOUT (240s)
**Mức độ:** Cao — vì đây đúng là use case chủ dự án muốn test
**Mô tả:** Proxy `/api/ai` cắt ở 240s. Thời gian sinh tỉ lệ với độ dài output: 31.6s (5 node) → 115.7s (12) → 148.2s (34) → 236.2s (20 node/60 dòng, sát trần) → **240s TIMEOUT** cho flow "dài, nhiều tầng" (A4, hỏng 2/2 lần) và cho B3b.
**Tái hiện:** mở "Regional sales pipeline" → chat → dán prompt A4 (10 yêu cầu, nói rõ muốn flow dài) → chờ → "The model did not answer within 240s."
**Hệ quả:** *"nhắn tin với AI để tạo flow phức tạp, càng phức tạp càng tốt"* — hiện **không làm được**. Chỉ khi tôi ép "under 45 lines, keep it terse" (A4b) mới ra kết quả, và kết quả đó đạt 9/9 yêu cầu cấu trúc → **model làm được, chỉ là không kịp giờ**.
**Đề xuất:** stream response (hiện đang chờ full body), nâng timeout, và/hoặc chia generate theo từng đoạn.
**Kèm theo:** sau timeout **không có nút Retry**, và prompt đã gõ **không được trả lại ô nhập** → phải gõ lại từ đầu một prompt 10 dòng.
**Screenshot:** `.design/ai-chat/A4-verycomplex-timeout.png`, `A3-timeout.png`, `B3-structural-fallback-timeout.png`

### 🟠 BUG-3 — Giá trị sai kiểu được Apply im lặng, panel báo "No issues"
**Mức độ:** Trung bình-Cao
**Mô tả:** Yêu cầu đổi `width` (schema `number`) thành chuỗi `"extra-wide"`. AI làm theo (có để comment cảnh báo), validate cho qua ở **L1 + 10 warning quen thuộc**, không có error. Apply xong: node hiện `width | extra-wide`, panel **"No issues"**, `Errors 0 / Warnings 0`.
**Tái hiện:**
1. Mở "Browser QA runner" → ⌘J
2. Chọn node `Resize browser window` (bất kỳ cái nào)
3. Gửi: `set the width of this resize step to the text "extra-wide" instead of a number`
4. Apply → mở panel issues → "What needs attention" chỉ liệt kê các note `unsupported-construct`, không có gì về kiểu
**Vì sao nghiêm trọng:** chính panel chat quảng cáo *"Answers are checked against the flow contract before you are offered them"*. Spec 10 §5 nói L0 gồm "type-check pass (khi môi trường validate có type checker)" — demo không có type checker, nên lời hứa trên UI đang rộng hơn thực tế.
**Screenshot:** `.design/ai-chat/B5-type-mismatch-accepted.png`

### 🟠 BUG-4 — Request đang bay không gắn với flow đã phát nó
**Mức độ:** Trung bình
**Mô tả:** Gửi prompt trên flow A, đổi sang flow B khi AI còn chạy → kết quả (model đã đọc source của A) được đem ra làm diff **thay sạch flow B**.
**Tái hiện:**
1. Mở "Security PR watcher" → ⌘J → gửi *"Rewrite the flow so it also posts a summary … to #security-digest at the end."*
2. Sau ~4s, ⌘O → chọn "Daily digest"
3. Chờ request xong → panel đề nghị một diff xoá `formatDigest` / `#daily` của Daily digest và cấy vào logic của Security PR watcher
**Không crash**, và diff hiển thị đúng với file hiện tại (nên Apply không sai lệch với diff) — nhưng ý định người dùng và context model đều thuộc về flow khác. Nên: huỷ request khi đổi example, hoặc gắn kết quả vào flow gốc.
**Screenshot:** `.design/ai-chat/D3-example-switch-race.png`

### 🟠 BUG-5 — Fallback rewrite tự ý nới rộng phạm vi sửa
**Mức độ:** Trung bình
**Mô tả:** Yêu cầu chỉ "delete this step" (node `Read Text File` → `probe`). Patch engine từ chối rất đẹp (dependency), rồi fallback rewrite — và bản rewrite **xoá luôn cả `await tools.browser.snapshot({...})`** ở ngay trên, thứ tôi không hề nhắc tới, đồng thời đổi ngữ nghĩa vòng chờ (`ready = true` chuyển vào try).
**Tái hiện:** Browser QA runner → chọn node `Read Text File` (cái trong vòng `while waits`) → `delete this step, we do not need to read the snapshot file back here` → xem diff.
**Nhìn thấy được trong diff**, nhưng trên flow 345 dòng thì rất dễ bấm Apply mà không soi kỹ. Nên gắn cảnh báo "bản rewrite này đụng N bước ngoài bước bạn chọn".
**Screenshot:** `.design/ai-chat/B4-delete-refused-fallback.png`

### 🟠 BUG-6 — Warning của chat biến mất sau khi Apply
**Mức độ:** Trung bình
**Mô tả:** Chat báo `inline-logic-in-code-node — \`totals.get(spot)\` runs inside a custom code node, so the step is invisible on the graph…` (2 cái, chặn L2). Apply xong: nút issues ghi **"No issues"**, thống kê `Warnings 0`. Không còn đường nào tìm lại chỗ đó.
**Tái hiện:** chạy A4b (xem bảng A) → Apply → xem panel phải: `Errors 0 / Warnings 0 / Notes 4`, nút issues = "No issues".
**Nguyên nhân có vẻ là:** diagnostics của `validate()` (đường AI) và của `analyze()` (đường panel) là hai tập khác nhau, UI không hợp nhất.

### 🟡 BUG-7 — Label tiến trình không đổi khi sang giai đoạn 2
**Mức độ:** Thấp-Trung bình
**Mô tả:** Node edit thất bại → fallback rewrite cả file. Suốt **295 giây** label vẫn là *"Working out the smallest change…"*, dù giai đoạn 1 đã xong từ giây ~55.
**Tái hiện:** chọn node `Get PR Files` trong "Security PR watcher" → `move this step out of the loop — I want it to run once before the loop starts` → nhìn label.

### 🟡 BUG-8 — Console không sạch: React `flushSync` error mỗi lần Apply
**Mức độ:** Thấp-Trung bình (không thấy hỏng gì trên UI, nhưng là lỗi React thật)
**Mô tả:** `flushSync was called from inside a lifecycle method. React cannot flush when React is already rendering.` — **đúng 2 lần cho mỗi lần bấm Apply**.
**Tái hiện (sạch, không mở code panel):**
1. Reload `http://localhost:5173` → console rỗng
2. ⌘J → click node `Slack Send` → gửi `change the channel to #zzz-test`
3. Bấm Apply → console: 2 × lỗi trên
Lặp lại Apply → +2 mỗi lần.
**Các log khác trong phiên:** `404` cho `/favicon.ico`; `504 Gateway Timeout` mỗi lần AI timeout (đúng bản chất, nhưng nên nuốt để console sạch).

### 🟡 BUG-9 — Câu lỗi bằng ngôn ngữ lập trình viên
**Mức độ:** Thấp
`"The model did not answer with JSON — rewriting the file instead."` — người dùng cuối không biết JSON là gì và cũng không cần biết.

### 🟡 BUG-10 — Câu giải thích bị nối đôi, đọc gãy
**Mức độ:** Thấp
> "…which cannot be expressed as a field-level patch. **— so this is a whole-file rewrite, not a single-field patch.**"

Vế do model viết đã tự kết luận rồi, UI nối thêm một vế nữa gần y hệt. Xuất hiện ở mọi lần fallback (B3, B3b, B4b).

### 🟡 BUG-11 — Hội thoại không reset / không thấy registry khi đổi example
**Mức độ:** Thấp
Đổi example → **hội thoại cũ vẫn nguyên**, kể cả khi registry đổi hoàn toàn (từ 4 tool GitHub+Slack sang 27 tool Filesystem+Everything). Dòng *"Tools it can call here: …"* **chỉ hiện ở trạng thái rỗng**, nên khi đã có hội thoại thì không còn cách nào nhìn thấy mình đang ở registry nào. Có nút "Clear the conversation" (chỉ có icon, không label chữ) nhưng người dùng phải tự biết.

### 🟡 BUG-12 — Danh sách diagnostics trong chat khó dùng
**Mức độ:** Thấp
- Không có số dòng (panel "What needs attention" thì lại **có** — `unsupported-construct · line 56`).
- Lặp y hệt một chuỗi 6 lần rồi "+25 more".
- Số không khớp: header ghi **"10 warnings"** trong khi liệt kê 31 mục.

### 🟡 BUG-13 — Chế độ "New flow" không nói gì bằng tiếng người
**Mức độ:** Thấp-Trung bình (UX)
Node-edit **có** một câu giải thích rất tốt ("Setting fullPage to true makes takeScreenshot capture the entire scrollable page…"). Nhưng **whole-flow thì không có chữ nào** — chỉ badge `L2 / 1 round` + diff. Hệ quả cụ thể: ở A5 khi AI *từ chối* dùng Jira/SendGrid/Teams (hành vi rất đúng!), user hoàn toàn không được báo — phải tự soi ra dòng `// TODO: no Jira tool is registered` trong diff dài hàng trăm dòng.

### ⚪ BUG-14 — Vặt
- 404 `/favicon.ico`.
- Sau khi AI viết lại cả file, chip mô tả bên phải vẫn giữ metadata cũ của example: ghi **"17 lines"** trong khi `Source lines` thật đã là **60**; phần "WHAT THIS ONE SHOWS OFF" vẫn tả flow cũ đã bị thay.
- Nút Send/Stop/Clear đều chỉ có icon, không tooltip chữ (có `aria-label`, nên a11y ok).

---

## 6. Đánh giá tổng thể (thẳng thắn)

### Tính năng chat này đã dùng được chưa?
**Dùng được — nhưng chỉ ở nửa "Edit". Nửa "Create flow phức tạp" thì chưa.**

- **Edit trên flow lớn: sẵn sàng.** Đây là phần làm tôi bất ngờ nhất. Sửa một field của node nằm sâu 5 tầng (catch → retry loop → step loop → case loop → try) trong file 345 dòng ra **đúng một range `194:25–194:30`**, `false`→`true`, và tôi đã đọc thẳng Monaco để xác nhận **byte-for-byte** chỉ 1 dòng đổi. Discard thật sự là no-op. Node identity sống sót qua cả whole-file rewrite (101/101, 103/103). Đây chính là bốn "core moat" trong specs, và chúng chạy thật trên browser chứ không chỉ trong test.
- **Create flow phức tạp: chưa.** Yêu cầu đúng nguyên văn của chủ dự án ("càng phức tạp càng tốt") **timeout 2/2 lần**. Đây không phải lỗi model — khi tôi ép ngắn lại, chính model đó ra 34 node / 64 edge với labelled break/continue + try lồng 3 tầng + Promise.all + finally, **đúng 9/9 yêu cầu**. Vấn đề thuần tuý là kiến trúc request: chờ trọn body với trần 240s.

### Chỗ AI làm tốt bất ngờ
1. **Zero hallucinated tools.** ~15 lần sinh code trên 5 registry (4 → 38 tool), kể cả khi tôi *nói dối* rằng `tools.jira.createIssue` có tồn tại và cấm để TODO — nó vẫn không bịa. Đây là thứ tôi tin chắc sẽ hỏng, và nó không hỏng.
2. **Vòng retry feed-diagnostics chạy thật.** Round 1 `invalid` → diagnostic `invalid-flow-contract — No default export found… (01 §1)` → Round 2 `L2` trong **16.3s**, và nó sửa **cả hai** lỗi (kể cả lỗi namespace mà validator còn chưa kịp báo vì L0 fail trước), kèm comment giải thích. Diagnostic viết cho AI đọc — và AI đọc được thật.
3. **Structural edit được tuyên bố rõ ràng, không làm lén.** "…cannot be expressed as a field-level patch" + badge "This edit rewrites the whole file." Đúng tinh thần specs.
4. **Dependency check khi xoá** ra thông điệp gần như hoàn hảo: *"Cannot delete \"Read Text File\": \"Custom Code\" uses `probe.content` — delete or edit that node first (06 §2)."*
5. **Nó hiểu scope.** B2: tôi nói "stop early if the run was already aborted", nó tự tìm ra biến `aborted` đang in-scope và graph mọc thêm đúng 2 data edge.

### Chỗ yếu
1. **Timeout** (BUG-2) — chặn đúng use case quan trọng nhất.
2. **Không kiểm kiểu** (BUG-3) — lời hứa "checked against the flow contract" đang rộng hơn thực tế.
3. **Không persist gì** (BUG-1) — một lần F5 là mất hết; không có "lưu", không có lịch sử.
4. **Chế độ create câm** (BUG-13) — AI có ý kiến hay (từ chối bịa tool) mà không nói ra.
5. **Fallback rewrite tự nới phạm vi** (BUG-5).

### Người dùng thật sẽ vấp ở đâu
1. **Chờ 4 phút rồi nhận "The model did not answer within 240s", prompt vừa gõ biến mất, không có nút thử lại.** Đây gần như chắc chắn là điểm bỏ cuộc số 1.
2. **Không biết mình đang nói chuyện với registry nào** khi đã có hội thoại, và hội thoại không reset khi đổi flow → dễ hỏi nhầm ngữ cảnh.
3. **Gõ một câu cụt** ("do something with a file") và nhận về một diff thay sạch flow 290 dòng, không có lấy một câu hỏi lại. Có diff nên chưa mất dữ liệu, nhưng cảm giác rất mất kiểm soát.
4. **Bấm Apply trên bản fallback rewrite mà không soi hết** → mất một bước không liên quan (BUG-5).
5. **Nhập giá trị sai kiểu và được khen "No issues"** → mang flow hỏng đi chạy.
6. **Đổi example khi AI đang chạy** rồi Apply nhầm kết quả của flow trước (BUG-4).

### 3 việc tôi sẽ làm trước tiên
1. Stream response + nâng/bỏ trần 240s, thêm nút **Retry** giữ nguyên prompt. (BUG-2)
2. Bật type-check trong `validate()` của demo, hoặc **sửa lại lời hứa trên UI**. (BUG-3)
3. Huỷ request khi đổi example; persist hội thoại + source vào `sessionStorage`; sửa Fast-Refresh boundary của `flow/visual.js`. (BUG-4, BUG-1)

---

## 7. Screenshots

| File | Nội dung |
|---|---|
| `A1-simple-diff.png` | A1 — diff đề xuất, badge L2 / 1 round |
| `A2-medium-graph.png` | A2 — graph 12 node sau Apply (loop + continue + if/else) |
| `A3-timeout.png` | A3 lần 1 — "The model did not answer within 240s." |
| `A3-trycatch-retry-applied.png` | A3 lần 2 — try/finally + while retry + 2 early return, 20 node |
| `A4-verycomplex-timeout.png` | A4 — kịch bản khó nhất, timeout lần 2 |
| `A4b-deep-nesting-applied.png` | A4b — 34 node: 3 loop lồng, labelled break/continue, Promise.all, finally |
| `A5-retry-round2.png` | A5c — Round 1 invalid → Round 2 L2, "2 rounds" |
| `B1-minimal-patch.png` | B1 — badge "minimal patch" + range `194:25–194:30` |
| `B4-delete-refused-fallback.png` | B4a — dependency refusal + fallback rewrite |
| `B5-type-mismatch-accepted.png` | B5 — `width: "extra-wide"` được Apply, panel "No issues" |
| `B3-structural-fallback-timeout.png` | B3b — tuyên bố rewrite rồi timeout sau 295s |
| `D3-example-switch-race.png` | D — đổi example khi AI đang chạy, diff sai flow |
| `D4-narrow-800.png` | D — 800px, hội thoại còn nguyên |
