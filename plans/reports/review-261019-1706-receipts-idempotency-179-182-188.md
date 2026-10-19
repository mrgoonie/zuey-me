# Review: receipts (#179, #182) và idempotency keys (#188)

Ngày: 2026-10-19 (Asia/Saigon). Main: `571f471`. Reviewer: agent độc lập, worktree riêng (đã xoá).

## Tóm tắt quyết định

| PR | Issue | Verdict | Ghi chú |
| --- | --- | --- | --- |
| #182 `claude/trusting-hypatia-pzeh9r` | #172 | **MERGE** (merge trước #188) | Receipt cho `article_update`, MCP + REST + OpenAPI, có `edition_draft_revision`. Đúng child mà epic #170 liệt kê. |
| #179 `claude/trusting-hypatia-bb8m6z` | #171 | **CLOSE_AS_DUPLICATE** (giữ lại ý tưởng mở rộng sang writer khác làm follow-up) | Chỉ MCP, shape receipt khác #182, thiếu `edition_draft_revision`, không có REST/OpenAPI. |
| #188 `claude/trusting-hypatia-dqrgee` | #174 | **MERGE** (sau #182) | Đã merge `origin/main` + #182 vào nhánh, sửa 1 bug nhỏ, push `7bf9722`. GitHub báo `MERGEABLE`. |

Thứ tự merge đề xuất: **#182 → #188**, rồi đóng #179/#171 là trùng lặp.

---

## 1. #179 so với #182: trùng lặp hay bổ sung?

Không phải trùng hoàn toàn: hai PR chồng nhau ở `article_update` (MCP), nhưng phủ khác nhau.

| | #179 | #182 |
| --- | --- | --- |
| Writer | MCP: `article_create`, `article_update`, `article_publish`, `article_tags_set`, `article_edition_delete` | `article_update` (MCP **và** `PUT /api/v1/articles/{slug}`) |
| REST / OpenAPI | Không | Có, schema `WriteReceipt`, `receipt` required trong response 200 |
| Field | `operation_success, operation, article_revision, edition_locale, published_revision, has_unpublished_changes, public_status, changed_fields, next_action` (chuỗi tự do) | `operation_success, locale, article_revision, edition_draft_revision, published_revision, has_unpublished_changes, submitted_fields, next_action` (enum `publish`/`none`) |
| File | `src/lib/blocks/receipt.ts` (mới), `src/lib/blocks/mcp.ts` | `src/lib/blocks/articles.ts` (`toWriteReceipt`), `mcp.ts`, `openapi.ts`, REST route |

Hợp đồng trong epic #170 (Phase 0) yêu cầu: `operation_success`, `article_revision`, `edition_draft_revision`, `published_revision`, `has_unpublished_changes`, `next_action`, `changed_fields`, và parity MCP/REST. Issue #172 lặp lại đúng danh sách này cho `article_update` MCP + REST. Issue #171 mở rộng writer nhưng chỉ MCP và đổi `edition_draft_revision` thành `has_unpublished_changes`.

Đánh giá:
- #182 khớp hợp đồng hơn: có `edition_draft_revision`, có REST + OpenAPI (AGENTS.md DoD mục 3), `next_action` là enum máy đọc được. Đổi `changed_fields` → `submitted_fields` là có chủ đích (reviewer chỉ ra đây là các field trong request, không phải diff); hợp lý và trung thực hơn.
- #179 phủ nhiều writer hơn nhưng chỉ MCP, nên REST và MCP sẽ trả hai shape khác nhau nếu merge cả hai. `next_action` là câu văn, khó cho agent xử lý.
- Merge cả hai nguyên trạng sẽ cho `article_update` MCP **xung đột trực tiếp** (cùng dòng `withSavedDocument(...)`) và hai type receipt song song (`OperationReceipt` vs `WriteReceipt`). Không nên.

**Khuyến nghị:** merge #182, đóng #179 và #171 là duplicate (comment trên #171 cũng đã đề xuất). Phần giá trị duy nhất của #179 (receipt cho create/publish/tags_set/edition_delete) nên làm thành follow-up issue: mở rộng `WriteReceipt` của #182 thêm trường `operation` và áp dụng cho các writer kia ở **cả** MCP và REST, cập nhật OpenAPI. Khi đó cần quyết định: giữ tên `submitted_fields` (khuyến nghị) và `next_action` enum (có thể thêm giá trị như `none` cho edition_delete). Không nên lấy `receipt.ts` của #179 làm nền vì shape lệch hợp đồng.

### Gate

| PR | `bun test` | `bun run build` (astro check) |
| --- | --- | --- |
| #179 (head `b37eee1`) | 1078 pass / 0 fail | 0 errors, 0 warnings, 66 hints (bằng main) |
| #182 (head `4231323`) | 1077 pass / 0 fail | 0 errors, 0 warnings, 66 hints |

