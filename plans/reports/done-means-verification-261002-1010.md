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
| README chỉ ghi tên secret | `README.md` → *Environment & Secrets*; hướng dẫn từng bước: `docs/env-setup.vi.md`. |

## Ngoài Done means nhưng còn mở

- `zuey.me` vẫn bị Single Redirect rule của zone chuyển sang Substack; token hiện có không có quyền sửa rule. Domain custom ở trạng thái `pending`.
- Chưa có tài liệu AnyMD nào gắn tag `zuey-reads`; chưa có lịch rảnh cho booking; webhook SePay, key Dodo/PayPal, Telegram và token Dewee phạm vi hẹp chờ chủ sở hữu cung cấp.
