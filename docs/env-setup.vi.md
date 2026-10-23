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

Lặp lại theo đúng thứ tự số với mọi file còn lại trong `migrations/` (đến `0024_media_assets.sql`). Migration `0011` dựng lại bảng `bookings` để nhận phương thức `paypal`, nên phải chạy sau các migration có số nhỏ hơn.

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

## 2a. Zueytube

1. Chạy migration `0015_zueytube_videos.sql` và `0017_zueytube_transcript_rewrite.sql` (xem mục 0).
2. Zueytube dùng chung secret `ANYMD_API_KEY` với Reads để lấy transcript (mỗi video YouTube tốn 3 credit AnyMD, chỉ lấy một lần khi thêm). Không có key thì AnyMD vẫn chạy với quota ẩn danh nhỏ.
3. Thêm video: Studio → tab **Zueytube**, hoặc `zuey videos add <link> --locale vi|en [--pair <video_id>]`, MCP `video_add`, REST `POST /api/v1/videos` (admin). Video không có phụ đề vẫn được thêm, với trạng thái transcript `unavailable`; lỗi AnyMD cho trạng thái `failed`, bấm *Refetch* để lấy lại.
4. Transcript vừa lấy được viết lại bằng AI: thêm dấu câu, chia đoạn, bỏ từ đệm, giữ nguyên ngôn ngữ và không tóm tắt. Mốc thời gian của từng đoạn là ước lượng. Bản phụ đề gốc được giữ trong cột `transcript_source`. Nếu AI lỗi, hoặc kết quả mất quá nhiều chữ, thì transcript gốc được giữ lại và trạng thái AI là `failed`. Chạy lại bằng nút ✨ trong Studio, `zuey videos rewrite <youtube_id>`, MCP `video_rewrite_transcript` hoặc `POST /api/v1/videos/{id}/rewrite` (admin, không tốn credit AnyMD).
5. Provider AI được thử theo thứ tự cho từng đoạn transcript:
   - **OpenRouter** (chính): đặt secret `OPENROUTER_API_KEY`. Model mặc định `google/gemma-4-31b-it`, đổi bằng biến `VIDEOS_REWRITE_OPENROUTER_MODEL` (không bắt buộc).
   - **Workers AI** (dự phòng, hoặc là provider duy nhất khi không có key OpenRouter): dùng binding `AI` có sẵn. Model mặc định `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, đổi bằng biến `VIDEOS_REWRITE_MODEL`.
   - **Tên riêng**: prompt luôn kèm tiêu đề video và danh sách tên riêng mặc định (ClaudeKit, AgentKit, Codex, Zuey…, kèm các cách phụ đề hay nghe nhầm) trong `src/lib/videos/video-transcript-glossary.ts`. Bổ sung tên mới bằng biến `VIDEOS_REWRITE_GLOSSARY` (không bắt buộc), mỗi tên cách nhau bằng dấu phẩy hoặc xuống dòng, có thể ghi cách hay bị nghe nhầm: `Hermes = Han Harris | Hermit, Kongming`. Sau khi đổi, bấm nút viết lại AI (hoặc `zuey videos rewrite <youtube_id>`) để áp dụng cho video cũ.
   Cột `transcript_rewrite_model` ghi provider đã tạo ra bản viết lại.

## 2b. Ảnh bài viết (media CDN)

1. Chạy migration `0024_media_assets.sql` và `0026_article_cover.sql` (xem mục 0).
2. R2: bucket public `zuey-media`, custom domain `media.zuey.me` (đã có sẵn trong account Cloudflare của zuey.me). Binding `MEDIA` khai báo trong `wrangler.toml`. Thiếu binding thì các API ảnh trả `503 media_unconfigured`. Ảnh bài viết nằm dưới prefix `articles/`; các prefix `blog/`, `research/` có sẵn không bị đụng tới.
3. Đưa ảnh lên (chỉ admin, API key read-only không dùng được):
   - Agent có shell: MCP `media_upload_url` (hoặc `POST /api/v1/admin/media/upload-url`) trả về URL dùng một lần, hạn 15 phút. Upload bằng `curl --upload-file ./anh.png '<upload_url>'`. File không phải ảnh hợp lệ thì bị từ chối mà URL vẫn dùng lại được.
   - Ảnh đã có URL public: MCP `media_import` hoặc `POST /api/v1/admin/media` với JSON `{"url": "https://…"}`. Server không đi theo redirect, nên phải đưa URL cuối.
   - Ảnh nhỏ (tối đa 2 MB): MCP `media_upload` với `data_base64`.
   - Kết nối qua `/mcp` (ChatGPT, Claude…): các tool media chỉ hiện trong `tools/list` khi token OAuth có scope `admin`. Scope này chỉ được cấp cho email nằm trong `ADMIN_EMAILS` và phải được tick ở màn hình đồng ý. Connector đã kết nối trước đó (hoặc chỉ xin scope member) sẽ không thấy tool media: ngắt kết nối ở `/account`, kết nối lại và tick `admin`. `tools/list` được cache tối đa 5 phút phía client.
4. Kết quả có `block` (block `image` kèm `width`/`height`). Chèn block này vào document của bài viết rồi gọi `article_update`. Cùng một file upload lại sẽ trả về ảnh đã có, không tạo bản sao.
5. Xoá: MCP `media_delete` hoặc `DELETE /api/v1/admin/media/{id}`. Nếu bản nháp hoặc bản đã xuất bản của bài viết hay bài học, hoặc ảnh bìa khoá học, còn dùng ảnh thì bị từ chối (`409 media_in_use`). Các revision cũ không được kiểm tra. Ảnh được cache `immutable` một năm, nên cache CDN và trình duyệt có thể vẫn hiện ảnh đã xoá.
6. Ảnh đã nằm sẵn trong bucket nhưng chưa có bản ghi (ví dụ đẩy tay lên R2): MCP `media_reconcile` hoặc `POST /api/v1/admin/media/reconcile` với `{"object_key": "articles/…", "sha256": "…", "width"?, "height"?}`. Server đọc lại object từ R2, kiểm tra loại ảnh, giới hạn 10 MB, sha256 và kích thước, rồi ghi `media_assets` với `origin = reconcile` và actor. Không fetch URL ngoài, không đoán key; key phải nằm dưới `articles/`. Cùng bytes đã đăng ký thì trả lại asset cũ.
7. Ảnh bìa bài viết: MCP `article_cover_set` hoặc `PUT /api/v1/articles/{slug}/cover` nhận `asset_id` (không nhận đường dẫn R2) và `expected_revision`. Một asset dùng chung cho mọi bản ngôn ngữ, mỗi bản có alt riêng (`alt`, `alts`), không phải viết lại nội dung bài. Bản đã xuất bản đổi ngay; bản nháp nhận ảnh bìa khi xuất bản. Không đặt ảnh bìa thì vẫn dùng ảnh đầu tiên của phần public như trước. `social_preview.mode` quyết định `og:image`/Twitter/JSON-LD: `generated_card` (mặc định, thẻ chia sẻ tự render), `cover` (ảnh bìa) hoặc `custom_asset` (ảnh riêng, kèm `asset_id`). Ảnh đang làm bìa hoặc ảnh chia sẻ thì `media_delete` bị từ chối.
8. Ảnh trong bài Knowledges vẫn public theo URL (key là hash khó đoán). Paywall chỉ bảo vệ phần chữ, vì email và ảnh chia sẻ mạng xã hội cần URL ảnh public.

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

## 4b. Khoá học

Khoá học thay cho AI Workflows. Mã nguồn ở `src/lib/courses/`; quyết định thiết kế ở `plans/261009-1605-courses/plan.md`. Thiếu biến nào thì API trả `503` kèm tên biến (`payment_unconfigured`, `media_unconfigured`), phần còn lại vẫn chạy.

1. **Migration** `migrations/0018_courses.sql`: tạo bookmark Time Travel cho D1 trước (`wrangler d1 time-travel info zuey_me_db`), rồi chạy riêng file: `wrangler d1 execute zuey_me_db --remote --file migrations/0018_courses.sql`. **Không** dùng `wrangler d1 migrations apply` trên production: bảng `d1_migrations` của `zuey_me_db` đang trống vì các migration trước được chạy bằng `--file`, nên lệnh đó sẽ chạy lại từ `0001`. Migration này **xoá bảng workflows** và dựng lại hai bảng `referral_commissions`, `referral_source_reversals` (giữ nguyên dữ liệu) để thêm nguồn `course_order`; vì vậy phải chạy sau `0016_referrals.sql` và `0017_zueytube_transcript_rewrite.sql`.
2. **Thanh toán**:
   - SePay dùng lại cấu hình mục 5 và `USD_VND_RATE`. Mã chuyển khoản khoá học có dạng `ZSC…`; webhook và job đối soát đã nhận dạng mã này.
   - Dodo: tạo **một** product *One-time*, bật *Pay What You Want* (giá tối thiểu $1), tiền USD. Lưu ID vào `DODO_PRODUCT_COURSE`. Checkout tự đặt số tiền theo giá đã giảm.
   - Trong webhook Dodo (mục 4a), bật thêm `refund.succeeded` và mọi sự kiện `dispute.*`. Hoàn tiền hoặc dispute `opened` / `accepted` / `lost` / `expired` sẽ thu hồi khoá học, quyền repo GitHub và chứng chỉ. Dispute `won` / `cancelled` khôi phục lại.
3. **Media**:
   - `COURSE_MEDIA_SECRET`: chuỗi ngẫu nhiên dài (`openssl rand -base64 48`), dùng ký link tải file và audio (hết hạn sau khoảng 10 phút, gắn với tài khoản người xem).
   - R2: bucket `zuey-course-files` (binding `COURSE_FILES` trong `wrangler.toml`), để private, không bật public access. Bucket phải tồn tại trước khi deploy.
   - Cloudflare Stream: tạo signing key bằng `POST /accounts/{account_id}/stream/keys`. Lưu `id` vào `CF_STREAM_SIGNING_KEY_ID` và `jwk` (đã giải base64) vào `CF_STREAM_SIGNING_JWK`. Mã `customer-<code>` lấy từ trang Stream, lưu vào `CF_STREAM_CUSTOMER_CODE`. Với từng video, bật *Require signed URLs*.
4. **GitHub**: `GITHUB_COURSES_TOKEN` là fine-grained token có quyền *Administration: write* trên các repo private của khoá học. Học viên liên kết GitHub ở `/account`; worker scheduler (`/api/v1/courses/jobs/github-invites`, mỗi 5 phút) mời họ làm collaborator chỉ đọc và tự thử lại khi GitHub lỗi.
5. **Soạn khoá học**: dùng tab **Courses** trong Studio, hoặc MCP `course_upsert` / `course_lesson_upsert`. Mặc định giảm giá cho thành viên là 10/10/25/40% (Knowledges / Zuey AI / Kết hợp / Cộng đồng); sửa được ở tab Courses → Settings, và mỗi khoá có thể ghi đè riêng.
6. **Chống lạm dụng**:
   - Mỗi tài khoản đăng nhập tối đa 2 thiết bị; thiết bị thứ 3 sẽ đẩy thiết bị dùng lâu nhất ra.
   - Đổi thiết bị liên tục, hoặc đọc bài từ nhiều IP / quốc gia trong 24 giờ, sẽ tạo cờ để admin xem xét trong Studio → Courses → Abuse. Từ đó admin bỏ qua cờ hoặc khoá quyền học.
7. **Kiểm tra**:
   - Mở `/courses` và một bài học thử khi chưa đăng nhập: đọc được.
   - Mở bài trả phí: hiện yêu cầu đăng nhập hoặc mua khoá học.
   - Mua bằng chuyển khoản nhỏ; trang `/courses/orders/ZSC…` phải chuyển sang "đã thanh toán", và email biên nhận được gửi tới.

Chương trình giới thiệu (`src/lib/courses/referral-bridge.ts`):

- Tài khoản đã gắn referrer được giảm giá referral và mang hoa hồng cho referrer ở **mọi khoá học** nó mua, miễn referrer còn hoạt động. Giảm giá không cộng dồn với giảm giá gói; luôn lấy mức cao hơn.
- Tài khoản chưa gắn theo luật đơn đầu của chương trình: nhập mã hoặc có cookie `zr_ref`, chưa từng trả tiền. Mã nhập tay sẽ gắn tài khoản vĩnh viễn sau khi đơn được tạo.
- Hoa hồng (`source_kind = course_order`) tính trên số tiền thực thu. Với SePay, số VND được quy đổi theo tỷ giá đã chốt trên đơn.
- Hoàn tiền, chargeback hay dispute đều đảo hoa hồng. Job recapture tự bắt lại các đơn đã trả mà ghi hoa hồng bị lỗi.

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
   - `IMAGE_TRANSFORMS` (tùy chọn): resize ảnh bài viết qua Cloudflare Image Transformations (zone `zuey.me` phải bật `image_resizing`). Để trống thì chỉ bật trên host `zuey.me` và `www.zuey.me`; `off` để tắt (HTML trong edge cache còn giữ URL đã resize tối đa 11 phút, nên chờ đủ 11 phút rồi mới tắt `image_resizing`); một origin như `https://zuey.me` cho bản build local dùng bộ resize production.
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

