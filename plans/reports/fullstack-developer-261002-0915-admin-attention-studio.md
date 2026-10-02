# Báo cáo: hàng đợi thanh toán cần xử lý, admin thành viên vào Studio, nhãn OAuth

Ngày: 2026-10-02 · Nhánh: `claude/zuey-membership-implementation-ev50kx` (worktree, chưa push)
Commit: `9ec3ded` (fix OAuth), `ec53350` (hàng đợi + Studio)

## Kết quả

Đã làm đủ cả ba hạng mục. `bun test` cho 245 pass, 0 fail. `bun run build` cho 0 lỗi, 0 cảnh báo, 0 hint.

## 1. Hàng đợi thanh toán cần xử lý

- `src/lib/members/billing-attention.ts` (mới) chứa `listBillingAttention`, `resolveBillingOrder`, `parseResolveInput` và `adminLabel`.
- REST `GET /api/v1/admin/billing/attention` (chỉ admin) trả về `orders` (SePay), `card_subscriptions` (Dodo) và `card_note`. Mỗi loại tối đa 200 dòng, dòng cũ nhất lên trước.
- REST `POST /api/v1/admin/billing/orders/{code}/resolve` nhận body `{action: 'activate'|'dismiss', note?: string}`, note tối đa 500 ký tự.
  - `activate`: một câu UPDATE có điều kiện chuyển đơn sang `paid` với `paid_at = now`, sau đó gọi `fulfilOrder` (đã export từ `billing.ts`). Hàm này tính lại kỳ hạn qua `recomputeSubscription`, ghi log `billing.paid` và gửi email biên nhận. Logic tính kỳ hạn không bị sao chép.
  - `dismiss`: chuyển sang `expired` và giữ nguyên `attention_reason`. Không cần migration, vì CHECK constraint chỉ cho các giá trị pending/paid/expired/needs_attention. Quy ước được dùng: đơn ở trạng thái "expired mà vẫn có attention_reason" nghĩa là admin đã bỏ qua. Đơn hết hạn bình thường luôn có `attention_reason` là NULL nên không bị nhầm.
  - Gọi lại cùng một hành động không thay đổi gì và trả `already_activated` / `already_dismissed`. Đơn đã dismiss vẫn activate lại được. Dismiss đơn đã paid, hoặc resolve đơn pending/expired thường, đều trả 409 `not_in_attention`. Câu UPDATE có điều kiện chặn race giữa hai admin.
  - Mỗi lần resolve ghi `user_activity` với action `billing.attention_resolved` cho member, gồm code, action, reason, note và admin (email của admin; nếu không có thì ghi `studio_session`/`admin_api_key`).
- Thẻ Dodo chỉ được liệt kê để xem. Khi một dòng bị gắn cờ, trạng thái thật (status, kỳ hạn, số tiền) do Dodo giữ và không còn lưu cục bộ. Cấp hay đóng quyền từ dữ liệu này có thể mâu thuẫn với nhà cung cấp. Lý do này được trả trong `card_note` và hiển thị trên UI.
- MCP: thêm `billing_attention_list` và `billing_order_resolve` vào `membersMcpModule`, đánh dấu ADMIN trong `tool-access.ts`. OpenAPI có thêm hai path và schema `BillingAttentionQueue` trong `src/lib/members/openapi.ts`.
- UI: tab "Payments" trong Studio dùng `src/components/studio/BillingAttentionPanel.tsx`.
  - Hộp xác nhận dùng `<dialog>`: focus mặc định ở nút Cancel, Esc để đóng, đóng xong focus trả về nút đã bấm.
  - Nút của dòng bị khóa ngay khi gửi, và chỉ mở lại nếu request lỗi.
  - Kết quả hiện qua `role="status"` với `aria-live`.
  - Ô ghi chú có label ẩn (sr-only) và có focus ring khi điều hướng bằng bàn phím.
  - Layout co giãn: dưới 640px các phần xếp dọc, từ 640px lưới 2 cột, từ 1024px lưới 4 cột.

