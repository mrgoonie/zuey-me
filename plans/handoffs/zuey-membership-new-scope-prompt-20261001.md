# Prompt triển khai: membership + 4 yêu cầu bổ sung

Triển khai sản phẩm membership của zuey.me, gồm cả 4 yêu cầu bổ sung đã chốt, trên stack hiện tại (Astro SSR + React + Cloudflare Pages + D1). Trả lời bằng tiếng Việt.

## Bắt đầu

1. `git fetch origin && git checkout claude/zuey-membership-implementation-ev50kx && git pull`. Nhánh này đã merge nhánh `codex/zuey-membership-implementation-handoff`.
2. Đọc trước khi làm, theo thứ tự:
   - `README.md`, `AGENTS.md`: bun, edge chỉ dùng Web APIs, không `any`/cast, không sửa migration đã apply, Definition of Done.
   - `plans/handoffs/zuey-membership-implementation-20261001-1730.md`: spec gốc đầy đủ, nguồn sự thật cho phạm vi, giá và ràng buộc.
   - `plans/visuals/explain-zuey-membership.html`: preview tương tác. Các section mới là `#nx-booking`, `#zuey-reads`, `#ai-workflows`, `#rich-blocks`, `#advice-new-scope`. Preview là yêu cầu và bằng chứng, KHÔNG phải code đã chạy thật.
3. Đối chiếu mục "Current state" của handoff với repo thực tế trước khi hành động.

## 4 yêu cầu bổ sung (user đã xác nhận)

### 1. Booking Zuey for Business (tư vấn $1,999)

- Availability tự quản trong D1. Admin khai báo quy tắc theo weekday, giờ, thời lượng và ngày nghỉ trong Studio. Không dùng Cal.com/Calendly.
- Khách xem calendar theo timezone của mình và chọn slot. Slot được giữ 15 phút (hold) trong lúc checkout qua Polar hoặc SePay.
- CHỈ webhook đã verify và đủ số tiền mới chuyển sang confirmed. Khi đó tạo Google Meet qua Google Calendar API và gửi email Resend (hi@zuey.me) kèm `.ics`.
- Khách được tự đổi lịch 1 lần, trước giờ họp ít nhất 48h. Hủy và hoàn tiền do admin xử lý tay.
- Chống double-book bằng partial unique index trên `slot_start` cho trạng thái held/confirmed. Hold hết hạn xử lý lazy khi đọc. Webhook idempotent theo `booking_id`. Thanh toán đến sau khi hold đã hết hạn thì chuyển sang `needs_attention`.

### 2. Zuey Reads

- Sync `GET anymd.cc/api/v1/library` (Bearer `ANYMD_API_KEY`, scope `library:read`, phân trang bằng `before`/`next_cursor`). Chỉ lấy mục có tag `zuey-reads`.
- Tóm tắt 2–3 câu bằng LLM lúc sync, cache trong D1 theo `content_hash` (nội dung không đổi thì không gọi LLM). Bỏ tag thì `visible=0`.
- Trang `/reads` (danh sách tóm tắt, tìm kiếm, lọc theo nguồn) và `/reads.md`, kèm REST/OpenAPI. Người xem không bao giờ gọi AnyMD trực tiếp.

### 3. Zuey's AI Workflow

- Schema riêng: name, slug, summary, tools[], trigger, steps[], metrics, tags, status draft|published, revision.
- MCP tools `workflow_list/get/create/update/delete/publish`. Create và update CHỈ ghi draft và cần `expected_revision`. Publish là bước riêng, có xác nhận.
- Server quét secret (token dạng `sk-`/`ghp_`, path `/Users/…`, email) và chặn publish khi phát hiện.
- REST `/api/v1/workflows`, trang `/workflows` (gallery và trang chi tiết) cùng bản `.md`.
- Ship skill local trong `skills/zuey-me/`. AI trên máy dùng skill này để đọc session log (Claude Code `~/.claude/projects`, Codex `~/.codex/sessions`), rút ra các workflow lặp lại, che path/tên/secret, cho Zuey xem diff rồi mới gọi MCP. Không bao giờ upload raw session.
- Giai đoạn đầu dùng admin key của `/api/mcp` hiện có. Chuyển sang scope `workflows:write` khi `/mcp` OAuth xong.

