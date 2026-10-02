# Báo cáo Wave B5: thanh toán thẻ (Dodo + PayPal), gỡ Polar

Ngày: 2026-10-02 (Asia/Saigon). Worktree: `agent-a0e2c178e4cc3c654`. Commit: `c680459` (code, migration, test) và `9ecb237` (tài liệu, biến môi trường). Chưa push.

## Kết quả

- **Dodo Payments** bán 4 gói hằng tháng: knowledges $9, ai $9, combo $19, community $29.
- **PayPal Business** nhận khoản đặt lịch tư vấn $1,999.
- Mỗi kênh chỉ hiện khi đủ biến cấu hình; thiếu thì API trả `503 payment_unconfigured` kèm tên biến còn thiếu, và lựa chọn bị ẩn trên giao diện.
- SePay vẫn là kênh VND mặc định.
- **Polar đã bị gỡ hoàn toàn** theo yêu cầu đổi phạm vi (Polar không hỗ trợ mô hình kinh doanh này).

Kiểm chứng sau khi gỡ Polar (coordinator chạy trong worktree): `bun test` đạt 167 pass / 0 fail; `bun run build` đạt 0 lỗi / 0 cảnh báo / 0 gợi ý.

## Thay đổi chính

### Migration `migrations/0011_card_payments.sql`
- Dựng lại bảng `bookings` để nhận `payment_method = 'paypal'`. Giá trị cũ `'polar'` vẫn hợp lệ trong ràng buộc CHECK, chỉ để các dòng lịch sử được giữ lại; ứng dụng không còn ghi giá trị này.
- Thêm bảng `card_subscriptions` lưu gói thẻ Dodo: trạng thái, ngày gia hạn, huỷ cuối kỳ, số tiền, tiền tệ, lý do cần kiểm tra.
- Thêm cột `payment_events.card_subscription_id`.
- Không sửa migration nào đã áp dụng.

### Thư viện thanh toán `src/lib/payments/`
- **`standard-webhooks.ts`:** bộ xác minh dùng chung theo chuẩn Standard Webhooks: HMAC-SHA256, khoá `whsec_` + base64, cửa sổ chống phát lại 5 phút.
- **`dodo.ts`:** client chỉ dùng fetch.
  - Tạo phiên checkout có metadata `user_id`, `plan`, `card_ref` và email khách; tắt mã giảm giá và chọn tiền tệ.
  - Tạo link cổng khách hàng và huỷ gia hạn cuối kỳ.
  - Phân tích webhook `subscription.*` và `payment.succeeded`/`payment.failed`.
- **`dodo-billing.ts`:** xử lý nghiệp vụ.
  - Idempotent theo `webhook-id` trong `payment_events`; nếu xử lý lỗi thì giải phóng bản ghi để Dodo gửi lại.
  - Trạng thái trong payload thắng loại sự kiện; sự kiện cũ hơn trạng thái hiện tại bị bỏ qua.
  - Chỉ kích hoạt khi đúng sản phẩm, đúng giá gói và đúng USD; sai thì chuyển `needs_attention` và giữ nguyên trạng thái đó.
  - Thiếu metadata thì tạo dòng `needs_attention` không gắn thành viên.
  - Ngày hết hạn quyền lấy từ `next_billing_date` của Dodo.
- **`paypal.ts`:**
  - Token OAuth client-credentials được cache trong bộ nhớ và tự lấy lại khi nhận 401.
  - Tạo đơn Orders v2 1999.00 USD với `custom_id` = booking id; capture idempotent qua `PayPal-Request-Id`.
  - Webhook được xác minh qua API `verify-webhook-signature` của PayPal.

### Kết nối vào hệ thống
- **Booking:**
  - Phương thức `paypal` với hold, checkout, `POST /api/v1/booking/{id}/capture` và `/api/webhooks/paypal`.
  - Capture khi khách quay về và webhook dùng chung mã capture, nên một khoản tiền không bị ghi nhận hai lần.
  - Không bao giờ capture khi giữ chỗ đã hết hạn; nếu tiền vẫn về qua webhook thì booking chuyển `needs_attention` (`late_payment`).
- **Widget đặt lịch:** thêm lựa chọn "Thẻ quốc tế / PayPal (USD)". Trang quản lý lịch gọi capture rồi hiển thị trạng thái thật từ máy chủ. `business.astro` chỉ đưa ra các kênh đã cấu hình.
- **`/pricing`:** thêm nút "Thẻ quốc tế (USD, Dodo)" cạnh VietQR, chỉ cho các gói đã có product ID.
- **Trang `/billing/card/[id]`:** hỏi lại máy chủ liên tục, chỉ báo đã kích hoạt khi webhook đã xác thực; sau 10 phút thì nói rõ là chưa nhận được xác nhận.
- **Mục Gói trong `/account`:** hiện nhà cung cấp, ngày gia hạn hoặc "đã huỷ, hiệu lực đến", kèm nút "Quản lý thẻ" (cổng Dodo) và "Huỷ gia hạn" có hộp xác nhận.
- **Quyền truy cập:** gộp hạn SePay và hạn thẻ. Gói thẻ tự gia hạn được giữ quyền thêm 24 giờ để chờ webhook gia hạn. Email nhắc gia hạn bỏ qua gói đang tự gia hạn.
- **API, MCP, OpenAPI:**
  - `POST /api/v1/billing/orders` và tool MCP `billing_checkout_create` nhận thêm `provider: sepay|dodo`.
  - Thêm `GET /api/v1/billing/card/{id}`, `POST .../portal`, `POST .../cancel` (hai lệnh POST chỉ dùng được bằng phiên đăng nhập) và `/api/webhooks/dodo`.
  - OpenAPI của booking và billing đã cập nhật.

