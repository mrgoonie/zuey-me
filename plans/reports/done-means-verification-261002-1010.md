# Done means — bằng chứng (2026-10-02)

Nguồn: `plans/handoffs/zuey-membership-new-scope-prompt-20261001.md`, mục *Done means*. Bản kiểm tra: `https://zuey-me-aub.pages.dev` (Pages project trong tài khoản sở hữu DNS).

| Mục | Bằng chứng |
|---|---|
| Migration mới, test, OpenAPI + Scalar, MCP cho từng tính năng | Migration `0002`–`0005` (Reads, Articles/Surveys, Workflows, Booking) và `0006`–`0011` cho membership. `/api/openapi.json` production: reads 3 path, workflows 3, booking 8, articles 8. `/api/mcp` production (session admin) liệt kê 80 tool, gồm `reads_*`, `workflow_*`, `booking_*`, `availability_*`, `article_*`, `block_schema`. |
| 2 request đồng thời cùng slot → 1 thành công | `tests/booking.test.ts` — "lets exactly one of two concurrent holds win the same slot" (SQLite thật, unique index). |
| Sync lần hai không đổi → LLM 0 lần | `tests/reads.test.ts` — "second sync with unchanged content does not call the LLM". |
| Draft chứa secret bị chặn publish | `tests/workflows.test.ts` — "blocks publishing drafts with secrets or personal data". |
| Layout 5 cột → 1 cột ở 375px, không cuộn ngang | Render `BlockRenderer` thật + `src/styles/blocks.css`, layout `cols {base:1, md:2, lg:5}`, đo bằng Chromium: 375px → 1 ô/hàng, 768px → 2, 1440px → 5; `overflowX = 0` ở cả ba. |
| Survey 1 phiếu/người | `tests/blocks.test.ts` — "allows one vote per anonymous voter and counts different voters separately". |
| Thiếu credential → lỗi trung thực | `tests/reads.test.ts` (`anymd_unconfigured`, `llm_unconfigured`); `tests/booking.test.ts` ("confirms honestly when Google and Resend are not configured", `payment_unconfigured`); `tests/billing.test.ts` (`billing_unconfigured`); `tests/members.test.ts` (503 khi thiếu email provider); `tests/ai-chat.test.ts` (`ai_unconfigured`). |
| `bun test` / `bun run build` | 307 pass, 0 fail; `astro check` 0 errors, 0 warnings, 0 hints. |
| Browser 320/768/1440 | Chromium headless trên production, 14 route × 3 độ rộng: không cuộn ngang, không lỗi console, mọi route 200 (hoặc redirect `/account` → `/login` khi chưa đăng nhập). Lỗi phát hiện và đã sửa: tab bị cắt chữ ở 320px, thẻ Knowledges thiếu nền, nội dung kẹt opacity 0 khi không có frame, thẻ dưới lệch độ rộng ở 768px. |
| Domain `zuey.me` (2026-10-03) | Đã tắt (không xoá) Single Redirect rule sang Substack trên dashboard. `https://zuey.me` và `www` trả 200 với app; Chromium headless trên `https://zuey.me`, 14 route × 320/768/1440: không cuộn ngang, không lỗi console. Pages project và D1 cũ ở tài khoản NextLevelBuilder đã xoá sau khi verify (backup ở `D:/www/zuey/backups/`); D1 production còn nguyên 56 bảng. |
| Dữ liệu thật (2026-10-03) | Zuey AI: secrets Dewee đã đặt, `/api/v1/chat/status` báo `configured: true`, probe agent `zuey-ai` trả lời. Booking: lịch T2–T6 9:00–11:00 và 13:00–15:00 (Asia/Ho_Chi_Minh), `/api/v1/booking/slots` trả slot 90 phút. Reads: 8 bài AnyMD gắn tag `zuey-reads`, sync `status: success`, 8/8 có tóm tắt (sửa model Workers AI đã bị ngừng). Chromium headless lại 14 route × 320/768/1440 trên `https://zuey.me`: không cuộn ngang, không lỗi console. |
| README chỉ ghi tên secret | `README.md` → *Environment & Secrets*; hướng dẫn từng bước: `docs/env-setup.vi.md`. |

## Ngoài Done means nhưng còn mở

- Telegram (2026-10-03): bot admin ở cả hai group (VN là supergroup, EN là group thường), webhook `chat_member` trỏ về `/api/v1/community/telegram-webhook`, secret sai trả `401`, secret đúng trả `200`.
- Dodo (2026-10-03): 4 product subscription live ($9/$9/$19/$29, USD, không trial), webhook `ep_3KAe…` với 9 sự kiện, Adaptive Currency đã tắt; request không ký trả `401`. Dodo chặn checkout live (`MERCHANT_NOT_LIVE`) vì tài khoản chưa hoàn tất xác minh, nên `DODO_API_KEY` chưa đặt lên production và nút thẻ đang ẩn (`card_plans: []`).
- SePay (2026-10-03): webhook "Zuey.me membership booking" (ACB ****9829, xác thực API Key) đã lưu và đang kích hoạt; request không có key trả `401`.
- PayPal (2026-10-03): app live, webhook `PAYMENT.CAPTURE.COMPLETED` trỏ về `https://zuey.me/api/webhooks/paypal` đã tạo qua REST; ba secret `PAYPAL_*` đã đặt lên production và deploy lại. `/business` hiện cả SePay lẫn PayPal; request không ký trả `401 invalid_signature`.