(PR #179 tự báo 14 fail và chưa chạy build; trên máy này cả hai gate đều xanh.)

### Phát hiện (không chặn merge)

#182:
- `src/lib/blocks/articles.ts:366` (doc của `edition_draft_revision`): ghi "equals article_revision because a save bumps both together". `EditionSummary.revision` là "article revision at which this edition last changed", nên với một lần lưu chỉ metadata (vd. `access`) mà edition không đổi, giá trị có thể nhỏ hơn `article_revision`. Giá trị trả về vẫn đúng (đọc từ edition), chỉ comment không chính xác. Nit.
- `tests/article-write-receipt.test.ts:35`: tên test "reports next_action none ..." nhưng assert `next_action` là `'publish'`. Tên gây hiểu nhầm. Nit.

#179:
- Không có `edition_draft_revision` (yêu cầu của epic/#172), không có REST/OpenAPI parity. `next_action` là chuỗi tự do. Đây là lý do chọn #182.

### File chồng với PR khác đang mở
- `src/lib/blocks/mcp.ts`: #193, #190, #188, #187, #186, #182, #179, #158.
- `src/lib/blocks/articles.ts`: #193, #189, #188, #182, #168, #158, #157.
- `src/lib/blocks/openapi.ts`: #193, #190, #189, #188, #187, #186, #182, #168.
- `src/pages/api/v1/articles/[slug].ts`: #190, #188, #186, #182.
- `src/lib/blocks/receipt.ts`: chỉ #179.

Migration: không có (cả hai).

---

## 2. #188 idempotency keys

### Xung đột và cách giải quyết (đã push)

Nhánh gốc dựa trên `911ffda`. Commit đã push lên `claude/trusting-hypatia-dqrgee` (không force):

1. `6219701` Merge `origin/main`: chỉ xung đột `README.md` (dòng idempotency của #188 và dòng "MCP tool visibility" của #181 cùng chỗ). Giữ cả hai dòng.
2. `e72ed8d` Merge #182 (`origin/claude/trusting-hypatia-pzeh9r`): xung đột ở
   - `src/lib/blocks/mcp.ts`: #188 tách `switch` thành `callArticleTool()` (đổi thụt lề cả khối), #182 sửa `article_update` trong khối cũ. Giải quyết: giữ cấu trúc của #188, dùng mô tả tool của #182 + `...idempotencyKeyProp`, thêm `receipt: toWriteReceipt(rec, input)` vào `article_update` trong `callArticleTool`.
   - `src/pages/api/v1/articles/[slug].ts` (PUT): giữ wrapper `idempotentJson`, bên trong dùng `input = parseArticleInput(withoutIdempotencyKey(body), 'update')` và trả `{ ...toSummary(rec), receipt: toWriteReceipt(rec, input), document }`.
   - `openapi.ts` tự merge sạch (PUT có cả `idempotencyKeyParam` và response `WriteReceipt`).
3. `7bf9722` `fix(articles): record the real status code for keyed REST writes`:
   - `src/lib/idempotency/rest.ts:220`: `idempotentJson` không truyền `status` vào `withIdempotency`, nên bản ghi lookup lưu `status_code: 200` cho create/media import vốn trả `201` (mô tả PR nói đã sửa nhưng chưa). Đã truyền `status`.
   - Bỏ import `jsonOk` không dùng trong `articles/[slug]/publish.ts`, `articles/[slug]/tags.ts` (astro check báo 2 hint mới ts6133).
   - Test: assert `status_code: 201` ở lookup REST, và receipt được replay nguyên vẹn trên `PUT` có key.

**Lưu ý cho controller:** nhánh #188 giờ chứa các commit của #182. Merge #182 trước, sau đó #188 (nếu squash #182, nội dung trùng nên merge #188 vẫn sạch). Nếu quyết định không merge #182, phải revert `e72ed8d` khỏi #188.

Sau khi push, GitHub báo #188 `MERGEABLE`.

### Gate (head `7bf9722`, đã gồm main + #182)
- `bun test`: **1101 pass / 0 fail** (62 file).
- `bun run build`: **0 errors, 0 warnings**, 66 hints (bằng main), build Complete.
- `tests/idempotency.test.ts`: 23 pass.

### Migration `0026_idempotency_keys.sql`
- Bảng `idempotency_keys(actor, key_hash, operation, request_hash, state CHECK in ('in_progress','done'), status_code, response_json, started_at, completed_at, expires_at)`, `PRIMARY KEY (actor, key_hash)`, index `idx_idempotency_keys_expires(expires_at)`. Dùng `IF NOT EXISTS`.
- Hoàn toàn additive, không đụng bảng cũ, an toàn để apply **trước** khi deploy code.
- Đụng số: `0026` cũng được dùng bởi #193 (`0026_article_cover.sql`) và #187 (`0026_article_localizations.sql`); `0025` do #168 và #189 giữ. Controller cần đánh số lại.

### Code có chịu được khi bảng chưa tồn tại?
- Request **không có key**: không chạm bảng, chạy như cũ.
- Request **có key** (hoặc `idempotency_lookup` / `GET /api/v1/admin/idempotency/{key}`): câu lệnh đầu tiên `DELETE FROM idempotency_keys ...` ném lỗi D1 "no such table", không phải `AppError`, nên trả `500 internal_error`. Lỗi xảy ra **trước** khi chạy write, nên không có ghi dở dang. Nghĩa là không fail-open nhưng là 500 chứ không phải 503 rõ nghĩa. Chấp nhận được nếu apply migration trước deploy (như PR yêu cầu).

### Review tính đúng đắn
- **Scope theo principal:** khoá là `(actor, sha256(key))`, actor = `principalActor()` thống nhất giữa REST (`requireAdminActor`), MCP (`mcpAdminActor`) và lookup. Lưu ý: mọi admin API key dùng chung actor `admin-api-key`, mọi Studio session dùng chung `studio-session`, nên key được chia sẻ giữa các key/phiên cùng loại. Không phải lỗ hổng (đều là admin) nhưng scope thô hơn chữ "per principal". Chỉ lưu hash của key, response chỉ đọc được bởi chính actor đó; auth kiểm tra trước replay.
- **Replay:** fingerprint = SHA-256 của canonical JSON `{operation, request}` (đã sắp key, bỏ `idempotency_key`), REST gồm path params, nên cùng key khác slug → 422. Replay trả body đã lưu + `idempotent_replay: true`, header `Idempotent-Replayed`. Document lớn hơn ~900 KB bị bỏ khỏi bản lưu (`document_omitted: true`), receipt vẫn giữ.
- **Race khi insert:** claim bằng `INSERT ... ON CONFLICT DO NOTHING` trên PK, nguyên tử trong D1/SQLite; request thứ hai nhận 409 `idempotency_in_progress`, khác request → 422. Takeover claim treo > 2 phút bằng `UPDATE ... WHERE started_at = ?` (CAS), release/complete cũng điều kiện theo `started_at`, nên claim bị chiếm lại không bị xoá nhầm.
- **Không atomic với revision bump:** issue #174 yêu cầu ghi bản ghi trong cùng `db.batch` với revision bump; PR dùng claim-then-run-then-record. Cửa sổ rủi ro: write đã commit nhưng ghi kết quả thất bại (đã retry 1 lần) → retry sau 2 phút sẽ chạy lại write, được chặn bởi `expected_revision` (update/publish/tags/edition delete), slug unique (create), hash dedup (media), còn `article_delete`/`media_delete` sẽ trả 404. Doc `docs/idempotency-keys.md` đã nêu. Chấp nhận được cho phase 0, nhưng khác với thiết kế ghi trong #174; nên ghi nhận như quyết định có chủ ý.
- **TTL/cleanup:** 24 giờ; purge cơ hội `DELETE ... WHERE expires_at < now` ở mỗi request có key (có index). Không có cron, bảng chỉ dọn khi có traffic có key. Ổn ở quy mô hiện tại.
- **Edge runtime:** chỉ dùng `crypto.subtle`, `TextEncoder`, D1; không có Node builtin. OK.
- **Tool access:** `idempotency_lookup` được đánh dấu admin-only trong `src/lib/oauth/tool-access.ts`; multipart upload từ chối key (400 `idempotency_unsupported`).
- Nit còn lại (không sửa): key nằm trong URL path của lookup route (có thể vào log), không có header `Retry-After` cho 409.

### File chồng với PR khác đang mở
- `src/lib/blocks/mcp.ts` (refactor thụt lề toàn bộ `call()` thành `callArticleTool`, **bề mặt xung đột lớn**): #193, #190, #187, #186, #158 (và #179). PR nào merge sau #188 mà sửa case trong switch cũ sẽ xung đột cả khối; giải quyết bằng cách áp lại thay đổi vào `callArticleTool`.
- `src/lib/blocks/articles.ts`: #193, #189, #182, #168, #158, #157.
- `src/lib/blocks/openapi.ts`: #193, #190, #189, #187, #186, #182, #168.
- `src/lib/oauth/tool-access.ts`: #193, #190, #189, #187, #186.
- `src/lib/mcp/registry.ts`: #189. `src/lib/media/media-mcp.ts`, `media-openapi.ts`: #193, #189.
- `src/pages/api/v1/articles/[slug].ts`: #190, #186, #182. `.../publish.ts`: #190, #186. `.../articles/index.ts`: #190.
- `README.md`: #193, #192, #190, #189, #187, #186, #168.

---

## Câu hỏi còn mở
1. Có mở follow-up issue để áp `WriteReceipt` (thêm `operation`) cho create/publish/tags_set/edition_delete ở cả MCP và REST, thay cho #179 không?
2. Chấp nhận mô hình claim-then-record của #188 (không cùng `db.batch` với revision bump như #174 mô tả) cho phase 0?
3. Có muốn trả 503 rõ nghĩa thay vì 500 khi bảng `idempotency_keys` chưa tồn tại không (chỉ quan trọng nếu deploy trước migration)?
