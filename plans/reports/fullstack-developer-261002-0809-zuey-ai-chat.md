# Báo cáo triển khai — Wave B2: Zuey AI chat

- Ngày: 2026-10-02 (Asia/Saigon)
- Nhánh/worktree: `agent-aa3a2c52af310bc53` (gốc `e6fd123`)
- Trạng thái: hoàn thành, đã commit (chưa push)

## Kết quả chính

Zuey AI chat chạy end-to-end: REST + SSE, MCP, OpenAPI, giao diện `/chat`, khối `interactive` trong sandbox và proxy fetch. Đã kiểm tra thật với Dewee gateway trên dev server: câu hỏi đi qua trạng thái "đang nghĩ" → streaming → hoàn tất, quota giảm 300 → 299.

## Tệp đã tạo / sửa

**Tạo mới (thuộc phạm vi sở hữu)**
- `migrations/0008_ai_chat.sql`: `chat_sessions`, `chat_messages`, `ai_usage`, `chat_artifacts`, `admin_access_audit`, `sandbox_rate_limits` + index.
- `src/lib/ai/runtime.ts`: tháng quota theo giờ Sài Gòn, giới hạn tháng (mặc định 300), ước tính chi phí, side effect inject được cho test.
- `src/lib/ai/context.ts`: `retrieveContext(principal, query, locale, deps)` (BM25 trên văn bản đã qua paywall), `buildContextMessage` (envelope `<zuey_context>`/`<source>`/`<question>` đã escape).
- `src/lib/ai/chat-store.ts`, `chat-service.ts`, `admin-chat.ts`, `artifacts.ts`, `sandbox-doc.ts`, `sandbox-proxy.ts`, `mcp.ts`, `openapi.ts`.
- Route: `src/pages/api/v1/chat/{status,export}.ts`, `chat/sessions/index.ts`, `chat/sessions/[id]/{index,messages,stop}.ts`, `chat/artifacts/[id]/attach.ts`, `admin/chat/sessions/{index,[id]}.ts`, `sandbox/fetch.ts`.
- UI: `src/components/ai/{ZueyAiPanel.tsx, InteractiveFrame.tsx, copy.ts, zuey-ai.css}`, `src/pages/chat.astro`.
- Test: `tests/ai-chat.test.ts` (23 test).

**Sửa bổ sung tối thiểu (được phép)**
- `src/lib/blocks/{schema,validate,paywall,markdown,openapi}.ts`: thêm kiểu khối `interactive` (giới hạn 60 KB/trường, 100 KB tổng, chiều cao 120–1200).
- `src/components/blocks/BlockRenderer.tsx`: render `interactive` bằng `InteractiveFrame` (bấm để chạy).
- `src/lib/mcp/registry.ts`, `src/lib/openapi/registry.ts`: đăng ký module.
- `src/env.d.ts`, `.env.example`: `AI_MONTHLY_REQUEST_LIMIT`, `AI_EST_COST_USD_PER_MTOK`, `SANDBOX_FETCH_ALLOWLIST`.

**Lệch phạm vi (cần orchestrator biết)**
- `src/components/studio/ArticleEditor.tsx` nằm ngoài danh sách sở hữu, nhưng `astro check` báo lỗi khi union `Block` có thêm `interactive` (thiếu nhãn và case trong `newBlock`). Tôi chỉ thêm nhãn, case tạo khối mặc định và các ô nhập title/HTML/CSS/JS, không đổi gì khác.

## Hành vi đã triển khai