### Zuey AI trên Telegram: chỉ thành viên có gói mới chat được

Dewee hỏi zuey.me trước khi agent trả lời một tin nhắn Telegram (Channel Access Gate). Quyền `agent_chat` có trong các gói Zuey AI, Kết hợp và Cộng đồng.

1. `CHANNEL_ACCESS_SERVICE_KEY`: khoá dịch vụ (scope `channel_access:check`) chỉ dùng cho bên xác minh. Tạo bằng `openssl rand -hex 32` (tối thiểu 32 ký tự), đặt cùng giá trị cho Pages và cho cấu hình MCP server của dewee (header `Authorization: Bearer <khoá>`). Dewee gọi tool `channel_access_check` ở `https://zuey.me/api/mcp` (JSON-RPC) hoặc `POST /api/v1/channel-access/check` (kèm `Content-Type: application/json`). Khoá admin và khoá cá nhân `zk_` đều bị từ chối, và khoá dịch vụ không mở được gì khác. Endpoint OAuth `/mcp` không nhận khoá này.
2. `CHANNEL_LINK_TOKEN_SECRET`: secret HMAC chung với dewee để ký token liên kết ở `/connect?token=…` (tối thiểu 32 ký tự). Định dạng: `base64url(JSON payload) + "." + base64url(HMAC-SHA256(secret, phần payload))`, payload `{v:1, channel_type, channel_instance, sender_id, sender_username?, tenant?, exp, nonce}`. Mỗi token chỉ dùng được một lần. Bên xác minh chỉ trả link `/connect` khi người gửi nhắn riêng cho bot (`chat_type: direct`); trong nhóm, bot chỉ nhắc nhắn riêng để liên kết, vì ai trong nhóm cũng mở được link.
3. Tuỳ chọn `DEWEE_CHANNEL_INSTANCE_ID`: id channel instance của bot trên dewee. Khi có cùng `DEWEE_GATEWAY_URL` và `DEWEE_GATEWAY_TOKEN`, mỗi khi gói có `agent_chat` bật hoặc tắt (thanh toán, hoàn tiền, huỷ thẻ), khi thành viên liên kết, huỷ liên kết hoặc xoá tài khoản, zuey.me gọi `POST {DEWEE_GATEWAY_URL}/v1/channels/instances/{id}/access/invalidate`. Các lệnh gọi chạy song song, tối đa 2 giây, sau khi webhook thanh toán đã trả lời; lỗi gọi không ảnh hưởng thanh toán và dewee vẫn kiểm tra lại sau tối đa 300 giây. Khi đặt biến này, token liên kết có `channel_instance` khác sẽ bị từ chối.
4. Migration `0021_channel_identities.sql` tạo bảng liên kết và nạp sẵn Telegram ID từ cộng đồng (chỉ ID thuộc đúng một thành viên).
5. Telegram ID bị liên kết nhầm thành viên (nạp sẵn sai, liên kết trên máy người khác, chủ thật nhờ hỗ trợ): admin xem ai đang giữ ID bằng `GET /api/v1/admin/channel-identities/telegram/{id}` hoặc tool MCP `channel_identity_get`, rồi gỡ bằng `DELETE` cùng đường dẫn (kèm `Content-Type: application/json`, body tuỳ chọn `{"reason": "…"}`) hoặc tool `channel_identity_unlink`. zuey.me ghi `channel.unlinked` vào nhật ký hoạt động của thành viên đó (chỉ ghi "admin đã gỡ"; admin và lý do chỉ lưu ở nhật ký admin `admin_access_audit`) và báo dewee kiểm tra lại người gửi; sau đó chủ thật liên kết lại ở `/connect`. Khoá admin chỉ đọc không gỡ được.
6. Thiếu biến nào thì bên xác minh trả `503 channel_access_unconfigured` và trang `/connect` báo chưa sẵn sàng; với `on_error: deny` dewee sẽ chặn, không mở cửa.

