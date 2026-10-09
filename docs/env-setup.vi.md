# Hướng dẫn cấu hình biến môi trường (membership)

Tài liệu này chỉ ghi **tên** biến. Không commit giá trị thật; `.dev.vars` và `.env` đã nằm trong `.gitignore`.

- **Production (Cloudflare Pages):** project `zuey-me`, D1 `zuey_me_db` và DNS zone `zuey.me` cùng nằm trong **một** tài khoản Cloudflare (tài khoản sở hữu DNS). Trước mọi lệnh `wrangler`, export `CLOUDFLARE_ACCOUNT_ID` và `CLOUDFLARE_API_TOKEN` của tài khoản đó (lấy từ `.env`), để wrangler không dùng phiên OAuth của tài khoản khác. Đặt secret bằng `wrangler pages secret put <TÊN> --project-name=zuey-me`, rồi nhập giá trị khi được hỏi. Có thể đặt hàng loạt bằng `scripts/set-pages-secrets.js`.
- **Domain:** `zuey.me` và `www.zuey.me` được gắn vào Pages project (*Custom domains*); hai bản ghi CNAME (proxied) trỏ tới subdomain `*.pages.dev` của project. Rule chuyển hướng của zone (*Rules → Redirect Rules*) chạy trước Pages: chỉ cần còn một rule khớp `zuey.me` thì site không bao giờ được phục vụ và domain kẹt ở trạng thái `pending`. Token trong `.env` đọc/sửa được DNS và Pages, nhưng **không** có quyền *Single Redirect* hay *Page Rules*. Muốn sửa rule thì làm trên dashboard, hoặc thêm quyền *Zone → Single Redirect: Edit* cho token.
- **Local:** sao chép `.env.example` thành `.env` và điền giá trị (dùng cho `import.meta.env` và script). Server runtime (`locals.runtime.env`, đọc qua wrangler platform proxy) chỉ đọc `.dev.vars`, nên chép các biến runtime vào `.dev.vars` theo cùng định dạng `TÊN=giá_trị`, rồi khởi động lại `bun run dev`. Cả hai file đều bị git bỏ qua.

Thiếu biến nào thì API trả lỗi `503` kèm tên biến còn thiếu, không âm thầm hỏng.

## 0. Database migration

Chạy lần lượt trên D1 remote (chỉ chạy khi bạn chủ động deploy):

```bash
wrangler d1 execute zuey_me_db --remote --file=./migrations/0002_zuey_reads.sql -y
```

Lặp lại theo đúng thứ tự số với mọi file còn lại trong `migrations/` (đến `0013_article_email_notifications.sql`). Migration `0011` dựng lại bảng `bookings` để nhận phương thức `paypal`, nên phải chạy sau các migration có số nhỏ hơn.

**Sao lưu trước khi đổi schema hoặc dữ liệu.** Từ `0009` trở đi DB có bảng FTS5, nên `wrangler d1 export` báo lỗi *cannot export databases with Virtual Tables*. Thay vào đó, ghi lại bookmark Time Travel (khôi phục được trong 30 ngày):

```bash
wrangler d1 time-travel info zuey_me_db --json
```

Khi cần quay lại: `wrangler d1 time-travel restore zuey_me_db --bookmark=<bookmark>`.

## 1. Survey: `SURVEY_HASH_SALT`

1. Tạo chuỗi ngẫu nhiên dài, ví dụ bằng `openssl rand -hex 32`.
2. Lưu chuỗi đó vào secret `SURVEY_HASH_SALT`. Sau khi đã có phiếu bầu thì không đổi salt này, vì đổi sẽ làm hỏng cơ chế giới hạn 1 phiếu mỗi người.

## 2. Zuey Reads