- **Quyền**: cần entitlement `ai_chat` (gói ai/combo/community) hoặc admin; API key cần scope `chat:write`. Studio admin không có tài khoản thành viên nhận 403 `member_account_required` vì không thể sở hữu phiên chat.
- **Paywall**: retrieval chạy `applyPaywall` dùng chung; bài trả phí mà người hỏi không đọc full được chỉ gửi đoạn preview kèm `access="paid" scope="preview"`. Điểm xếp hạng cũng chỉ dùng phần văn bản được thấy, nên không rò rỉ qua thứ hạng.
- **SSE**: các event `sources`, `delta`, `done`, `error`; keep-alive `: ping` 5 giây. Ngắt kết nối hoặc Esc/Stop sẽ abort → Dewee `chat.abort`. Lệnh stop từ request khác ghi `cancel_requested_at`, luồng đang chạy poll 1,5 giây.
- **Một lượt chạy mỗi phiên**: khoá theo hàng dữ liệu (`run_id`), tự hết hạn sau 4 phút; lượt thứ hai bị 409 `chat_run_in_progress`.
- **Quota**: upsert nguyên tử, vượt giới hạn → 429 `ai_quota_exceeded`. Hoàn lượt nếu gateway không trả nội dung nào. **Admin không bị tính quota.**
- **Thiếu cấu hình Dewee** → 503 `ai_unconfigured`.
- **Admin**: list/stat/search/read bắt buộc có `reason` (5–500 ký tự, qua `?reason=` hoặc `X-Admin-Reason`) và ghi `admin_access_audit` trước khi trả dữ liệu. Attach artifact vào bản nháp kiểm tra revision; khi artifact thuộc thành viên khác thì cũng cần reason và được audit.
- **Sandbox**: `iframe sandbox="allow-scripts"` + srcdoc + CSP meta (`connect-src 'none'`), escape `</script`/`</style`. Có watchdog ready 10 giây / heartbeat 8 giây; mỗi lần chạy tối đa 50 fetch, 4 fetch đồng thời. Proxy chỉ chấp nhận HTTPS GET tới host trong allowlist, cổng 443; chặn IP private/loopback/link-local/CGNAT/IPv6 nội bộ; kiểm tra lại từng redirect (tối đa 3); chỉ trả text/JSON; giới hạn 512 KB và 8 giây; không chuyển tiếp cookie hay auth; rate limit 60/phút cho thành viên, 20/phút theo IP băm cho khách.
- **UI**: có đủ các trạng thái chưa đăng nhập, chưa có quyền, hết quota, chưa cấu hình, đang nghĩ (đếm giây + gợi ý 8–11 giây), streaming với nút dừng, lỗi kèm thử lại. Ngoài ra có danh sách nguồn (gắn nhãn trả phí/preview), danh sách phiên (tạo mới/đổi tên/xoá/xuất JSON) và artifact chạy trong sandbox với nút "mở toàn màn hình".
  - Phím tắt: Enter gửi, Shift+Enter xuống dòng, Esc dừng; có kiểm tra IME `isComposing`.
  - Truy cập: vùng aria-live polite cập nhật theo câu.
  - Chuyển động: chỉ dùng CSS và tôn trọng `prefers-reduced-motion`.

## Kiểm thử

- `bun test`: 171 pass, 0 fail (trong đó `tests/ai-chat.test.ts` có 23 test). Các nhóm kịch bản:
  - Ma trận entitlement và scope.
  - AI-only không nhận full text.
  - Prompt injection nằm yên trong envelope.
  - Cô lập phiên và artifact giữa các thành viên.
  - Một lượt chạy mỗi phiên.
  - Abort và stop lan tới `chat.abort`.
  - Quota 429.
  - Admin bắt buộc reason và có audit.
  - Attach kiểm tra revision.
  - Proxy chặn host lạ, IP private, non-GET, redirect xấu; rate limit.
  - Artifact quá cỡ bị loại.
  - MCP và OpenAPI.
- `bun run build`: 0 errors, 0 warnings, 0 hints.
- Migration local: `bunx wrangler d1 execute zuey_me_db --local --file=./migrations/0008_ai_chat.sql` thành công. State local của worktree này trước đó trống nên tôi cũng áp 0001–0006 ở local để chạy dev.
- Kiểm tra trình duyệt bằng headless Chrome qua CDP, dev server cổng 4332:
  - Ở 320, 768 và 1440, cả khi chưa đăng nhập và khi là thành viên gói ai, `scrollWidth == clientWidth` (không có cuộn ngang).
  - Sửa sau khi kiểm tra: nút "Đăng nhập" bị mất chữ (CSS link ghi đè màu), dấu `/z/` bị xuống dòng ở 320px, danh sách trong câu trả lời bị dính vào đoạn văn và thiếu ký hiệu đầu dòng.
  - Đã dừng dev server sau khi kiểm tra.
  - Thành viên QA chỉ tồn tại trong D1 local (`qa-ai@local.test`), không có trên remote.

## Hạn chế đã biết

- Một vòng lặp vô hạn trong iframe có thể làm treo tab cha nếu trình duyệt chạy frame cùng tiến trình. Watchdog chỉ gỡ được frame khi event loop của trang cha còn chạy.
- Không chống được DNS rebinding trên Workers, vì không resolve DNS trước khi fetch. Rủi ro này được giảm nhờ allowlist host chính xác.
- Retrieval hiện quét tối đa 300 bài mới nhất. Wave B3 sẽ thay bằng FTS5/vector qua kiểu `ContextRetriever` (tham số `retriever` của `startChatTurn`).
- Chi phí ước tính chỉ được tính khi đặt `AI_EST_COST_USD_PER_MTOK`; nếu không đặt thì giá trị là 0.

## Câu hỏi mở

1. Admin có nên bị tính quota (hiện đang được miễn)?
2. Có cần đặt `AI_EST_COST_USD_PER_MTOK` trên production để thống kê chi phí không?
3. Cần chốt danh sách host cho `SANDBOX_FETCH_ALLOWLIST` trên production; khi để trống, proxy trả 503.
4. Cần áp `migrations/0008_ai_chat.sql` lên D1 remote (`wrangler d1 execute zuey_me_db --remote --file=./migrations/0008_ai_chat.sql -y`). Việc này chưa làm vì nằm ngoài phạm vi.
