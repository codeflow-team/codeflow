# 09 — Future

## 1. Quan hệ với sandbox runtime

CodeFlow output là source + graph. Execution giao cho hệ thống khác:

```text
CodeFlow (convert + edit)
   │
   ├── V8 isolate + bindings (mô hình Cloudflare Code Mode)
   ├── Temporal / Inngest / Trigger.dev / BullMQ
   └── Custom runtime
```

Điểm khớp đã chuẩn bị sẵn từ MVP: interface `Tools` do registry sinh ra ([05-registry.md](05-registry.md) §2) chính là contract binding — runtime chỉ cần inject object `tools` thỏa interface đó vào sandbox (isolate không có network access chung, API key giấu sau binding). Khi build runtime, không cần đổi gì trong core model.

Runtime mở ra các tính năng graph-aware:

- **execution tracing / visual debugging** — runtime báo "đang chạy statement nào" → CodeFlow map ngược qua source mapping → highlight node đang chạy, hiện data chảy trên edge;
- **step-through / replay** trên graph;
- **run history** per node.

Đây là lý do source mapping chính xác quan trọng ngay từ MVP: nó không chỉ phục vụ edit, mà phục vụ cả observability sau này.

## 2. Mở rộng analyzer (có chủ đích, từng bước)

(`try/catch`, early `return`/`continue`/`break`, `while` có bound — đã chuyển vào MVP scope, [04-analyzer.md](04-analyzer.md) §2.7–2.9.)

Theo thứ tự giá trị/độ khó:

1. smart projection — gộp `filter().map().sort()` thành node "Transform" (hoãn từ v0.1: cần cơ chế mapping vùng-nhiều-statement và editable fields cho node gộp);
2. error-handling dạng port — chiếu `try/catch` bọc một tool call đơn lẻ thành "error output port" ngay trên tool node (kiểu n8n) thay vì try node bọc ngoài — sugar trên nền try node 1:1 của MVP;
3. `Promise.allSettled` / race; `switch`;
4. multi-file flows — import helper/subflow từ file khác;
5. JavaScript (không type → tool resolution theo heuristic + registry name).

Mỗi construct thêm vào phải kèm: quy tắc analyzer + quy tắc patcher + identity tests + round-trip tests. Không thêm construct "chỉ để hiển thị".

## 3. Structural editing

Phần khó nhất, làm sau khi vòng MVP đã có user thật:

- di chuyển node vào/ra `if` / `for`;
- đổi thứ tự node (với kiểm tra data dependency);
- wrap selection thành condition/loop;
- extract selection thành named function (custom code node).

## 4. Workflow-first creation

MVP là code-first (AI viết code trước). Sau này có thể hỗ trợ chiều "user kéo node tạo flow mới từ canvas trắng" — bản chất là **generate flow code theo contract từ graph thao tác** rồi lập tức quay về mô hình chuẩn (code là truth). Không được biến thành chế độ "graph là truth" song song.

## 5. AI trong vòng lặp

- AI-assisted node editing — user mô tả thay đổi bằng ngôn ngữ tự nhiên trên một node, AI sinh patch (qua đúng patch engine, không regenerate);
- AI generate flow từ intent + registry context (typed Tools API trong prompt);
- semantic diff/review — "flow này đổi gì so với hôm qua" hiển thị bằng graph diff thay vì text diff.

## 6. Khác

- reusable subflows / nested workflows;
- Git-aware source mapping (identity qua commits);
- visual diff giữa workflow versions;
- collaborative editing (nhiều user cùng xem/sửa — cần lift giả định single-editor của conflict detection);
- thêm ngôn ngữ khác (Python là ứng viên đầu — cùng vị thế "AI viết giỏi").

## 7. Ràng buộc kiến trúc vĩnh viễn

Nhắc lại để chống drift: CodeFlow **không bao giờ** trở thành workflow language thứ hai.

```text
❌ Workflow JSON → Custom Runtime → Generated Code
✅ TypeScript Code → Semantic Graph → Visual Projection
```

Graph tồn tại để hiểu và chỉnh sửa code, không thay thế code.