### 4. Rich blocks và layouts trong block schema chung

Editor, renderer, Markdown, REST và MCP dùng cùng một schema.

- chart: dữ liệu khai báo `{kind, labels, series}`, không chạy code.
- diagram: lưu source Mermaid. Markdown fallback là code fence.
- survey: lưu D1, unique `(block_id, voter_key)` với voter_key là user_id hoặc hash của cookie ẩn danh. Rate limit theo IP hash. Sau khi vote thì hiện % tổng hợp. Admin xem và export CSV.
- layout container: variant columns|grid|bento. `cols` theo breakpoint `{base, md, lg}` trong khoảng 1–5. Children có `span`/`rowSpan`. Validate ở server, lồng tối đa 2 cấp.
- Thư viện chart/Mermaid chỉ được dynamic import trong client island, không đưa vào SSR/edge bundle.

## Thứ tự

Gộp vào MỘT plan tổng cùng toàn bộ handoff, đặt trong `plans/`. Plan phải map từng mục tới file, migration, schema API/MCP/CLI và test:

- Zuey Reads làm sớm vì độc lập.
- Rich blocks/layouts làm cùng phase block editor.
- Workflow làm cùng phase MCP/REST.
- Booking làm cùng phase payments.

Không cắt hay hoãn mục nào user đã yêu cầu.

## Quyết định còn mở

Hỏi user trước khi làm phần liên quan. Các phần độc lập vẫn làm tiếp.

1. Provider LLM để tóm tắt Reads. Đề xuất: Cloudflare Workers AI.
2. Cách tạo Google Meet. Đề xuất: OAuth refresh token cho lịch của Zuey. Phương án khác: service account + Workspace delegation.
3. Cloudflare Pages không có cron trigger. Đề xuất: GitHub Actions schedule gọi `POST /api/v1/reads/sync` bằng admin key. Phương án khác: một Worker riêng có cron.

## Chưa kiểm chứng, cần xác minh khi làm

- `GET /library` của AnyMD có trả tags và lọc được theo tag không. Docs chỉ ghi filter domain/kind. Nếu không lọc được thì phân trang toàn bộ rồi lọc phía mình, hoặc dùng `/search`, và báo lại user.
- Polar/SePay có giữ metadata `booking_id` trong checkout không.
- Đường dẫn và format thực tế của session log trên máy Zuey.

## Done means

- Mỗi tính năng có migration mới (`0002_*` trở đi, không sửa `0001`), có test, có endpoint trong `src/pages/api/openapi.json.ts` và Scalar `/docs`, có MCP tool tương ứng.
- Hai request đồng thời đặt cùng một slot thì đúng 1 request thành công.
- Sync lần hai khi nội dung không đổi gọi LLM 0 lần.
- Draft chứa secret bị chặn publish.
- Layout 5 cột hiển thị thành 1 cột ở 375px, không cuộn ngang.
- Survey nhận 1 phiếu/người.
- Thiếu credential (ANYMD_API_KEY, Google, Polar/SePay, Resend) thì báo lỗi trung thực, không giả thành công.
- `bun test` 0 fail. `bun run build` 0 lỗi, 0 warning. Đã kiểm tra trực tiếp trên browser ở 320/768/1440.
- README cập nhật các secret mới, chỉ ghi tên biến, không ghi giá trị.

## Ngoài phạm vi

Cal.com/Calendly, hiển thị toàn bộ library AnyMD, tự publish workflow, upload raw session, tự hoàn tiền, deploy production, chạy migration remote, giao dịch thật.

## Ràng buộc

- Secrets chỉ đặt trong env hoặc secret storage, không commit `.env`.
- Giữ nguyên giá và scope của handoff.
- Mọi kiểm tra quyền thực hiện ở server.
- Commit theo conventional commits, không nhắc tới AI.
- Push lên nhánh `claude/zuey-membership-implementation-ev50kx`. Không tạo PR nếu user chưa yêu cầu.

## Chỉ dừng lại hỏi khi

- Cần chạy migration remote, deploy hoặc giao dịch thanh toán thật.
- AnyMD không lọc được theo tag và phải đổi cơ chế.
- Gặp một trong 3 quyết định còn mở mà chưa có câu trả lời.
- Gặp lỗi không giải thích được.

Mọi việc khác tự quyết và làm tiếp đến hết.