1. Trong AnyMD, tạo API key có quyền đọc thư viện. Lưu key vào secret `ANYMD_API_KEY`.
2. Gắn tag `zuey-reads` cho những bài muốn hiển thị. AnyMD không có bộ lọc tag phía server, nên mỗi lần sync sẽ đọc cả thư viện rồi lọc ở phía zuey.me.
3. Binding Workers AI `AI` đã được khai báo trong `wrangler.toml`. Trên Pages, kiểm tra thêm ở *Settings → Bindings → Workers AI* (tên biến `AI`).
4. Tùy chọn: đặt `READS_SUMMARY_MODEL` để đổi model. Mặc định là `@cf/meta/llama-3.1-8b-instruct-fp8`.
5. Cấu hình cron sync trong GitHub, mục *Settings → Secrets and variables → Actions*:
   - Secret `ZUEY_ADMIN_API_KEY`: một API key có role **admin**, tạo trong Studio → API Keys (hoặc đăng nhập `POST /api/auth/login` bằng `ADMIN_MASTER_TOKEN` rồi gọi `POST /api/v1/keys`). Đưa key vào GitHub qua stdin, ví dụ `gh secret set ZUEY_ADMIN_API_KEY`, để key không nằm trong lịch sử shell.
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

## 4. PayPal Business (buổi tư vấn $1,999, USD)

Tuỳ chọn "Thẻ quốc tế / PayPal (USD)" trên `/business` chỉ hiện khi đủ `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` và `PAYPAL_WEBHOOK_ID`. Thiếu biến nào thì API trả `503 payment_unconfigured` kèm tên biến.

1. Mở hoặc nâng cấp tài khoản lên **PayPal Business**, rồi đăng nhập <https://developer.paypal.com>.
2. Thử trên **Sandbox** trước:
   - Vào *Apps & Credentials*, chọn tab *Sandbox*, bấm *Create App* (loại *Merchant*).
   - Lưu *Client ID* vào `PAYPAL_CLIENT_ID` và *Secret* vào secret `PAYPAL_CLIENT_SECRET`.
   - Đặt `PAYPAL_API_BASE=https://api-m.sandbox.paypal.com`.
3. Trong app vừa tạo, mục *Webhooks*, bấm *Add Webhook*:
   - URL: `https://zuey.me/api/webhooks/paypal` (khi thử sandbox cần một URL HTTPS công khai trỏ tới bản đang chạy).
   - Sự kiện: `Payment capture completed` (`PAYMENT.CAPTURE.COMPLETED`).
   - Cách khác không cần dashboard: lấy token bằng `POST /v1/oauth2/token` (Basic auth từ Client ID và Secret), rồi gọi `POST /v1/notifications/webhooks` với `url` và `event_types` như trên. Kết quả trả về chính là Webhook ID.
4. Sau khi lưu, PayPal hiển thị **Webhook ID**. Lưu giá trị này vào `PAYPAL_WEBHOOK_ID`. Mọi webhook được xác minh qua API `verify-webhook-signature` của PayPal bằng ID này; sai hoặc thiếu thì trả `401`.
5. Đặt thử một slot với tài khoản sandbox *Personal* (tạo trong *Sandbox → Accounts*). Sau khi thanh toán, PayPal đưa khách về `/booking/<id>`; trang này gọi capture phía server rồi hiển thị trạng thái thật của booking.
6. Khi lên live: chuyển sang tab *Live*, tạo app và webhook mới, cập nhật ba biến trên bằng giá trị live, rồi **xoá** `PAYPAL_API_BASE` (mặc định là `https://api-m.paypal.com`).

Lưu ý vận hành:
- Lịch chỉ được xác nhận khi PayPal báo khoản capture `COMPLETED` với đúng 1999.00 USD. Sai số tiền hoặc tiền về sau khi hết giữ chỗ 15 phút thì booking chuyển sang `needs_attention` để admin xử lý (hoàn tiền làm thủ công trên PayPal).
- Capture khi khách quay về và webhook dùng chung mã capture, nên một khoản tiền không bị ghi nhận hai lần.

## 4a. Dodo Payments (gói thành viên hằng tháng bằng thẻ, USD)

Nút "Thẻ quốc tế (USD, Dodo)" trên `/pricing` chỉ hiện cho gói đã có product ID, và chỉ khi có `DODO_API_KEY` và `DODO_WEBHOOK_SECRET`. Thiếu biến nào thì API trả `503 payment_unconfigured` kèm tên biến.

