# Báo cáo triển khai: Wave A — nền tảng thành viên (membership foundation)

- Nhánh: `claude/zuey-membership-implementation-ev50kx` (chưa push)
- Trạng thái: **hoàn thành, còn một số lưu ý** (xem mục "Rủi ro và việc còn lại")
- Kiểm chứng:
  - `bun test`: 126 pass, 0 fail (7 file).
  - `bun run build`: `astro check` cho 0 errors, 0 warnings và 0 hints; build thành công.

## Kết quả chính

Zuey giờ đã có tài khoản thành viên đầy đủ:

- **Đăng nhập** bằng magic link (Resend), Google hoặc GitHub.
- **Phân quyền tập trung** trong `policy.ts`.
- **Khoá API cá nhân** `zk_`.
- **Bốn gói thành viên**, trả trước qua SePay VietQR. Webhook và đối soát đều idempotent.
- **Paywall thống nhất** cho HTML, `.md`, REST và MCP.
- **Các trang** `/login`, `/account`, `/pricing` và `/billing/[code]`.
- **Tài liệu API**: OpenAPI/Scalar và 6 tool MCP mới.

Luồng Studio admin cũ vẫn chạy như trước: Studio session và admin API key `zuey_`.

## Commit (theo thứ tự)

1. `feat(db)`: thêm migration `0006_members_and_billing.sql`, khai báo env mới trong `src/env.d.ts` và `.env.example`.
2. `feat(members)`: đăng nhập, policy, khoá cá nhân, billing SePay, các route API, và webhook định tuyến ZSB/ZBK.
3. `feat(articles)`: paywall dùng entitlement `read_full` trên mọi bề mặt; phản hồi đã cá nhân hoá được đặt `private, no-store` và `Vary: Cookie, Authorization`.
4. `docs(api)`: thêm fragment OpenAPI cho Members và Billing, scheme cookie `MemberSession`, và đăng ký module MCP.
5. `feat(members)`: các trang login, account, pricing và billing.
6. `ci`: `.github/workflows/billing-reminders.yml`, chạy hằng ngày lúc 08:00 giờ Sài Gòn.
7. `test(members)`: thêm `tests/members.test.ts` (22 test) và `tests/billing.test.ts` (18 test).
8. `docs`: cập nhật README và `docs/env-setup.vi.md` (thêm migration 0006 và các biến mới).

## Thiết kế đáng chú ý

### OAuth thành viên

Thành viên dùng lại đúng callback đã đăng ký cho Studio (`/api/auth/{google,github}/callback`). Một cookie state riêng, `zuey_member_oauth`, cho callback biết đây là luồng thành viên. Nhờ vậy không phải đăng ký thêm redirect URI trên Google hay GitHub.

Quy tắc khi gặp một identity từ nhà cung cấp:

- Identity đã biết → đăng nhập vào đúng chủ của nó.
- Đang có session → liên kết identity vào tài khoản hiện tại.
- Còn lại → bắt buộc email đã được nhà cung cấp xác minh. Email chưa xác minh không bao giờ tạo hoặc chiếm tài khoản.

### Magic link

- Link trong email mở trang `/login/verify`. Token chỉ bị tiêu thụ khi người dùng bấm nút (POST, có kiểm tra CSRF), nên trình quét link trong mail không làm "cháy" token.
- Link được tạo từ `PUBLIC_SITE_URL`, không lấy từ header Host.

### Session

- Cookie `zuey_member`: HttpOnly, Secure, SameSite=Lax.
- Database chỉ lưu SHA-256 của token.
- Hạn 30 ngày, trượt mỗi khi dùng; mỗi giờ cập nhật tối đa một lần.

### CSRF

Với cookie thành viên, mọi method không an toàn phải có `Origin` cùng origin, hoặc `Sec-Fetch-Site: same-origin`. Nếu không, request bị từ chối `403 csrf_rejected`. Khoá API không chịu luật này vì không dựa vào cookie.

### Quyền admin

Chỉ email **đã xác minh** nằm trong `ADMIN_EMAILS`. Khoá `zk_` không bao giờ là admin. Hệ quả: tài khoản admin muốn đọc bài trả phí qua MCP phải dùng admin key của Studio.

### Gia hạn gói

Ngày hết hạn được tính lại một cách tất định từ toàn bộ đơn đã thanh toán:

- Mỗi đơn cộng thêm thời gian từ `max(thời điểm trả, ngày hết hạn hiện tại)`.
- Vì luôn tính lại từ đầu, chạy fulfil lặp lại cũng không cộng dồn sai.