## 2. Admin thành viên vào /studio

- `src/lib/members/studio-access.ts` (mới) chứa `resolveStudioAccess`. Hàm dùng `resolvePrincipal` và `can(p, 'admin')`, và chỉ chấp nhận phiên trình duyệt `studio_session` hoặc `member_session`. API key gửi qua header không mở được trang.
- `src/pages/studio/index.astro` dùng hàm trên. Đường đăng nhập cũ (GitHub/Google/token) giữ nguyên.
- Các API admin mà Studio gọi đã dùng sẵn `authenticateRequest`/`authenticateAdmin`/`resolvePrincipal`, nên đã chấp nhận phiên member admin. Phương thức không an toàn vẫn phải cùng origin (CSRF). Có test cho cả `/api/v1/admin/members` và API mới.
- Trên StudioApp:
  - Màn đăng nhập có thêm link "Sign in with your member account" trỏ tới `/login?next=/studio`.
  - Member không phải admin thấy thông báo "Signed in as …, not an administrator".
  - Member admin đăng xuất qua `/api/members/auth/logout`.

## 3. Nhãn principal của OAuth

- Union `CredentialVia` giờ được sinh từ hằng `CREDENTIAL_VIAS`, có thêm `oauth_token`. `src/lib/oauth/caller.ts` gán `via: 'oauth_token'`.
- OpenAPI `Member.auth.via` dùng enum từ cùng hằng. CLI `whoami` in `auth.via` nên không phải sửa.
- Không chỗ nào khác phụ thuộc vào giá trị `user_api_key` của OAuth: `can()` chỉ kiểm tra `member_session`.

## Tests

- `tests/billing-attention.test.ts` (mới, 8 test) kiểm tra:
  - 401/403/200 cho anon, member, read key, member admin và admin key.
  - Danh sách có reason, số tiền, email, và dòng thẻ chỉ đọc.
  - Activate cấp quyền một lần: lần hai trả idempotent, không gửi thêm email, kỳ hạn không đổi, có log audit.
  - Dismiss không cấp quyền, gọi lại vẫn idempotent, sau đó activate lại được.
  - Validate input, 404, 409, chặn CSRF.
  - Công cụ MCP và việc đăng ký tool-access/OpenAPI.
  - Quyền vào Studio: owner, member admin, member thường, email allowlist chưa xác minh, admin key qua header.
- `tests/oauth-mcp.test.ts`: `me_get` qua OAuth trả `auth.via = 'oauth_token'`.
- `tests/members.test.ts`: cập nhật danh sách tool và path đã đăng ký.

## Sai lệch so với danh sách file được phép

- `src/lib/oauth/caller.ts` không có trong danh sách, nhưng đây là nơi duy nhất tạo principal OAuth. Tôi sửa đúng một dòng, vì hạng mục 3 không làm được nếu không sửa file này.

## Vấn đề cần chú ý (ngoài phạm vi, chưa sửa)

- **Lỗ hổng leo thang quyền có từ trước:** `src/pages/api/v1/keys/index.ts` (cũng như `links/*`, `profile.ts`, `theme.ts`) chỉ gọi `authenticateRequest`, nên API key `read` vẫn được ghi. Riêng `POST /api/v1/keys` cho phép một read key tạo **admin key**. Điều này vi phạm quy tắc "read-only API keys must never mutate" trong AGENTS.md. Các file này nằm ngoài quyền sở hữu của tôi. Cách sửa đề xuất: chuyển các handler ghi sang `authenticateAdmin`.
- Đơn đã `paid` mà nhận thêm tiền chuyển trùng (`attention_reason = 'duplicate_payment'`) không có trong hàng đợi, vì task chỉ yêu cầu `status = 'needs_attention'` và việc hoàn tiền phải làm thủ công.

## Câu hỏi còn mở

- Có muốn thêm cột `resolved_at`/`resolved_by`/`admin_note` cho `billing_orders` qua migration 0012 không? Hiện thông tin này chỉ nằm trong `user_activity`.