1. Đăng ký tài khoản tại <https://app.dodopayments.com> và hoàn tất xác minh doanh nghiệp. Bắt đầu ở **Test Mode** (công tắc trên thanh điều hướng).
2. Tạo 4 product dạng **Subscription**, chu kỳ **hằng tháng**, tiền **USD**, đúng giá:

   | Gói | Giá | Biến lưu product ID |
   |---|---|---|
   | Knowledges | $9/tháng | `DODO_PRODUCT_KNOWLEDGES` |
   | Zuey AI | $9/tháng | `DODO_PRODUCT_AI` |
   | Kết hợp | $19/tháng | `DODO_PRODUCT_COMBO` |
   | Cộng đồng | $29/tháng | `DODO_PRODUCT_COMMUNITY` |

   Không đặt trial và không bật giảm giá. Hệ thống chỉ kích hoạt gói khi product, số tiền và tiền tệ (USD) khớp đúng bảng trên; lệch thì gói chuyển sang `needs_attention`.
3. Vào *Settings → Business* và **tắt Adaptive Currency**. Nếu bật, khách có thể trả bằng tiền tệ khác USD và mọi thanh toán đó sẽ bị đánh dấu `needs_attention`.
4. Vào *Developer → API Keys*, tạo API key và lưu vào secret `DODO_API_KEY`. Chỉ đặt key Live lên production khi dashboard đã báo *Go live* được duyệt: trước đó Dodo từ chối mọi checkout live với `403 MERCHANT_NOT_LIVE` và khách sẽ thấy lỗi `502 payment_provider_error`. Khi chưa có `DODO_API_KEY`, nút thẻ tự ẩn và SePay vẫn hoạt động.
5. Vào *Developer → Webhooks*, bấm *Add Endpoint*:
   - URL: `https://zuey.me/api/webhooks/dodo`
   - Sự kiện: tất cả `subscription.*` (active, renewed, on_hold, cancelled, failed, expired, plan_changed) cùng `payment.succeeded` và `payment.failed`.
   - Lưu *Signing Secret* (dạng `whsec_…`) vào `DODO_WEBHOOK_SECRET`. Webhook được xác minh theo chuẩn Standard Webhooks, cửa sổ chống phát lại 5 phút.
6. Khi dùng Test Mode, đặt `DODO_API_BASE=https://test.dodopayments.com`. API key, product và webhook của Test Mode và Live Mode là riêng biệt, nên phải tạo lại cả ba khi chuyển sang live, rồi **xoá** `DODO_API_BASE` (mặc định là `https://live.dodopayments.com`).
7. Thử mua một gói bằng thẻ test của Dodo. Sau thanh toán, Dodo đưa thành viên về `/billing/card/<id>`; trang này chờ webhook xác nhận rồi mới báo gói đã kích hoạt. Trong `/account#billing` sẽ thấy ngày gia hạn cùng nút "Quản lý thẻ" (mở cổng khách hàng của Dodo) và "Huỷ gia hạn" (gói vẫn dùng được đến hết kỳ đã trả).

Lưu ý vận hành:
- Thanh toán thiếu `user_id` trong metadata (ví dụ tạo link thanh toán thủ công trong dashboard Dodo) được lưu thành bản ghi `needs_attention` không gắn thành viên. Mọi bản ghi `needs_attention` (SePay, Dodo, PayPal) hiện trong Studio → tab **Payments**; admin đánh dấu đã xử lý tại đó (`POST /api/v1/admin/billing/orders/{code}/resolve`), còn hoàn tiền vẫn làm trên dashboard của cổng thanh toán.
- Gói thẻ tự gia hạn được giữ quyền thêm 24 giờ sau ngày gia hạn để chờ webhook `subscription.renewed`; nhắc gia hạn qua email không gửi cho gói đang tự gia hạn.

## 5. SePay (chuyển khoản, VND)

1. Trong SePay, liên kết tài khoản ngân hàng nhận tiền.
2. Đặt `SEPAY_BANK_ACCOUNT` là số tài khoản và `SEPAY_BANK_CODE` là mã ngân hàng theo VietQR, ví dụ `ACB`.
3. Đặt `CONSULTATION_PRICE_VND` là số tiền nguyên, không có dấu chấm (= 1.999 × `USD_VND_RATE`).
4. Tự tạo một chuỗi ngẫu nhiên dài (`openssl rand -hex 32`) và lưu vào `SEPAY_WEBHOOK_API_KEY`.
5. Trong SePay, vào *Tích hợp WebHooks → Thêm webhooks*:
   - Sự kiện: **Có tiền vào**; chọn đúng tài khoản ngân hàng ở bước 1.
   - URL: `https://zuey.me/api/webhooks/sepay`
   - Kiểu chứng thực: **API Key**, dán chuỗi ở bước 4. SePay sẽ gửi header `Authorization: Apikey <key>`; sai key thì endpoint trả `401`.
   - Bỏ qua các giao dịch không có code thanh toán: **Không** (zuey.me tự lọc theo mã `ZBK…`/`ZSB…`).