### Webhook và đối soát

- Bảng `payment_events` dùng chung với booking.
- Event id là id giao dịch SePay, giống nhau ở cả webhook và reconcile, nên không bao giờ ghi nhận một giao dịch hai lần.
- Các trường hợp sau chuyển đơn sang `needs_attention`, không cấp quyền:
  - trả thiếu (`underpaid`)
  - trả trễ (`late_payment`)
  - trả thêm cho đơn đã thanh toán (`duplicate_payment`)

### Email

- Mọi email đều idempotent theo `email_log.idempotency_key`.
- Thiếu `RESEND_API_KEY`:
  - magic link và reminders trả `503`;
  - thanh toán vẫn được fulfil, biên nhận được ghi `skipped`.

## Kiểm chứng local (dev server, port 4321, đã tắt sau khi chạy)

- Áp migration 0006 vào D1 local.
- Thêm vào `.dev.vars` (file bị git bỏ qua, không commit) các giá trị test: `PUBLIC_SITE_URL`, `USD_VND_RATE`, `MEMBER_HASH_SALT`, `ADMIN_EMAILS`.
- Seed một thành viên test trực tiếp trong D1 local.

Kết quả smoke test:

- `/pricing` trả 200 và hiển thị giá VND. Ví dụ Knowledges = 238.000 ₫/tháng với tỷ giá 26.350.
- `/login` trả 200, có `noindex`. Khi đã đăng nhập, trang chuyển hướng tới `next`.
- `/account` khi chưa đăng nhập: 302 về `/login?next=%2Faccount`. Khi đã đăng nhập: 200 với `private, no-store`.
- Magic link khi thiếu Resend: `503 email_unconfigured`. Google khi chưa cấu hình: chuyển về `/login?error=google_unconfigured`.
- Tạo đơn combo 3 tháng:
  - Request cross-site: `403 csrf_rejected`.
  - Request cùng origin: 201, mã `ZSB…`, 1.503.000 ₫, có QR `qr.sepay.vn`.
- Mô phỏng webhook SePay → `paid`. Entitlement sau đó là `read_full` và `ai_chat`.
- Tạo khoá `zk_`:
  - `/api/v1/me` qua khoá: `via=user_api_key`.
  - `/api/v1/me/keys` qua khoá: `403 session_required`.
- `/api/openapi.json` có các path mới và scheme `MemberSession`. `/docs` trả 200.

## Rủi ro và việc còn lại

1. **Chưa kiểm tra giao diện bằng trình duyệt thật ở 320px.** Phiên này không có công cụ điều khiển trình duyệt. Layout đã được viết để không cuộn ngang (`min-w-0`, `break-words`/`break-all`, lưới tự xuống dòng, dialog `w-[calc(100%-1.5rem)]`), nhưng cần một lượt xem thủ công trên mobile. Cũng cần kiểm tra dialog `<dialog>` trên Safari iOS.
2. **Migration remote chưa chạy.** Cần chạy `wrangler d1 execute zuey_me_db --remote --file=./migrations/0006_members_and_billing.sql -y` khi deploy.
3. **Secret production chưa đặt.** Cần đặt `USD_VND_RATE`, `MEMBER_HASH_SALT` và `SEPAY_API_TOKEN` (tuỳ chọn); có thể đặt thêm `ADMIN_EMAILS` nếu muốn khác mặc định.
4. **Chưa có thao tác admin để xử lý đơn `needs_attention`.** Hiện admin chỉ xem qua API hoặc DB và liên hệ thủ công. Hướng làm: thêm endpoint duyệt hoặc hoàn tiền ở wave sau.
5. **Admin là thành viên (đăng nhập bằng email trong allowlist) vẫn chưa vào được trang `/studio`.** Trang này chỉ kiểm tra Studio session. Tuy vậy, mọi API admin (`authenticateAdmin`) đã chấp nhận admin thành viên.
6. **Ảnh đại diện chỉ nhận URL https.** Chưa có upload lên R2.
7. **`ai_chat` và `community` đã được cấp entitlement và có action trong `can()`.** Tuy nhiên tính năng chat và cộng đồng chưa dùng tới; việc này thuộc wave sau.
8. **`.dev.vars` local đang chứa giá trị test** (`PUBLIC_SITE_URL=http://localhost:4321` và các biến trên), và D1 local có thành viên test `tester@example.com`. Cả hai chỉ nằm trên máy local, không commit. Xoá khi không cần nữa.