### Jev (TypeSafe AI): xếp hạng lại kết quả

1. Đăng nhập [typesafe.ai](https://typesafe.ai), tạo API key, lưu vào `TYPESAFEAI_API_KEY`.
2. Tuỳ chọn: `TYPESAFE_API_BASE` (mặc định `https://api.typesafe.ai`) và `TYPESAFE_MODEL` (mặc định `jev-latest`).
3. Khi có key, `/api/v1/search` và nguồn trích dẫn của Zuey AI được Jev chấm điểm liên quan; kết quả search có `reranked: true` và `relevance` cho từng hit. Jev chỉ nhận phần nội dung người hỏi được phép đọc. Jev lỗi hoặc chậm quá 4 giây thì giữ nguyên thứ tự BM25, không làm hỏng search.

## 9. Cộng đồng Telegram (gói $29)

1. Tạo bot bằng @BotFather, lưu token vào `TELEGRAM_BOT_TOKEN`.
2. Thêm bot làm admin của hai nhóm kín (tiếng Anh, tiếng Việt) với quyền *Invite users via link* và *Ban users*. Lưu ID nhóm (dạng `-100…`) vào `TELEGRAM_GROUP_EN_ID` và `TELEGRAM_GROUP_VI_ID`.
3. Tạo chuỗi ngẫu nhiên cho `TELEGRAM_WEBHOOK_SECRET`, rồi đăng ký webhook một lần theo lệnh `setWebhook` ghi trong `.env.example` (URL `https://zuey.me/api/v1/community/telegram-webhook`, `allowed_updates=["chat_member"]`).
   - Khi có người vào nhóm bằng link mời, webhook ghi Telegram user id vào membership của thành viên đã nhận link (không tạo liên kết tài khoản). Người không có gói $29 bị mời ra ngay (`joined_then_removed`), trừ admin (email đã xác minh nằm trong `ADMIN_EMAILS`) vào bằng chính tài khoản Telegram đã liên kết với mình (bảng `channel_identities`, liên kết qua `/connect`), giống quy tắc của sweep ở mục 5. Email trong `ADMIN_EMAILS` nhưng chưa xác minh không được miễn; người khác vào bằng link admin chuyển tiếp cũng không được miễn. Việc vào nhóm không tự liên kết tài khoản Telegram, nên admin cần liên kết trước khi vào nhóm mà không có gói.
4. Thiếu biến nào thì các endpoint cộng đồng trả `503 community_unconfigured`; thành viên vẫn thấy thẻ cộng đồng trong `/account#community` nhưng chưa nhận được link mời.
5. **Dọn thành viên hết hạn (sweep):** `POST /api/v1/community/sweep` (admin, hoặc worker `zuey-me-scheduler` bằng `CRON_SECRET`, 5 phút một lần; MCP `community_sweep`) mời ra khỏi nhóm người đã hết gói $29 và huỷ link mời đã hết hạn hoặc của người hết gói.
   - **Chỉ tài khoản Telegram đã liên kết của admin được miễn:** người có email đã xác minh nằm trong `ADMIN_EMAILS` được giữ lại dù không có gói chỉ khi chỗ trong nhóm là của chính tài khoản Telegram đã liên kết với họ (`channel_identities`); người khác vào bằng link của admin vẫn bị mời ra. Link mời còn hạn của admin cũng được giữ (đếm ở `exempt_admins`). Link mời đã hết hạn của admin vẫn bị dọn.
   - **Lưu ý khi triển khai:** admin đã vào nhóm mà chưa liên kết tài khoản Telegram phải liên kết qua `/connect` trước khi chuyển sweep của scheduler từ `dry_run` sang live (`COMMUNITY_SWEEP_MODE` trong `workers/scheduler/wrangler.toml`), nếu không lượt sweep live đầu tiên sẽ mời họ ra. Kiểm tra trước bằng `?dry_run=1`: admin chưa liên kết sẽ xuất hiện trong `actions` với lý do `entitlement_lapsed`.
   - **Chạy thử (dry run):** `?dry_run=1` chỉ trả danh sách `actions` (ai sẽ bị mời ra/huỷ link và lý do `entitlement_lapsed` hay `invite_expired`), không gọi Telegram và không đổi membership nào. Khi không truyền `cursor`, dry run vẫn ghi điểm tiếp tục của riêng nó (`community_sweep_dry_run`) vào `job_cursors`; điểm này không ảnh hưởng lượt live.
   - **Phân trang:** mỗi lượt xét tối đa `limit` membership (mặc định 100, tối đa 500) theo thứ tự id và tối đa 40 lần gọi Telegram, rồi trả `next_cursor`. Không truyền `cursor` thì lượt sau tiếp tục từ điểm đã lưu trong bảng `job_cursors` (live và dry run lưu riêng), nên hàng tồn lớn được dọn dần qua nhiều lượt; hết danh sách (`complete: true`) thì quay lại từ đầu. Truyền `cursor=<id>` (hoặc `cursor=` để bắt đầu từ đầu) thì không đụng tới điểm đã lưu.
   - **Lịch chạy an toàn:** worker mặc định gọi `?dry_run=1` (biến `COMMUNITY_SWEEP_MODE = "dry_run"` trong `workers/scheduler/wrangler.toml`); log của worker (Workers → zuey-me-scheduler → Logs) ghi một dòng tóm tắt mỗi lượt: các con số, id membership kèm hành động và lý do, mã lỗi, `next_cursor` và `complete` (không có email). Xem vài lượt đầu, hoặc tự gọi `curl -X POST 'https://zuey.me/api/v1/community/sweep?dry_run=1&limit=500&cursor=' -H "Authorization: Bearer $CRON_SECRET" -H 'Content-Type: application/json' -d '{}'`; nếu kết quả có `complete: false` thì gọi tiếp với `cursor=<next_cursor>` cho tới khi hết danh sách. Sau đó mở PR đổi biến thành `"live"` để bật mời ra thật. Khi Telegram chưa cấu hình, worker ghi `skipped (community_unconfigured)` và không coi là lỗi. Lượt cron chỉ bị tính là lỗi khi có lỗi hệ thống (`telegram_unreachable`, `telegram_rate_limited`, `internal_error`) và lượt đó không tiến triển gì: live không mời ra hay huỷ được link nào, dry run không có `actions` nào. Các lỗi khác, ví dụ một membership kẹt mãi (`telegram_error` khi Telegram từ chối mời ra chủ nhóm, `community_unconfigured` khi thiếu ID nhóm), chỉ ghi cảnh báo kèm số lỗi, nên không làm hỏng mọi lượt 5 phút. Bảng `job_cursors` đến từ migration `0023_job_cursors.sql`: chạy nó trên D1 remote trước khi merge, vì CI deploy ngay sau merge.
6. Thông báo đơn hàng mới: thêm bot vào nhóm admin (chỉ cần là thành viên), lưu ID nhóm vào `TELEGRAM_GROUP_ID_SEPAY_NOTI`. Hệ thống gửi tin vào nhóm khi một đơn được thanh toán xong (gói thành viên, khoá học, lịch tư vấn) hoặc cần admin kiểm tra (thiếu tiền, trễ hạn, sai tài khoản), dù tiền đến từ webhook SePay, nút đối soát SePay của admin, thẻ qua Dodo hay PayPal. Giao dịch đã xử lý rồi (gửi lại, trùng) không tạo tin mới. Muốn nhận thêm ở Discord: tạo webhook cho kênh (Cài đặt kênh → Tích hợp → Webhook) và lưu URL vào secret `DISCORD_WEBHOOK_SEPAY_NOTI`. Kênh nào để trống thì không gửi; Telegram hay Discord lỗi cũng không làm hỏng webhook SePay.

## 10. OAuth / MCP cho ứng dụng bên ngoài

`/mcp` và OAuth 2.1 (`/.well-known/oauth-authorization-server`) không cần secret mới. Chỉ đặt `MCP_ALLOWED_ORIGINS` (phân tách bằng dấu phẩy) khi một web app ở origin khác cần gọi `/mcp` trực tiếp từ trình duyệt.

Refresh token được xoay vòng mỗi lần refresh. Dùng lại một refresh token đã xoay sẽ thu hồi toàn bộ grant, trừ trong cửa sổ ân hạn 30 giây: token vừa xoay chưa quá 30 giây, grant chưa bị thu hồi, sẽ nhận một cặp token mới cùng grant, tối đa 3 lần. Cửa sổ này dành cho nhiều phiên (ví dụ nhiều phiên Claude Code) dùng chung một token và refresh cùng lúc (RFC 9700 §4.14.2). Đánh đổi: token bị lộ và được dùng lại trong 30 giây đó vẫn nhận được cặp token mà không kích hoạt thu hồi. Cửa sổ cần migration `0032_oauth_refresh_grace.sql` (cột `oauth_tokens.grace_uses`); trước khi áp dụng, việc dùng lại bị xử lý nghiêm ngặt (thu hồi grant), không lỗi 500.

## 11. Kiểm tra

1. Mở `/docs`. Kiểm tra có các nhóm Reads, Courses, Courses admin, Booking, Articles, Members & account và Membership billing.
2. Gọi `POST /api/v1/reads/sync` bằng admin key. Kết quả mong đợi là `200`, không phải `503`.
3. Đặt thử một slot trên `/business` bằng PayPal sandbox hoặc chuyển khoản nhỏ. Sau khi thanh toán, kiểm tra 3 việc:
   - Booking chuyển sang `confirmed`.
   - Có link Meet.
   - Email kèm file ICS được gửi tới.

## 12. Chương trình giới thiệu (referral)

Migration `0016_referrals.sql` chỉ thêm bảng và cột, không sửa dữ liệu cũ. Vẫn ghi lại bookmark Time Travel trước khi chạy (mục 0).

1. **R2 cho ảnh CCCD:** tạo bucket riêng tư, không bật public access, không gắn custom domain:
   ```bash
   wrangler r2 bucket create zuey-referral-kyc
   ```
   Binding `REFERRAL_KYC` đã khai báo trong `wrangler.toml`. Thiếu binding thì upload ảnh trả `503`. Ảnh chỉ admin xem được (qua Studio, `Cache-Control: no-store`) và bị xoá ngay khi admin duyệt hoặc từ chối hồ sơ, hoặc khi referrer xoá tài khoản.
2. **Cron:** Worker `zuey-me-scheduler` gọi thêm `POST /api/v1/referrals/jobs/run` mỗi 5 phút (dùng chung `CRON_SECRET`). Job idempotent: ghi bù hoa hồng bị lỗi lúc thanh toán (ví dụ thiếu tỷ giá; nguồn đã hoàn tiền hoặc huỷ thì không ghi bù), chuyển hoa hồng hết hạn giữ sang `approved`, cập nhật bậc, và vào ngày 1 (giờ Việt Nam) chốt danh sách payout. Sau khi merge phải deploy lại worker:
   ```bash
   cd workers/scheduler && wrangler deploy
   ```
3. **Dodo (mã giảm giá một lần):** khi người được giới thiệu trả bằng thẻ, hệ thống tạo một discount code dùng một lần cho chu kỳ đầu và truyền vào checkout. Dodo trả lỗi 422 nếu truyền `discount_codes` khi `allow_discount_code` là `false` (đã kiểm tra ở Test Mode ngày 2026-10-09), nên checkout có mã giới thiệu bật ô nhập mã và mã đã được điền sẵn; checkout thường vẫn ẩn ô này. Mã chỉ áp cho chu kỳ đầu (`discount_cycle: 1`). Nếu lần trừ tiền đầu tiên (chưa tính thuế) cao hơn giá đã giảm, thẻ chuyển sang `needs_attention` với lý do `referral_discount_not_applied`: hệ thống không tự gọi Dodo, admin tự hoàn phần chênh lệch rồi xử lý thẻ. Hoa hồng vẫn tính trên số tiền đã thu. Webhook Dodo cần thêm sự kiện `refund.succeeded` và mọi sự kiện `dispute.*` để đảo hoa hồng khi hoàn tiền. Với gói thành viên bằng thẻ, `dispute.opened` đảo hoa hồng nhưng không đổi quyền truy cập; `dispute.accepted`, `dispute.lost` và `dispute.expired` (tiền đã trả lại cho chủ thẻ) được ghi một lần cho mỗi dispute thành chargeback. `dispute.won` / `dispute.cancelled` không khôi phục gì: admin tự xem lại hoa hồng đã đảo.
4. **PayPal (booking):** thêm sự kiện `PAYMENT.CAPTURE.REFUNDED`, `PAYMENT.CAPTURE.REVERSED` và `CUSTOMER.DISPUTE.CREATED` vào webhook PayPal để đảo hoa hồng.
5. **Cấu hình (Studio → Referrals → Settings, hoặc `PATCH /api/v1/admin/referrals/settings`):** bảng bậc, số ngày giữ (30), tỷ lệ booking (10%), ngưỡng chi trả ($50), số ngày cookie (30), mức khấu trừ VN (10%, nhãn "Thuế TNCN") và PayPal (18%, nhãn "Phí xử lý & thuế"). **Mức khấu trừ cần kế toán xác nhận** trước kỳ chi trả đầu tiên; đổi trong Settings, không cần deploy.
6. **Quy trình chi trả hằng tháng:**
   - Ngày 1: job tự chốt kỳ. Mỗi referrer có số dư đã duyệt ≥ ngưỡng và hồ sơ nhận tiền đã duyệt được tạo một payout, đã trừ khấu trừ, quy VND theo `USD_VND_RATE` lúc chốt. Thông tin người nhận (tên, ngân hàng, số tài khoản, CCCD, PayPal) được chụp lại vào payout lúc chốt: danh sách, CSV và Studio hiển thị bản chụp này, referrer sửa hồ sơ sau đó không làm đổi người nhận của kỳ đã chốt. Khoản hoàn tiền phát sinh sau khi đã trả được trừ vào kỳ sau.
   - Ngày 1–10: vào Studio → Referrals → Payouts, tải CSV (`GET /api/v1/admin/referrals/payouts.csv?period=YYYY-MM`), chuyển khoản ngân hàng hoặc PayPal thủ công, rồi bấm *Mark paid* kèm mã giao dịch (`POST /api/v1/admin/referrals/payouts/{id}/paid`). Payout không có bản chụp người nhận đã duyệt thì *Mark paid* trả `409 payee_unverified`. Người nhận được email xác nhận. Payout sai thì *Cancel* để số tiền trở lại số dư.
   - Hàng chờ duyệt (Studio → Referrals → Review): hoa hồng có dấu hiệu gian lận mềm (IP đăng ký hoặc nhập mã trùng IP đăng nhập của referrer, người chuyển khoản hoặc email PayPal trùng referrer, email dùng một lần, quá nhiều tài khoản gắn với referrer trong 24 giờ quanh lúc người được giới thiệu gắn mã) và hồ sơ KYC chờ duyệt. **Mọi hoa hồng từ booking tư vấn đều vào hàng chờ** (lý do `booking_manual_review`) vì email khách booking chưa được xác minh; các chặn cứng (tự giới thiệu, đã từng trả tiền, referrer bị khoá) vẫn áp dụng.
   - Duyệt hồ sơ KYC (`POST /api/v1/admin/referrals/payout-profiles/{userId}/{approve|reject}`) phải gửi kèm `updated_at` của hồ sơ đang xem. Nếu referrer sửa hồ sơ hoặc tải ảnh mới trong lúc đó, API trả `409 profile_changed`: tải lại và duyệt lại.
   - Mỗi người được giới thiệu chỉ có một đơn giảm giá đang chờ thanh toán (đơn SePay, checkout thẻ, hoặc lịch booking đang giữ chỗ theo cùng email). Đơn tạo thêm trong lúc đó tính giá gốc, không báo lỗi.
7. **Kiểm tra sau khi deploy:** mở `/r/<mã>` → phải chuyển hướng về trang chủ và có cookie `zr_ref`; `/pricing` hiện giá đã giảm cho tài khoản chưa từng trả tiền; `/docs` có nhóm Referrals.
8. **Email chuẩn hoá có index (migration `0019_canonical_emails.sql`):** kiểm tra "người này đã từng trả tiền chưa" (chạy ở mỗi lần xem `/pricing` và trang booking khi đã đăng nhập, mỗi checkout và trong ảnh chụp chống gian lận) tra cột `canonical_email` của `users`, `card_subscriptions` và `bookings` bằng phép so sánh bằng có index, thay vì quét mọi dòng cùng tên miền (với Gmail là toàn bộ dòng Gmail). Cách chuẩn hoá giống module referral: chữ thường, bỏ `+tag`, với Gmail bỏ dấu chấm và gộp `googlemail.com` vào `gmail.com`. Ứng dụng ghi cột này ở mọi lần thêm hoặc sửa email; tài khoản đã xoá để `NULL`. Migration chỉ thêm cột và index, **không** điền dữ liệu cũ; dữ liệu cũ do script `scripts/backfill-canonical-emails.ts` điền. Thứ tự triển khai:
   1. Ghi lại bookmark Time Travel (mục 0) và lưu giá trị bookmark.
   2. Chạy migration: `wrangler d1 execute zuey_me_db --remote --file=./migrations/0019_canonical_emails.sql -y`. Code cũ vẫn chạy bình thường với các cột mới.
   3. Export `CLOUDFLARE_ACCOUNT_ID` và `CLOUDFLARE_API_TOKEN` (từ `.env`), xem trước rồi chạy backfill:
      ```bash
      bun scripts/backfill-canonical-emails.ts --remote --dry-run
      bun scripts/backfill-canonical-emails.ts --remote
      ```
      Bản dry-run in số dòng cần cập nhật mỗi bảng và đường dẫn file SQL để đọc trước. Mỗi câu `UPDATE` khớp cả email gốc, nên dòng có email vừa đổi sẽ không bị ghi đè.
   4. Merge PR. CI tự deploy (không chạy `wrangler pages deploy` bằng tay).
   5. Chạy lại `bun scripts/backfill-canonical-emails.ts --remote` sau khi deploy xong, để điền các dòng mà code cũ ghi trong khoảng giữa bước 3 và bước 4. Script idempotent: lần chạy sau đó phải báo `Nothing to backfill.`


## 13. Mã ưu đãi (promo code) & hoá đơn doanh nghiệp

Migration `0020_promo_codes_and_invoices.sql` thêm bảng `promo_codes`, `promo_redemptions`, `invoice_requests` và cột snapshot mã trên `billing_orders`, `card_subscriptions`, `bookings`, `course_orders`. Không sửa dữ liệu cũ. Tạo bookmark Time Travel rồi chạy riêng file (như mục 4b, không dùng `migrations apply`):

```bash
wrangler d1 execute zuey_me_db --remote --file=./migrations/0020_promo_codes_and_invoices.sql -y
```

**Mã ưu đãi** (Studio → **Mã KM**, `/api/v1/admin/promo-codes`, MCP `promo_code_*`; code ở `src/lib/promos/`):

- Chỉ giảm theo %, 1–100. Áp cho gói SePay, thẻ Dodo, buổi tư vấn và khoá học; giới hạn theo sản phẩm, gói, khoá học, số tháng trả trước tối thiểu, khung thời gian, tổng lượt dùng và mỗi khách một lần (theo tài khoản, hoặc hộp thư đã chuẩn hoá với booking).
- Khách nhập ở một ô **"Mã ưu đãi"** (body `discount_code`; `referral_code` cũ vẫn nhận). Mã promo được tra trước; tên mã promo và mã giới thiệu không bao giờ trùng nhau. **Không cộng dồn**: lấy % lớn hơn giữa referral và promo, bằng nhau thì giữ referral (referrer vẫn có hoa hồng). Khoá học: thành viên > referral > promo khi bằng nhau.
- Mỗi checkout giữ một lượt đến khi đơn hết hạn (giải phóng tự động khi hết hạn, không cần cron); trả tiền xong lượt thành `redeemed`. Đơn dùng promo không tính là "đơn đầu" của chương trình giới thiệu.
- Khách checkout lại với cùng mã thì lượt giữ cũ của chính họ được nhả (không tự khoá mình); thẻ Dodo trừ tiền lần đầu thất bại cũng nhả lượt. Mã thua referral thì bị bỏ qua, không chặn checkout. `min_months` chỉ áp cho đơn SePay trả trước, không áp cho thẻ.
- `max_uses` là trần **mềm**: đơn đã hết hạn hoặc bị thay thế mà khách vẫn chuyển khoản thì vẫn được ghi nhận `redeemed`, nên số lượt có thể vượt trần một chút.
- `GET /api/v1/promos/quote` giới hạn 30 lượt tra / 10 phút / mạng (`429 rate_limited`).
- Mã 100%: đơn 0đ được kích hoạt ngay. Trên thẻ Dodo, mã 100% thành đơn trả trước 0đ đúng `card_cycles` tháng; vì vậy mã 100% chỉ được đặt `card_cycles` là 1, 3, 6 hoặc 12 (API trả `400 invalid_field` nếu khác).
- Thẻ Dodo: hệ thống tạo discount Dodo một lần dùng với `subscription_cycles = card_cycles`; webhook chấp nhận giá đã giảm trong số chu kỳ đó. Lần trừ đầu cao hơn giá đã giảm → thẻ `needs_attention` lý do `promo_discount_not_applied`, admin tự xử lý.
- Đổi tên mã đã có người dùng bị chặn (`409 code_in_use`): tạo mã mới.

**Hoá đơn doanh nghiệp** (Studio → **Hoá đơn**, `/studio#invoices`, `/api/v1/admin/invoice-requests`, MCP `invoice_request_*`):

- Chỉ khi thanh toán SePay: khách tick "Xuất hoá đơn công ty" và nhập MST (`10 số` hoặc `10 số-3 số`) + email nhận hoá đơn. Dodo/PayPal trả `400 invoice_requires_sepay`. Đơn 0đ không tạo yêu cầu.
- Khi đơn được thanh toán, yêu cầu chuyển `requested` và mọi email trong `ADMIN_EMAILS` nhận một email (Resend). Admin xuất hoá đơn điện tử thủ công, rồi nhập số hoá đơn ở Studio (*Mark issued*) hoặc `POST /api/v1/admin/invoice-requests/{id}/issue`. CSV cho kế toán: `GET /api/v1/admin/invoice-requests.csv?status=requested`.

**Kiểm tra sau khi deploy:** tạo một mã thử ở Studio → Mã KM, nhập ở `/pricing` → hiện giá đã giảm; `GET /api/v1/promos/quote?code=<MÃ>` trả `200`; `/docs` có nhóm "Promo codes & invoices". Tắt mã thử sau khi kiểm tra.

## 14. Analytics (PostHog)

Project đích: PostHog **Zuey.me**. Danh mục sự kiện, quy tắc PII và consent: [analytics-events.md](analytics-events.md).

- `PUBLIC_POSTHOG_KEY`: project API key (`phc_…`, là key công khai, không phải secret). Hiện được khai báo trong `[vars]` của `wrangler.toml` (cùng `PUBLIC_POSTHOG_HOST`); thiếu thì **chỉ bản build production** dùng key mặc định trong `src/lib/analytics/destinations/posthog.ts`. Bản preview (`*.pages.dev`) cũng là build production và nhận cùng key từ `wrangler.toml`, nhưng trình duyệt chỉ gửi sự kiện trên `zuey.me` và `www.zuey.me` (`src/lib/analytics/constants.ts`), nên preview, `localhost` và bản dev không gửi gì.
- `PUBLIC_POSTHOG_HOST` (tuỳ chọn): mặc định `https://us.i.posthog.com`. Phải là `https://`.
- `PUBLIC_ANALYTICS_DEBUG` (tuỳ chọn): `1` để gửi sự kiện trên mọi hostname (kể cả `localhost`, `bun run dev`, preview) và in lời gọi analytics ra console. Bình thường để trống. Sự kiện server cũng chỉ gửi khi request đến từ `zuey.me`/`www.zuey.me`, nên preview không bao giờ gửi vào project production.

- **Sự kiện server (outbox):** thanh toán, gói thành viên và đăng ký/đăng nhập được ghi vào bảng `analytics_outbox` (migration `0022_analytics_outbox.sql`, phải chạy trên D1 remote trước khi deploy). Worker `zuey-me-scheduler` gọi `POST /api/v1/analytics/outbox/drain` mỗi 5 phút bằng `CRON_SECRET` để gửi sang PostHog, tự thử lại với backoff và chuyển sang `dead` sau 10 lần lỗi (khoảng 22 giờ; cách đưa lại hàng đợi xem [analytics-events.md](analytics-events.md#server-event-outbox)). Không cần biến môi trường mới; CI tự deploy lại worker sau khi merge.

- **GA4** (đích thứ hai, cùng consent và cùng allowlist hostname với PostHog; chi tiết: [analytics-events.md](analytics-events.md#ga4-destination)):
  - `PUBLIC_GA4_MEASUREMENT_ID`: Measurement ID của web stream (`G-…`, công khai, không phải secret). Được inline lúc build: CI đọc từ GitHub Actions **repository variable** cùng tên (`gh variable set PUBLIC_GA4_MEASUREMENT_ID --repo mrgoonie/zuey-me --body <G-…>`), local đặt trong `.env`. Thiếu hoặc sai định dạng thì GA4 tắt hoàn toàn (không tải `gtag.js`).
  - `GA4_API_SECRET` (secret, chỉ server): API secret của Measurement Protocol, dùng để gửi `purchase`/`refund` từ outbox. Tạo ở GA4 Admin → Data streams → chọn web stream → *Measurement Protocol API secrets* → Create, rồi đặt bằng `wrangler pages secret put GA4_API_SECRET --project-name zuey-me` (export `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` từ `.env` trước). Thiếu thì đường gửi server sang GA4 bị bỏ qua lặng lẽ: không lỗi, không dead letter, PostHog vẫn nhận như cũ.
  - **Bắt buộc trước khi đặt biến:** tắt công tắc chính *Enhanced measurement* của web stream (tắt luôn history-change page views, scrolls, outbound clicks, site search, form interactions, video, file downloads), rồi kiểm tra DebugView; xem [analytics-events.md](analytics-events.md#ga4-destination). Chưa xác nhận thì để trống `PUBLIC_GA4_MEASUREMENT_ID`.

**Kiểm tra sau khi deploy:** mở zuey.me (không bật Do Not Track), PostHog → *Activity → Live events* phải thấy `$pageview` với `$current_url` không chứa `token`/`code`/`email`. Đăng nhập rồi tải lại trang: sự kiện mang `distinct_id` là member ID (không phải email). Đăng xuất: sự kiện kế tiếp có `distinct_id` ẩn danh mới. Bấm "Tắt thống kê" ở `/privacy#analytics`: không còn sự kiện mới từ trình duyệt đó.

## 15. Realtime presence (số người đang xem)

Trình duyệt (khi analytics được phép) xin vé ở `POST /api/v1/presence/ticket` rồi mở WebSocket tới Worker `zuey-me-presence` (`workers/presence`). Quy tắc dữ liệu: [analytics-events.md](analytics-events.md#realtime-presence).

- `PRESENCE_TICKET_SECRET` (secret): khoá HMAC ký vé kết nối. **Phải trùng** với secret cùng tên của Worker presence. Thiếu thì endpoint vé trả `503 presence_unavailable` và không ai được đếm.
- `PRESENCE_OWNER_MEMBER_IDS`: danh sách member ID (cách nhau bởi dấu phẩy) được coi là chủ trang trong presence. Không suy ra từ quyền admin: admin không có trong danh sách vẫn là khách thường. Chỉ những member này mới đọc/đổi được trạng thái chủ trang (`GET`/`PUT /api/v1/presence/owner`, MCP `presence_status_get`/`presence_status_set`, tab **Presence** trong Studio); admin khác nhận `403 not_owner` và không thấy tool hay phần điều khiển của chủ trang (tab **Presence** vẫn hiện phần chẩn đoán cho mọi admin). Member ID là cột `id` của bảng `users` trên D1.
- **Service binding `PRESENCE`** (khai báo ở cấp cao nhất của `wrangler.toml` gốc nên áp dụng cho mọi môi trường Pages, kể cả preview; CI chỉ deploy từ `main`): Pages chỉ gọi API nội bộ `/internal/owner` của Worker `zuey-me-presence` qua binding này, không bao giờ thử lại qua internet. Header `X-Presence-Internal` có dạng `<giây unix>.<HMAC của PRESENCE_TICKET_SECRET>` và chỉ hợp lệ trong ±120 giây, nên secret phải trùng ở cả hai bên và đồng hồ không lệch. CI deploy theo thứ tự Pages → scheduler → presence, nên ngay sau khi merge các endpoint chủ trang có thể trả `503 presence_unavailable` một lúc cho tới khi bước deploy Worker presence xong. Không cần secret mới.
  - Local: binding trỏ tới Worker presence chạy bằng `wrangler dev --config workers/presence/wrangler.toml`; không chạy thì endpoint chủ trang trả `503`. Chỉ khi không có binding, code mới gọi HTTP tới `PUBLIC_PRESENCE_URL`, và chỉ chấp nhận `https:` hoặc `http:` loopback (`localhost`, `127.0.0.1`, `[::1]`), không theo redirect.
  - Key và token của chủ trang dùng lại scope `account:read` (đọc) và `account:write` (đổi trạng thái); không có scope riêng cho presence.
  - Chế độ `auto` chỉ hiện "online" khi trình duyệt của chủ trang cho phép đếm (analytics được phép, không Do Not Track/GPC): vé của chủ trang phải là vé được đếm thì Worker mới coi là đang kết nối.
- `PUBLIC_PRESENCE_URL` (tuỳ chọn): origin của Worker presence, mặc định `https://presence.zuey.me`. Đọc lúc chạy (runtime, local là `.dev.vars`) bởi endpoint vé; cả beacon lẫn Activity Monitor lấy origin Worker từ câu trả lời của endpoint vé, nên không cần build lại khi đổi. Khi chạy Worker local: `http://localhost:8787` (kèm `PUBLIC_ANALYTICS_DEBUG=1`, vì ngoài `zuey.me`/`www.zuey.me` beacon không chạy).
- `PRESENCE_DEV_ORIGINS` (biến của **Worker presence**, chỉ dùng local): `1` cho phép origin `http://localhost:4321` và `http://127.0.0.1:4321` gọi `/v1/snapshot` và `/v1/connect`. Chỉ đặt trong `workers/presence/.dev.vars` (bị git bỏ qua) khi chạy `wrangler dev --config workers/presence/wrangler.toml`; **không** đặt trong `wrangler.toml` hay trên production, nơi chỉ `https://zuey.me` và `https://www.zuey.me` được phép.

- **Log của Worker presence:** `workers/presence/wrangler.toml` bật console log (`[observability.logs] enabled = true`) nhưng tắt invocation log (`invocation_logs = false`), vì invocation log ghi lại header của request và lúc bắt tay WebSocket vé kết nối nằm trong `Sec-WebSocket-Protocol`. Code của Worker không bao giờ log vé hay khoá `k`. Đừng bật lại invocation log.
- **Activity Monitor khi endpoint vé lỗi** (`503`, `429`, mất mạng): vẫn hiện số liệu bằng cách đọc `GET /v1/snapshot` mỗi khoảng 20 giây từ origin đã biết (origin trong vé gần nhất, nếu chưa có thì `PUBLIC_PRESENCE_URL` lúc build hoặc `https://presence.zuey.me`) và thử xin vé lại với backoff (tối đa 5 phút); chỉ báo mất kết nối/chưa khả dụng khi chính snapshot không đọc được.

- **Chẩn đoán cho admin:** `GET /api/v1/presence/diagnostics` (mọi admin hoặc key Studio chỉ-đọc; tab **Presence** trong Studio, tự làm mới mỗi 30 giây) đọc `/internal/diagnostics` của Worker qua binding `PRESENCE`: số socket, giới hạn, bộ đếm, alarm, dung lượng lịch sử. Không cần secret mới. Worker lỗi thì trả `503 presence_unavailable`.
- **Biểu đồ 24 giờ:** Activity Monitor đọc `GET /v1/history` của Worker (cùng origin với snapshot) mỗi khoảng 5 phút, chỉ khi cửa sổ đang mở và trang đang hiển thị; lỗi thì chỉ báo "chưa xem được lịch sử", số liệu trực tiếp không bị ảnh hưởng.
- **Vận hành** (thứ tự deploy, tên miền riêng, theo dõi, chi phí, xử lý sự cố, đổi `PRESENCE_TICKET_SECRET`): [presence-operations.md](presence-operations.md).

**Kiểm tra sau khi deploy:** trên zuey.me (không bật Do Not Track), DevTools → Network phải thấy `POST /api/v1/presence/ticket` trả `200` (vé được dùng lại trong tab tới gần lúc hết hạn, nên tải lại trang không phải lúc nào cũng xin vé mới) và một kết nối WebSocket tới `presence.zuey.me/v1/connect` (URL không chứa vé; vé nằm trong header `Sec-WebSocket-Protocol`, server chọn `zuey-presence.v1`) chỉ gửi `{"t":"hb","cat":…}` / `{"t":"idle"}`. Bấm "Tắt thống kê" ở `/privacy#analytics`: kết nối đóng ngay.
