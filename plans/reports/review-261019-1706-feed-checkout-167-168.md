# Review PR #167 và #168

Ngày: 2026-10-19 (Asia/Saigon). Base: `origin/main` 571f471. Cả hai head merge sạch với `origin/main` (không xung đột) trước khi chạy gate.

---

## PR #167: `/checkout.md` cho mua hàng có agent hỗ trợ (closes #164)

Branch `claude/trusting-hypatia-hou5rj`, commits 7a19a43, 1cb8376.

**Verdict: MERGE**

### Gate (head merge với origin/main)
- `bun test`: 1082 pass, 0 fail (61 file).
- `bun run build`: astro check 0 errors, 0 warnings; build Complete.

### 4 lỗi sai do reviewer trước nêu trên issue #164: đã sửa hết (1cb8376)
1. Subscription thẻ xác nhận ở `active` qua `subscription_get`: đúng. `CardStatus` trong `src/lib/payments/dodo-billing.ts:34` có `active`; `subscription_get` trả về `card_subscriptions` (`src/lib/members/billing.ts:303`).
2. REST chỉ nhận key cá nhân `zk_`: đúng. `resolvePrincipal` (`src/lib/members/policy.ts:102-163`) chỉ nhận session cookie, `zk_` và key admin/read của Studio; OAuth token chỉ được nhận trên `/mcp` (`src/lib/oauth/caller.ts:35`).
3. Có `bank_account` / `bank_code`: đúng, khớp `SepayTransferInfo` (`src/lib/payments/sepay.ts:39-44`).
4. Câu về `transfer: null`: giờ ghi "không có `transfer` và không có `checkout_url` thì đọc `status`". Khớp `toOrderView` (`billing.ts:138,157`) và `toCourseOrderView` (`course-orders.ts:170,189`), là những chỗ trả `transfer: null` khi đơn đã hết hạn hoặc đã trả.

### Đối chiếu các nội dung khác trong `/checkout.md` với code (đều đúng)
- Plan `knowledges|ai|combo|community`, kỳ hạn `1|3|6|12`: `src/lib/members/plans.ts:7,10`. Thẻ chỉ theo tháng, `months` phải là 1: `billing.ts:327`.
- `billing_checkout_create` nhận `{plan, months?, provider?}`, mặc định `sepay`: `src/lib/members/mcp.ts:30-42`. Endpoint REST `POST /api/v1/billing/orders`, `GET /api/v1/billing/orders/{code}`, `GET /api/v1/billing/subscription` đều tồn tại.
- Thẻ được giảm 100% thì trả về đơn `sepay` đã `paid`: `billing.ts:335-341`. Guide có nói "branch on `provider`".
- Khóa học: `course_checkout_create` bắt buộc `accept_terms: true` (`const: true`), provider sepay/dodo, mã ZSC: `course-mcp.ts:48-52`. Endpoint REST `courses/[course]/checkout.ts` và `courses/orders/[code].ts` tồn tại. Trạng thái `refunded`, `charged_back`, `cancelled` có trong `course-orders.ts:38`. Mô tả MCP đã ghi "Course Policy (7-day refund)" từ #163; guide trỏ tới `/policy` mà không chép số ngày, nên không bị lệch.
- Tư vấn: cần slot hold (`api/v1/booking/hold.ts`); checkout dùng PayPal hoặc SePay (`booking/[id]/checkout.ts:5`).
- `/pricing?plan=&months=` có chọn sẵn plan: `src/pages/pricing.astro:9,11`. `/account#keys` có thật (`oauth/account-mcp.ts:27`). `/mcp` nhận key `zk_` (`oauth/openapi.ts:23`).
- Test đối chiếu tên tool trong guide với registry MCP thật (`tests/checkout-md.test.ts`, "only names MCP tools that exist").
- Edge runtime: route thuần (`Response`, không dùng builtin Node). Không có `any`. `as unknown as APIContext` chỉ xuất hiện trong test, đúng mẫu các test hiện có.

### Ghi chú nhỏ (không chặn merge, không sửa)
- Bảng trạng thái chưa có `on_hold` / `paused` của subscription thẻ (`dodo-billing.ts:34`).
- Guide không nói Dodo là Merchant of Record cho thanh toán thẻ (USD). Có thể thêm một dòng nếu muốn agent giải thích rõ người bán là ai.
- `src/pages/index.md.ts` hard-code `https://zuey.me/checkout.md`, theo đúng cách file đó vẫn làm.

### Fix đã push: không có.
### Migration: không có.
### File trùng với PR mở khác
- `README.md`: #168, #186, #187, #188, #189, #190, #192, #193 (chỉ trùng dòng mô tả, dễ resolve).
- `skills/zuey-me/SKILL.md`, `src/pages/llms.txt.ts`, `src/pages/llms-full.txt.ts`, `src/pages/index.md.ts`: không PR mở nào khác đụng.

---

## PR #168: JSON Feed 1.1 (closes #166)

Branch `claude/trusting-hypatia-xb30qi`, commits c80dd0a, d6b576e.

**Verdict: MERGE, với điều kiện áp migration TRƯỚC khi merge.** Code không chạy được nếu thiếu cột (chi tiết bên dưới). Không cần sửa code.