6. Nội dung chuyển khoản phải chứa mã `ZBK…` (booking) hoặc `ZSB…` (gói thành viên). Mã hiển thị sẵn trên trang booking và trang `/billing/<mã>`.
7. (Tuỳ chọn) Để admin đối soát giao dịch bị lỡ webhook qua `POST /api/v1/billing/reconcile`, tạo API token trong trang quản trị SePay và lưu vào `SEPAY_API_TOKEN`. Thiếu biến này thì endpoint trả `503 reconcile_unconfigured`.

## 6. Email (Resend)

1. Verify domain `zuey.me` trong Resend: thêm các bản ghi DKIM/SPF/MX mà Resend đưa ra vào DNS zone `zuey.me`, rồi bấm *Verify*.
2. Tạo API key và lưu vào `RESEND_API_KEY`.
3. Đặt `RESEND_FROM`, ví dụ `hi@zuey.me` hoặc `Zuey <hi@zuey.me>`.

### 6a. Email bài viết mới cho thành viên

Lần xuất bản đầu tiên của một bài sẽ gửi email cho mọi thành viên đã xác minh email, **30 phút sau** khi xuất bản. Nội dung lấy theo bản đã xuất bản ở thời điểm gửi, nên các chỉnh sửa trong 30 phút đó đều có trong email. Bài trả phí gửi bản đầy đủ cho người có quyền `read_full`, còn người khác nhận phần xem trước kèm nút đăng ký (`/pricing`). Ngôn ngữ theo `users.locale` nếu bài có bản đó, nếu không thì dùng bản chính.

- **Không gửi email:** bỏ chọn “Gửi email cho thành viên” trong hộp xác nhận xuất bản ở Studio, hoặc gửi `notify: false` (REST/MCP). Xuất bản với `published_at` lùi ngày mặc định không gửi. Migration `0013` đánh dấu mọi bài đã đăng trước đó là “không gửi”.
- **Lịch chạy:** Worker `zuey-me-scheduler` (`workers/scheduler/`) có Cron Trigger 5 phút một lần, gọi `POST /api/v1/articles/notifications/dispatch` bằng `CRON_SECRET`. Không dùng GitHub Actions vì repo công khai.
  ```bash
  openssl rand -hex 32                       # tạo giá trị CRON_SECRET
  wrangler pages secret put CRON_SECRET --project-name=zuey-me
  wrangler secret put CRON_SECRET --config workers/scheduler/wrangler.toml   # chỉ đặt một lần, deploy không xoá
  ```
  Code của Worker được CI deploy cùng lúc với Pages mỗi khi merge vào `main` (`.github/workflows/deploy.yml`), không chạy `wrangler deploy` bằng tay.
- **Biến môi trường:** `MEMBER_HASH_SALT` (ký link huỷ nhận email, bắt buộc), `ARTICLE_EMAIL_FROM` / `ARTICLE_EMAIL_REPLY_TO` (tuỳ chọn), `ARTICLE_EMAIL_DAILY_CAP` (mặc định 2000), `ARTICLE_EMAIL_QUIET_HOURS` (mặc định `23-7` giờ Việt Nam, `off` để tắt).
- **Mỗi người nhận tối đa một lần:** mỗi lượt gửi giữ chỗ người nhận trong `email_log` trước khi gọi Resend. Lỗi chắc chắn chưa gửi (4xx, ví dụ 429 hay sai domain) thì trả lại để lượt sau gửi. Lỗi không rõ đã gửi hay chưa (mạng, 5xx sau một lần thử lại) thì ghi `failed` với `error` bắt đầu bằng `unconfirmed:` và không gửi lại.
- **Đổi `MEMBER_HASH_SALT`** sẽ làm hỏng mọi link huỷ nhận trong các email đã gửi (kể cả huỷ một chạm). Chỉ đổi khi thật cần.
- **Bounce/spam:** tạo webhook trong Resend (Dashboard → Webhooks) trỏ tới `https://zuey.me/api/webhooks/resend` với các sự kiện `email.bounced` và `email.complained`, rồi lưu signing secret vào `RESEND_WEBHOOK_SECRET`. Địa chỉ hard bounce hoặc bị đánh dấu spam sẽ tự ngừng nhận email bài viết.