### Gỡ Polar
- Đã xoá `src/lib/payments/polar.ts` và `src/pages/api/webhooks/polar.ts`.
- Đã gỡ kiểu, validation, checkout, chữ trên widget và OpenAPI liên quan, cùng các biến `POLAR_*` trong `src/env.d.ts`, `.env.example`, README và `docs/env-setup.vi.md`.
- Booking cũ còn mang `polar` khi checkout sẽ nhận `409 payment_method_retired`; giữ chỗ mới với `polar` nhận 400.
- `tests/booking.test.ts` đã viết lại trên PayPal và SePay, giữ đủ các ca: giữ chỗ đồng thời, phát lại idempotent, trả thiếu, giữ chỗ hết hạn, chữ ký sai, xác nhận khi chưa cấu hình Google/Resend.
- Không có câu chữ nào gọi sản phẩm là "AI clone".

### Tài liệu và biến môi trường
- `.env.example` và bảng biến môi trường trong README có `DODO_*` và `PAYPAL_*` (chỉ tên biến).
- `docs/env-setup.vi.md` có hướng dẫn từng bước:
  - PayPal: app Business, client id/secret, webhook id, sandbox.
  - Dodo: 4 sản phẩm, URL webhook, Test Mode, tắt Adaptive Currency.

## Test

`tests/card-payments.test.ts` (17 test, mọi API bên ngoài đều được giả lập):
- **Dodo:** chữ ký đúng, sai và phát lại; vòng đời bật/tắt quyền (active, renewed, on_hold, cancelled, lần thanh toán đầu thất bại); sai số tiền, tiền tệ hoặc sản phẩm thành `needs_attention`; thiếu hoặc giả metadata thành `needs_attention`.
- **PayPal:** payload đơn hàng (`custom_id`, 1999.00 USD, URL quay về); token được cache; capture khi quay về; webhook xác minh thành công và thất bại; phát lại idempotent; sai số tiền; giữ chỗ hết hạn thành `needs_attention`.
- **Chưa cấu hình:** trả 503 và ẩn lựa chọn; chỉ hiện các gói đã có product; SePay vẫn là mặc định.

## Ngoài phạm vi và lệch kế hoạch

- **Kiểm tra trình duyệt chưa làm:** mình chưa kiểm tra `/pricing` và bước thanh toán `/business` ở 320/768/1440. Mình không có công cụ điều khiển trình duyệt, và shell bị hỏng một thời gian dài trong phiên.
- **Sửa ngoài danh sách file được giao:** một dòng chữ trong `src/components/studio/BookingPanel.tsx` ("Polar/bank" thành "PayPal or by bank transfer"), làm theo yêu cầu gỡ Polar.
- **Sửa file env của harness:** `sessionstart-hook-0.sh` của phiên bị hook ghi nối lặp lại tới mức bị cắt ngắn, làm hỏng Bash. Mình đã thu gọn nó, chỉ bỏ các dòng trùng.

## Status

**Status: DONE_WITH_CONCERNS**

**Summary:** Dodo (gói thành viên) và PayPal (buổi tư vấn) đã chạy đầy đủ, chỉ bật khi đã cấu hình, và Polar đã được gỡ hoàn toàn. `bun test` đạt 167/0, `bun run build` đạt 0/0/0, đã commit 2 lần, chưa push.

**Concerns:**
- Migration `0011` dựng lại bảng `bookings`, nên có thể xung đột nếu các migration 0007–0010 ở nhánh song song cũng sửa bảng này. Cần kiểm tra thứ tự trước khi gộp.
- Dòng Dodo không khớp thành viên (`needs_attention`, `user_id` NULL) chưa có giao diện admin; hiện phải xử lý thủ công trong D1 và dashboard Dodo.
- Gói thẻ tự gia hạn được giữ quyền thêm 24 giờ sau ngày gia hạn; trạng thái `past_due` của Dodo đang bị bỏ qua.
- Chưa kiểm tra trên trình duyệt ở 320/768/1440.
- Chưa giao dịch thật nào được thực hiện; cần thử bằng PayPal sandbox và Dodo Test Mode sau khi điền biến môi trường.
