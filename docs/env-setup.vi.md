# Hướng dẫn cấu hình biến môi trường (membership)

Tài liệu này chỉ ghi **tên** biến. Không commit giá trị thật; `.dev.vars` và `.env` đã nằm trong `.gitignore`.

- **Production (Cloudflare Pages):** `wrangler pages secret put <TÊN> --project-name=zuey-me`, rồi nhập giá trị khi được hỏi.
- **Local:** tạo file `.dev.vars` ở thư mục gốc, mỗi dòng `TÊN=giá_trị`, rồi khởi động lại `bun run dev`.

Thiếu biến nào thì API trả lỗi `503` kèm tên biến còn thiếu, không âm thầm hỏng.

## 0. Database migration

Chạy lần lượt trên D1 remote (chỉ chạy khi bạn chủ động deploy):

```bash
wrangler d1 execute zuey_me_db --remote --file=./migrations/0002_zuey_reads.sql -y
```

Lặp lại với `0003_articles_and_surveys.sql`, `0004_workflows.sql` và `0005_booking_and_payments.sql`.

## 1. Survey: `SURVEY_HASH_SALT`

1. Tạo chuỗi ngẫu nhiên dài, ví dụ bằng `openssl rand -hex 32`.
2. Lưu chuỗi đó vào secret `SURVEY_HASH_SALT`. Sau khi đã có phiếu bầu thì không đổi salt này, vì đổi sẽ làm hỏng cơ chế giới hạn 1 phiếu mỗi người.

## 2. Zuey Reads

1. Trong AnyMD, tạo API key có quyền đọc thư viện. Lưu key vào secret `ANYMD_API_KEY`.
2. Gắn tag `zuey-reads` cho những bài muốn hiển thị. AnyMD không có bộ lọc tag phía server, nên mỗi lần sync sẽ đọc cả thư viện rồi lọc ở phía zuey.me.
3. Binding Workers AI `AI` đã được khai báo trong `wrangler.toml`. Trên Pages, kiểm tra thêm ở *Settings → Bindings → Workers AI* (tên biến `AI`).
4. Tùy chọn: đặt `READS_SUMMARY_MODEL` để đổi model. Mặc định là `@cf/meta/llama-3.1-8b-instruct`.
5. Cấu hình cron sync trong GitHub, mục *Settings → Secrets and variables → Actions*:
   - Secret `ZUEY_ADMIN_API_KEY`: một API key có role **admin**, tạo trong Studio → API Keys.
   - Variable `SITE_URL`: ví dụ `https://zuey.me`.
   - Workflow `.github/workflows/reads-sync.yml` chạy 6 giờ một lần. Có thể bấm *Run workflow* để chạy thử.

## 3. Google Calendar / Meet

1. Vào Google Cloud Console và bật **Google Calendar API**.
2. Dùng OAuth client (Web) hiện có. Client này đã được lưu trong `GOOGLE_CLIENT_ID` và `GOOGLE_CLIENT_SECRET`.
3. Lấy refresh token cho tài khoản chủ lịch:
   - Mở OAuth Playground và chọn *Use your own OAuth credentials*.
   - Chọn scope `https://www.googleapis.com/auth/calendar.events`.
   - Bấm *Authorize* rồi *Exchange authorization code for tokens*.
4. Lưu refresh token vào secret `GOOGLE_CALENDAR_REFRESH_TOKEN`.
5. Tùy chọn: đặt `GOOGLE_CALENDAR_ID`. Mặc định là `primary`.

## 4. Polar (thanh toán thẻ, USD)

1. Tạo product **một lần**, giá $1,999, trong Polar (thử trên sandbox trước). Lưu ID của product vào `POLAR_CONSULTATION_PRODUCT_ID`.
2. Tạo Organization Access Token có quyền tạo checkout. Lưu token vào secret `POLAR_ACCESS_TOKEN`.
3. Tạo webhook:
   - URL: `https://<domain>/api/webhooks/polar`
   - Định dạng: Raw/Standard Webhooks
   - Sự kiện: `order.paid`
4. Lưu webhook secret vào `POLAR_WEBHOOK_SECRET`.
5. Khi dùng sandbox, đặt `POLAR_API_BASE=https://sandbox-api.polar.sh`. Mặc định là `https://api.polar.sh`.
6. Kiểm tra trên sandbox rằng webhook mang được `booking_id` trong metadata. Hệ thống sẽ dò lần lượt `metadata.booking_id`, rồi `checkout.metadata`, rồi `checkout_id`.

## 5. SePay (chuyển khoản, VND)

1. Trong SePay, liên kết tài khoản ngân hàng nhận tiền.
2. Đặt `SEPAY_BANK_ACCOUNT` là số tài khoản và `SEPAY_BANK_CODE` là mã ngân hàng theo VietQR, ví dụ `MBBank`.
3. Đặt `CONSULTATION_PRICE_VND` là số tiền nguyên, không có dấu chấm.
4. Tạo webhook:
   - URL: `https://<domain>/api/webhooks/sepay`
   - Kiểu xác thực: **API Key**
5. Lưu API key của webhook vào `SEPAY_WEBHOOK_API_KEY`. SePay sẽ gửi header `Authorization: Apikey <key>`.
6. Nội dung chuyển khoản phải chứa mã `ZBK…`. Mã này hiển thị sẵn trên trang booking.

## 6. Email (Resend)

1. Verify domain gửi mail trong Resend.
2. Tạo API key và lưu vào `RESEND_API_KEY`.
3. Đặt `RESEND_FROM`, ví dụ `Zuey <booking@zuey.me>`.

## 7. Kiểm tra

1. Mở `/docs`. Kiểm tra có các nhóm Reads, Workflows, Booking và Articles.
2. Gọi `POST /api/v1/reads/sync` bằng admin key. Kết quả mong đợi là `200`, không phải `503`.
3. Đặt thử một slot trên `/business` bằng sandbox hoặc chuyển khoản nhỏ. Sau khi thanh toán, kiểm tra 3 việc:
   - Booking chuyển sang `confirmed`.
   - Có link Meet.
   - Email kèm file ICS được gửi tới.