**Giữ email ngoài hộp spam (warm-up):**

1. Giới hạn gửi trong 24 giờ tăng dần: 50 → 100 → 200 → … mỗi ngày kể từ email bài viết đầu tiên, tối đa `ARTICLE_EMAIL_DAILY_CAP`. Thành viên hoạt động gần nhất được gửi trước. Phần còn lại tự gửi ở các lượt cron sau.
2. Mỗi email có `List-Unsubscribe` và `List-Unsubscribe-Post` (huỷ một chạm theo RFC 8058, Gmail/Yahoo bắt buộc với người gửi số lượng lớn), có phần text thuần, và HTML dưới ngưỡng 102 KB để Gmail không cắt.
3. Không gửi trong giờ yên lặng (23:00–07:00 giờ Việt Nam): email chờ tới sáng để được mở nhiều hơn.
4. DNS: SPF/DKIM của Resend cho `send.zuey.me` đã có. **DMARC** đã có từ 2026-10-09 (`_dmarc.zuey.me` TXT `v=DMARC1; p=none; adkim=r; aspf=r`, áp dụng cho cả `news.zuey.me`). Sau vài tuần gửi ổn định thì nâng lên `p=quarantine`. Muốn nhận báo cáo DMARC thì thêm `rua=mailto:…` (ví dụ bật Cloudflare DMARC Management).
5. Bản tin gửi từ subdomain riêng `news.zuey.me` (`ARTICLE_EMAIL_FROM=Zuey <hi@news.zuey.me>`, domain đã verify trong Resend, vùng `ap-northeast-1`; DKIM/SPF/return-path nằm ở `resend._domainkey.news`, `send.news`, `rsend.news`), nên uy tín email đăng nhập/thanh toán (`zuey.me`) không bị ảnh hưởng nếu bản tin bị đánh dấu spam. Hộp thư nhận phản hồi (`ARTICLE_EMAIL_REPLY_TO`) phải nhận được thư thật.
6. Theo dõi tỷ lệ bounce (< 2%) và spam (< 0,1%) trong Resend và Google Postmaster Tools.

## 7. Thành viên & gói

1. `ADMIN_EMAILS`: danh sách email admin, phân tách bằng dấu phẩy. Chỉ email **đã xác minh** (qua magic link hoặc Google/GitHub) mới có quyền admin. Để trống thì dùng mặc định `goon.nguyen@gmail.com,duy@wearetopgroup.com`.
2. `MEMBER_HASH_SALT`: chuỗi ngẫu nhiên dài, dùng để băm IP khi giới hạn tần suất gửi magic link.
3. `USD_VND_RATE`: tỷ giá dùng để quy đổi giá USD sang VND, ví dụ `26000`. Mỗi tháng được làm tròn lên 1.000 ₫. Thiếu biến này thì tạo đơn trả `503 billing_unconfigured`. Trả trước được giảm 5% (3 tháng), 10% (6 tháng), 20% (12 tháng); mức giảm nằm trong `src/lib/members/plans.ts` (`PREPAY_DISCOUNT_PERCENT`), không phải biến môi trường.
4. `PUBLIC_SITE_URL`: domain dùng để tạo link trong email (ví dụ `https://zuey.me`; local là `http://localhost:4321`).
5. Magic link cần `RESEND_API_KEY`. Đăng nhập Google/GitHub dùng lại `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` và `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` cùng callback URL đã đăng ký cho Studio, không cần đăng ký thêm.
6. Nhắc gia hạn chạy hằng ngày bởi `.github/workflows/billing-reminders.yml`, dùng chung secret `ZUEY_ADMIN_API_KEY` và variable `SITE_URL` với cron Reads.
7. Widget GitHub activity trên trang chủ gọi GitHub API bằng chính `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` (giới hạn 5.000 request/giờ thay vì 60). Không cần biến mới.
8. `ADMIN_MASTER_TOKEN` là token break-glass: dán vào ô đăng nhập bằng token của Studio (`/studio`) để có phiên admin khi SSO hỏng. Tạo bằng `openssl rand -hex 32` và chỉ lưu trong trình quản lý mật khẩu.

