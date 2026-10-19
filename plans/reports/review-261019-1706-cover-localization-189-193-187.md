# Review: #189 / #193 (issue #175, ảnh bìa + social preview + media_reconcile) và #187 (issue #176, localization)

Ngày 2026-10-19 (Asia/Saigon). Worktree riêng trong scratchpad, đã xoá sau khi xong.

## Tóm tắt verdict

| PR | Verdict | Ghi chú |
| --- | --- | --- |
| #189 `claude/trusting-hypatia-e97tyh` | **MERGE** (bản giữ lại) | Đã merge `origin/main` (58ec51f), giải conflict, port 2 điểm từ #193, sửa 1 test semantic-conflict với #181, push. |
| #193 `claude/trusting-hypatia-dtin5m` | **CLOSE_AS_DUPLICATE** (của #189) | Không push gì. |
| #187 `claude/trusting-hypatia-lr6cn1` | **MERGE** | Đã merge `origin/main` (58ec51f), conflict README, push. |

Lưu ý: trong lúc review, `main` chạy tiếp 571f471 → 58ec51f (#167, #157) → f06f400 (#158, #147, #182). Hai nhánh đã push merge với 58ec51f; mình thử merge tạm (không push) với f06f400: cả hai **merge sạch, không conflict**, `bun test` đều 0 fail (#187: 1126 pass; #189: 1123 pass). GitHub có thể vẫn báo "behind" nhưng không còn CONFLICTING.

## 1. So sánh #189 và #193 (cùng issue #175)

Acceptance của #175/#170: `article_cover_set` nhận managed asset ID (không nhận path R2), áp cho mọi locale, alt riêng từng locale, không phải viết lại body; `social_preview.mode = generated_card | cover | custom_asset` trong head/OG/Twitter/JSON-LD; `media_reconcile` cho object R2 có sẵn đã kiểm tra SHA-256 + kích thước, ghi origin/actor, giữ toàn vẹn tham chiếu, không SSRF/không đoán key; test WebP 1672×941. **Cả hai PR đều đáp ứng đủ các mục chức năng này** và đều có test 1672×941.

| Tiêu chí | #189 | #193 |
| --- | --- | --- |
| Admin-only | MCP `mcpAdminActor` → `ctx.requireAdmin()`; REST cover `requireAdminActor`; REST reconcile `memberRoute`+`requireCan(admin)` (giống các route media có sẵn); `TOOL_ACCESS` = ADMIN | Giống hệt (MCP dùng `ctx.requireAdmin()`) |
| Đăng ký MCP | Module riêng `src/lib/blocks/article-cover-mcp.ts`, thêm vào `src/lib/mcp/registry.ts` (đúng chữ AGENTS.md); không đụng `src/lib/blocks/mcp.ts` | Thêm tool vào `articlesMcpModule` trong `src/lib/blocks/mcp.ts` (module đã đăng ký) |
| Phạm vi key của reconcile | Chỉ `articles/…` có đuôi ảnh, regex chặt (`src/lib/media/media-reconcile.ts:18`) | **Mọi prefix** (`blog/…`, `research/…`), nhận cả dạng URL (`media-reconcile.ts` regex `KEY_RE`) |
| Ảnh chia sẻ | Từ chối AVIF làm og:image (`article-cover.ts` `SHARE_MIMES`) | Không kiểm tra MIME |
| Cách lưu cover | Ghi `cover_url` của edition khi set và khi publish | Tính lúc đọc (`resolveCover` + `loadCoverAssets`), không ghi vào edition |
| Mode chưa cấu hình | Mặc định `generated_card` (NOT NULL DEFAULT) | NULL = hành vi cũ, có CHECK constraint |
| JSON-LD | Ảnh social đứng đầu, sau đó cover/fallback | Đúng ảnh og:image khi đã cấu hình |
| Hero trên trang | Luôn hiện, crop 16:9 | Ẩn nếu ảnh đầu body trùng cover (giải câu hỏi mở trong comment #175) |
| Phản hồi | Receipt gọn (revision, cover, editions) | `toSummary` (không có document) |
| Test | 1 file 389 dòng (reconcile + cover + social + guards + concurrency) | 2 file, reconcile kỹ hơn (SVG, quá cỡ, không có bucket, sửa content-type) |
| Migration | `0025_article_cover.sql` | `0026_article_cover.sql` (trùng số với #187) |

**Chọn #189.** Lý do quyết định:
1. **An toàn dữ liệu R2:** #193 cho reconcile object ở bất kỳ prefix nào. Sau khi đăng ký, `media_delete` (`deleteMediaAsset`, `src/lib/media/media-asset-store.ts:183-194`) sẽ `bucket.delete(object_key)` khi không có bài viết nào tham chiếu, tức là có thể xoá ảnh dưới `blog/` hoặc `research/` mà site khác đang dùng. Reconcile của #193 còn có thể ghi lại object ở các prefix đó để sửa content-type. Việc này vi phạm quy ước trong docs: "các prefix `blog/`, `research/` có sẵn không bị đụng tới". #189 giới hạn ở `articles/`.
2. #189 chặn AVIF làm ảnh chia sẻ (crawler không đọc được).
3. #189 đúng hướng dẫn đăng ký MCP và không đụng `src/lib/blocks/mcp.ts`, nên ít đụng chạm với #187.
4. #189 dùng số 0025, #187 dùng 0026, nên không trùng số migration.

**Đã port từ #193 sang #189** (commit `bc878ec`):
- Ẩn hero khi ảnh đầu tiên của body trùng cover (`src/pages/articles/[slug].astro`, `firstImage` được export trong `articles.ts`).
- Migration backfill `UPDATE media_assets SET origin = 'import' WHERE source_url IS NOT NULL;` vào `0025` (migration này chưa apply ở đâu, nên sửa được).
- Chưa port: bộ test reconcile mở rộng của #193 (SVG, quá 10 MB, thiếu bucket, sửa content-type). Đây là việc tuỳ chọn và cần viết lại theo API của #189.

## 2. PR #189: chi tiết

**Commit đã push lên `claude/trusting-hypatia-e97tyh`** (a35d5ab → e3aa968, không force):
- `ba9f99a`: merge origin/main (571f471), giải conflict README (dòng Article media + dòng MCP tool visibility của #181)
- `bc878ec`: fix(articles): ẩn hero khi trùng ảnh đầu body + backfill origin
- `6fd4eed`: test(mcp): thêm `media_reconcile` vào danh sách tool media admin ở `tests/oauth-mcp.test.ts:609`. Test do #181 thêm yêu cầu khớp chính xác danh sách tool `media_*`, nên nếu không sửa sẽ fail 1 test sau merge.
- `e3aa968`: merge origin/main (58ec51f, #157), giải conflict trong `publishArticle` (`src/lib/blocks/articles.ts`): giữ batch nguyên tử `commitAtRevision` của #157, dùng `coverUrl = managedCoverUrl(...) ?? firstImage(...)` của #189.

**Gates (trên e3aa968):** `bun test` 1109 pass / 0 fail; `bun run build` astro check 0 errors / 0 warnings, build Complete. Merge thử với f06f400: 1123 pass / 0 fail.

**Findings còn lại (không chặn merge):**
- (Trung bình, vận hành) **Phải apply migration 0025 trước khi deploy code.** `storeImage` INSERT cột `origin` (`media-asset-store.ts`, hàm `storeImage`) và `mediaReferences` đọc `a.cover_asset_id`/`a.social_preview_asset_id`. Nếu thiếu migration thì `media_upload*`, `media_import` và `media_delete` trên production bị lỗi 500. Các phần đọc bài viết thì chịu được (đọc `SELECT *`, cột thiếu được coi là mặc định).
- (Thấp) `reconcileMediaObject` gặp trường hợp trùng sha (`bySha`) thì trả asset có sẵn mà chưa đọc object, nên không xác nhận được object dưới key đó có tồn tại. Không gây lỗ hổng, chỉ là phản hồi `duplicate_of` dựa trên lời khai sha.
- (Thấp) `firstImage` lấy ảnh đầu tiên ở bất kỳ đâu trong body, không nhất thiết là block đầu. Nếu body có ảnh bìa ở giữa bài thì hero vẫn bị ẩn (cùng hành vi với #193).
- (Câu hỏi mở từ comment #175) `media_delete` một asset reconcile sẽ xoá luôn object R2 đẩy tay. Trong `articles/` thì chấp nhận được, cần chủ sở hữu xác nhận.

## 3. PR #193: CLOSE_AS_DUPLICATE

Trùng với #189. Gate trên nhánh gốc không chạy riêng (lần chạy đầu bị lỗi do `bun install` song song; không cần chạy lại vì PR đóng). Vấn đề chính: reconcile không giới hạn prefix + `media_delete` có thể xoá object ngoài `articles/` (xem mục 1). Migration `0026_article_cover.sql` trùng số với #187.

## 4. PR #187 (issue #176): structural localization prepare/apply

**Commit đã push lên `claude/trusting-hypatia-lr6cn1`** (2dae276 → 77feaa4, không force):
- `6a79117`: merge origin/main (571f471), giải conflict README (giữ cả dòng Structural localization lẫn dòng MCP tool visibility)
- `77feaa4`: merge origin/main (58ec51f), không có conflict

**Gates (trên 77feaa4):** `bun test` 1116 pass / 0 fail; build 0 errors / 0 warnings, Complete. Merge thử với f06f400: 1126 pass / 0 fail. (Trước khi merge #157: 1096 pass / 0 fail.)

**Review đúng đắn / bảo mật:**
- Admin-only: MCP prepare dùng `ctx.requireAdmin()`, apply dùng `mcpAdminActor`; REST cả hai dùng `requireAdminActor`; `TOOL_ACCESS` = ADMIN cho cả hai tool. Prepare trả draft (cả phần trả phí), nhưng chỉ admin gọi được nên ổn.
- Ghi dữ liệu đi qua `parseArticleInput` + `updateArticle` (có CAS theo revision). Thêm `structuralSkeleton` so khớp id/kiểu/lồng nhau/URL/code/topology Mermaid, nên sai một chỗ là không ghi gì. `source_hash` cũ trả 409 `stale_source`. Edition viết tay hoặc đã sửa sau lần apply cần `overwrite: true`.
- Widget: chỉ thay text thuần của phần tử có `data-i18n` và không có markup con. Bản dịch bị cấm `<`, `>` và `&` chưa escape, nên không chèn được HTML. Iframe của block interactive vẫn sandbox. Nhãn Mermaid bị cấm `[ ] { } | "` và xuống dòng.
- Đã đối chiếu `stringFields` với `src/lib/blocks/schema.ts`: phủ mọi trường text hiển thị (paragraph, heading, list, checklist, quote, callout, image, embed, table, chart, diagram, survey, interactive, math, gallery, audio, video, file, bookmark, toggle, icon, card). Section/layout không có trường text.

**Findings (không chặn merge):**
- (Trung bình, vận hành) **Thiếu migration 0026 thì prepare/apply trả 500**: `loadProvenance` (`src/lib/blocks/localization-service.ts:153`) SELECT bảng `article_localizations` mà không bắt lỗi, và được gọi bởi `localeStatus` mỗi khi locale đích đã có edition. Chỉ ảnh hưởng 2 endpoint mới; phần INSERT provenance thì có try/catch.
- (Thấp) `expected_revision` không bắt buộc, mặc định lấy revision đọc trong cùng request (`localization-service.ts:375-376`). CAS vẫn chạy, nhưng không bảo vệ trước thay đổi xảy ra giữa lúc agent prepare và lúc apply, ngoài `source_hash`. Thay đổi ở edition đích thì đã có `edited_since_apply` bắt.
- (Thấp) Provenance được ghi sau `updateArticle`, không cùng batch. Nếu ghi lỗi thì bản dịch vẫn lưu, kèm `provenance_recorded: false` (đã ghi rõ trong phản hồi).
- Chưa làm trong PR này (thuộc các phase sau của epic #170): widget i18n phối hợp với #76, `article_release`.

## 5. Migrations

| File | Nội dung | Additive? | Code chịu được khi prod chưa có? |
| --- | --- | --- | --- |
| `0025_article_cover.sql` (#189, bản cuối) | `articles` thêm `cover_asset_id TEXT`, `social_preview_mode TEXT NOT NULL DEFAULT 'generated_card'`, `social_preview_asset_id TEXT`; `article_editions` thêm `cover_alt TEXT NOT NULL DEFAULT ''`; `media_assets` thêm `origin TEXT NOT NULL DEFAULT 'upload'`; `UPDATE media_assets SET origin='import' WHERE source_url IS NOT NULL` | Có (chỉ ADD COLUMN có default, cộng backfill vô hại) | **Không hoàn toàn.** Đọc bài viết và render trang thì OK, nhưng upload/import/delete media lỗi 500 và `article_cover_set`/`media_reconcile` lỗi. Cần **apply trước khi merge/deploy**. Apply trước khi deploy code là an toàn, code cũ bỏ qua cột mới. |
| `0026_article_cover.sql` (#193, đóng) | Tương tự, cột `social_asset_id`, mode nullable + CHECK, cùng backfill | Có | Không áp dụng (PR đóng) |
| `0026_article_localizations.sql` (#187) | `CREATE TABLE IF NOT EXISTS article_localizations` (PK `article_id, locale`; source/result hash, revision, entry_count, actor, timestamps) | Có (bảng mới) | Phần còn lại của site OK; riêng prepare/apply trả 500 khi locale đích đã tồn tại. An toàn khi apply trước khi deploy. |

Nếu đóng #193 thì không còn trùng số: 0025 (#189) và 0026 (#187). Controller vẫn cần đối chiếu với các PR khác cũng dùng 0025/0026.

## 6. File #189 và #187 cùng đụng

So với main, chỉ có 3 file chung: **`README.md`**, **`src/lib/blocks/openapi.ts`**, **`src/lib/oauth/tool-access.ts`**. `git merge-tree` giữa hai nhánh: `openapi.ts` và `tool-access.ts` tự merge được (các hunk khác chỗ); **`README.md` conflict** vì hai dòng mới nằm sát nhau dưới mục Articles, giải bằng cách giữ cả hai dòng. `src/lib/blocks/mcp.ts` **không** chung, vì #189 dùng module MCP riêng (chỉ #193 mới đụng `mcp.ts`). Merge #189 trước hay #187 trước đều được.

## Câu hỏi chưa giải quyết
- Có cho `media_reconcile` nhận object ngoài `articles/` không? Nếu có thì phải chặn `media_delete` xoá object R2 của asset có `origin = reconcile` ngoài `articles/`.
- `media_delete` một asset reconcile có nên giữ lại object R2 không (câu hỏi mở trong comment #175)?
