# CodeFlow — E2E Browser Test Report (Phase 7)

**Ngày chạy:** 2026-08-23, ~03:50–04:17 (giờ local)
**App:** `apps/demo` tại http://localhost:5173
**Agent:** Sonnet subagent, điều khiển browser thật
**Môi trường browser:** FALLBACK sang `chrome-devtools` MCP — `claude-in-chrome` yêu cầu chọn 1 trong 3 browser đang kết nối qua hộp thoại tương tác, subagent không có cơ chế hỏi người dùng (user đang ngủ). Toàn bộ checklist vẫn chạy trên Chrome thật với đầy đủ evidence.

## ✅ Bổ sung: re-verify qua ĐÚNG Claude in Chrome extension (2026-08-23, browser "lucas")

Sau khi user thức và chọn browser, các flow trọng yếu đã được chạy lại qua chính extension Claude in Chrome (không phải chrome-devtools) — **tất cả PASS**, screenshots ở `e2e/claude-in-chrome/`:

| Flow | Kết quả qua Claude in Chrome | Evidence |
|---|---|---|
| Load + render canonical | 7 nodes · 11 edges · 0 diagnostics | — |
| Sync canvas → Monaco | Chọn Slack Send → Monaco highlight đúng lines 14–17, inspector hiện `flow.ts:14:7` | — |
| **Acceptance 08 §4** | Preview diff `line 15:18–15:29` đúng 1 patch (`-"#security"` / `+"#engineering"`) → Apply → header `patched: 1 range(s) · line 15 · v3`, Monaco chỉ đổi dòng 15, message template nguyên vẹn, 7 nodes/11 edges giữ nguyên, badge UPDATED | `01-acceptance-applied.jpg` |
| Delete bị chặn | 2 bước (Delete → Confirm) → `patch-dependency: Cannot delete "Get PR Files": "Is Auth Change" uses 'files' — delete or edit that node first (06 §2)`, source không đổi | `02-delete-blocked.jpg` |
| Degradation | unknown node đỏ + badge "unresolved", code node sọc chéo, while loop lồng code node; DiagnosticsPanel: 1 error + 1 warning + 2 info gồm `unresolved-tool`, `hidden-call-in-expression` (kèm hướng dẫn hoist ra `const`), `unsupported-construct` ×2 | `03-degradation.jpg` |
| Console | 0 error / 0 exception | — |

Ghi nhận vận hành: click node trên React Flow canvas cần screenshot ngay trước khi click (canvas auto-fit/resize làm tọa độ đổi); click theo `ref` từ `find` không kích hoạt selection của React Flow — click theo tọa độ thì được.

## Kết quả — 12/12 PASS

| # | Mục | Kết quả |
|---|-----|---------|
| 1 | Load app: 7 nodes canonical, không console error | ✅ PASS |
| 2 | Sync 2 chiều canvas ↔ Monaco (click ↔ cursor) | ✅ PASS (1 quan sát nhỏ) |
| 3 | **Acceptance flow 08 §4** (đổi channel → preview diff 1 patch → apply → 1 dòng đổi, 7 nodes giữ nguyên, badge UPDATED) | ✅ PASS |
| 4 | Palette insert + needs-configuration → điền field → badge biến mất | ✅ PASS |
| 5 | Delete bị chặn: message nêu đúng node phụ thuộc (`patch-dependency`), source không đổi | ✅ PASS |
| 6 | Delete hợp lệ → code trở về như trước | ✅ PASS |
| 7 | Đổi tool → warnings `tool-replace-reconfigure` + needs-configuration | ✅ PASS |
| 8 | Loop variable field disabled kèm lý do structural-edit (07 §5: không fail âm thầm) | ✅ PASS |
| 9 | Conflict flow: sửa tay trong Monaco → Apply → `patch-conflict` → Re-analyze → apply lại OK | ✅ PASS |
| 10 | Degradation: unknown node đỏ/dashed, code node sọc, DiagnosticsPanel đủ 4 diagnostics, click → focus node | ✅ PASS |
| 11 | Disclosure 3 mức + dark/light toggle | ✅ PASS |
| 12 | Console: 0 uncaught error toàn phiên | ✅ PASS |

**Kết luận: không có bug chức năng chặn release.**

## Ghi nhận phụ (backlog, không block)

1. **Cursor ở cột 1** (whitespace đầu dòng trong block) chọn container cha thay vì statement trên dòng — edge case UX nhỏ. Tái hiện: Home ở đầu dòng statement con trong loop/if.
2. **A11y**: các input trong NodeInspector thiếu `id`/`name` attribute (DevTools issue "A form field element should have an id or name attribute") — ảnh hưởng a11y/autofill/testability, không ảnh hưởng chức năng.

## Bằng chứng chi tiết (rút gọn)

- **#3 Acceptance**: preview diff hiện đúng 1 patch line 15 (`- "#security"` / `+ "#engineering"`); apply xong Monaco chỉ đổi dòng 15, graph vẫn 7 nodes/11 edges. (`04-channel-preview-diff.png`, `05-channel-applied.png`)
- **#5 Delete blocked**: "patch-dependency: Cannot delete 'Get PR Files': 'Is Auth Change' uses `files` — delete or edit that node first (06 §2)." (`13-delete-blocked.png`)
- **#9 Conflict**: sửa tay `"#security"`→`"#hand-edited"` → inspector cảnh báo "editor holds source this graph was not built from"; Apply → "This node changed since the workflow was loaded — reload the workflow before editing (06 §5)"; Re-analyze → apply lại thành công. (`21`–`23`)
- **#10 Degradation**: `github.getAuditLog` viền đỏ + badge "unresolved"; diagnostics `unresolved-tool`, `unsupported-construct`×2, `hidden-call-in-expression` đủ; click diagnostic → focus node + Monaco + inspector. (`24`, `25`)

Screenshots đầy đủ (31 file): `e2e/screenshots/` (giữ ngoài git vì 19MB).

## Ghi chú kỹ thuật cho lần e2e sau

- Click node React Flow qua accessibility uid flaky (canvas transform) — click text bên trong node ổn hơn; sync CodePanel→canvas cần dispatch mouse events lên `.view-line` của Monaco.
- Các control đã có `data-testid` (inspector/palette/apply/delete/tool/code) — harness sau nên target chúng.