## 8. Zuey AI (Dewee gateway)

1. `DEWEE_GATEWAY_URL`: URL gateway Dewee; `DEWEE_GATEWAY_TOKEN`: token gọi gateway (chỉ dùng phía server). Nên dùng token operator có phạm vi hẹp cho agent, không dùng token tenant-admin.
2. `DEWEE_AGENT_KEY`: key của agent trả lời, mặc định `zuey-ai`.
3. Tuỳ chọn: `AI_MONTHLY_REQUEST_LIMIT` (mặc định 300 request/thành viên/tháng) và `AI_EST_COST_USD_PER_MTOK` (giá blended USD/1 triệu token, mặc định `0.5`). Chi phí ước tính này được trừ vào ngân sách AI hằng tháng của gói ($3 gói AI, $5 gói combo/cộng đồng); hết ngân sách thì chat trả `429 ai_budget_exceeded` tới tháng sau.
4. Thiếu biến nào thì API chat trả `503 ai_unconfigured` kèm tên biến còn thiếu.
5. `SANDBOX_FETCH_ALLOWLIST`: danh sách host mà block tương tác (HTML/JS) được GET qua `/api/v1/sandbox/fetch`, phân tách bằng dấu phẩy, hỗ trợ `*.example.com`. Để trống thì tắt proxy. Hiện dùng `api.open-meteo.com,geocoding-api.open-meteo.com,api.github.com,api.frankfurter.app`.

### Jev (TypeSafe AI): xếp hạng lại kết quả

1. Đăng nhập [typesafe.ai](https://typesafe.ai), tạo API key, lưu vào `TYPESAFEAI_API_KEY`.
2. Tuỳ chọn: `TYPESAFE_API_BASE` (mặc định `https://api.typesafe.ai`) và `TYPESAFE_MODEL` (mặc định `jev-latest`).
3. Khi có key, `/api/v1/search` và nguồn trích dẫn của Zuey AI được Jev chấm điểm liên quan; kết quả search có `reranked: true` và `relevance` cho từng hit. Jev chỉ nhận phần nội dung người hỏi được phép đọc. Jev lỗi hoặc chậm quá 4 giây thì giữ nguyên thứ tự BM25, không làm hỏng search.

## 9. Cộng đồng Telegram (gói $29)

1. Tạo bot bằng @BotFather, lưu token vào `TELEGRAM_BOT_TOKEN`.
2. Thêm bot làm admin của hai nhóm kín (tiếng Anh, tiếng Việt) với quyền *Invite users via link* và *Ban users*. Lưu ID nhóm (dạng `-100…`) vào `TELEGRAM_GROUP_EN_ID` và `TELEGRAM_GROUP_VI_ID`.
3. Tạo chuỗi ngẫu nhiên cho `TELEGRAM_WEBHOOK_SECRET`, rồi đăng ký webhook một lần theo lệnh `setWebhook` ghi trong `.env.example` (URL `https://zuey.me/api/v1/community/telegram-webhook`, `allowed_updates=["chat_member"]`).
4. Thiếu biến nào thì các endpoint cộng đồng trả `503 community_unconfigured`; thành viên vẫn thấy thẻ cộng đồng trong `/account#community` nhưng chưa nhận được link mời.

## 10. OAuth / MCP cho ứng dụng bên ngoài

`/mcp` và OAuth 2.1 (`/.well-known/oauth-authorization-server`) không cần secret mới. Chỉ đặt `MCP_ALLOWED_ORIGINS` (phân tách bằng dấu phẩy) khi một web app ở origin khác cần gọi `/mcp` trực tiếp từ trình duyệt.

## 11. Kiểm tra

1. Mở `/docs`. Kiểm tra có các nhóm Reads, Workflows, Booking, Articles, Members & account và Membership billing.
2. Gọi `POST /api/v1/reads/sync` bằng admin key. Kết quả mong đợi là `200`, không phải `503`.
3. Đặt thử một slot trên `/business` bằng PayPal sandbox hoặc chuyển khoản nhỏ. Sau khi thanh toán, kiểm tra 3 việc:
   - Booking chuyển sang `confirmed`.
   - Có link Meet.
   - Email kèm file ICS được gửi tới.