### Gate (head merge với origin/main)
- `bun test`: 1092 pass, 0 fail (61 file).
- `bun run build`: 0 errors, 0 warnings; build Complete.

### Migration `migrations/0025_article_published_metadata.sql`
Nội dung:
- 3 lệnh `ALTER TABLE article_editions ADD COLUMN`: `published_title`, `published_excerpt`, `published_modified_at` (TEXT, nullable).
- Một `UPDATE` backfill từ revision `publish` mới nhất (`article_revisions`), fallback về `title`/`excerpt`/`published_at` hiện tại. Chỉ chạy cho các edition có `published_json IS NOT NULL`.
- `CREATE INDEX IF NOT EXISTS idx_article_editions_feed` (partial index, D1 hỗ trợ).

**Có phải additive không? Áp trước khi code deploy có an toàn không?** Có. Code cũ không đọc các cột mới, và không có `INSERT ... SELECT *` nào trên `article_editions`, nên thêm cột không ảnh hưởng. `article_revisions.excerpt` là `NOT NULL DEFAULT ''`, nên edition nào có revision publish sẽ được backfill đúng snapshot đã publish. Rủi ro duy nhất: nếu code cũ publish trong khoảng giữa lúc áp migration và lúc deploy, snapshot column sẽ cũ. Khi đó chạy lại câu `UPDATE` backfill (idempotent) là sửa được, `docs/json-feed.md` đã ghi điều này. Edition publish trước 0009 không có revision publish nên lấy title/excerpt hiện tại; nếu chúng có draft chưa publish thì draft đó lộ ra feed (đã ghi trong docs).

Lưu ý: số 0025 trùng với `0025_article_cover.sql` của #189. Controller cần đánh lại số.

**Code có chịu được việc thiếu cột không? KHÔNG.** Nếu merge (tức là auto-deploy prod) trước khi áp migration:
- `publishArticle` (`src/lib/blocks/articles.ts:~815-818`) ghi `published_title = title, published_excerpt = excerpt, published_modified_at = ?`, nên mọi lần publish/republish bài viết đều 500 với lỗi `no such column`. Ảnh hưởng Studio, REST và MCP `article_publish`. Câu UPDATE này chạy trước `recordRevision`, nên lỗi xảy ra luôn và không ghi dở dữ liệu nào.
- Tạo lại một edition đã xóa (`updateArticle`, `articles.ts:~725`) cũng 500.
- `GET /feed.json` trả 500, vì SELECT các cột mới.
- Các trang đọc khác (trang bài viết, `.md`, sitemap) không bị ảnh hưởng.

Kết luận: chạy `wrangler d1 time-travel info zuey_me_db` (restore point), áp 0025 lên remote, rồi mới merge. Tôi không thêm fallback trong code vì repo dùng quy ước migration trước rồi mới deploy, và docs của PR đã ghi rõ thứ tự này.

### Review code
- Edge runtime: chỉ dùng `crypto.subtle`, `TextEncoder`, `btoa`/`atob`, `URL`, `Response`. Không có builtin Node. Không có `any`, không cast inline. Lỗi trả theo envelope `errorResponse`, không có DB thì trả 503.
- Bảo mật: chỉ trả summary/excerpt, không bao giờ trả body trả phí. Output chỉ phụ thuộc query (không phụ thuộc cookie hay Accept-Language). Lỗi trả `no-store`. Có CORS `*` (an toàn vì không dùng cookie).
- Phân trang keyset theo `(published_at, article_id)`. Cursor được validate bằng regex ISO `...Z`. `parsePublishedAt` chuẩn hóa thành `toISOString()` (`articles.ts:770-776`), nên cursor sinh ra luôn hợp lệ. Có test đi hết hơn 500 bài mà không mất hay trùng bài.
- OpenAPI có `/feed.json` (`src/lib/blocks/openapi.ts`), nên khớp yêu cầu DoD về spec và Scalar.
- Middleware (`src/middleware.ts`) không can thiệp `.json`. Route tự set CORS và `Access-Control-Expose-Headers: ETag`.
- Nit (không sửa): `Layout.astro` hard-code `https://zuey.me/feed.json`, nên trên staging link vẫn trỏ về prod. Các link alternate khác trong layout dùng đường dẫn tương đối.

### Fix đã push: không có.
### File trùng với PR mở khác
- `src/lib/blocks/articles.ts`: #189, #193 (đều là article cover, cũng sửa luồng publish nên dễ xung đột ở câu UPDATE trong `publishArticle`), #182, #157, #158.
- `src/lib/blocks/openapi.ts`: #182, #186, #187, #188, #189, #190, #193.
- `src/layouts/Layout.astro`: #189, #193.
- `README.md`: rất nhiều PR (xem phần #167).
- `migrations/0025_*`: trùng số với #189 (`0025_article_cover.sql`). #193 có `0026_article_cover.sql`, có thể là bản trùng của #189.

---

## Câu hỏi còn mở
- Ai áp migration 0025 (sau khi đánh lại số) lên D1 production trước khi merge #168? Merge không tự áp migration, nên nếu quên thì chức năng publish bài viết sẽ sập.
