# Review PR #157 và #158 (article writers atomic + lỗi race)

Ngày: 2026-10-19 (Asia/Saigon). Main lúc review: `571f471`.

## Tóm tắt

| PR | Nhánh | Đóng | Verdict |
| --- | --- | --- | --- |
| #157 | `fix/145-atomic-article-writers` | #145 | **MERGE** |
| #158 | `fix/146-article-update-race-errors` | #146 | **MERGE** (merge sau #157) |

- **#158 được xếp chồng (stacked) lên #157**: nhánh của #158 chứa sẵn commit `2354cb7` của #157 và thêm `e86d2c7`. Cả hai có cùng merge-base `886ee1c` (12/10). Gộp "#157 + #158" chính là cây của #158.
- Từ base tới main, `src/lib/blocks/articles.ts` chỉ có thêm #153 (paywall) nên cả hai merge `origin/main` **sạch, không xung đột**.
- Không có migration nào.
- Không tìm thấy lỗi đúng/sai cần sửa, nên không push commit sửa code. Tôi chỉ push merge commit `origin/main` (merge thường, không force):
  - #157: `2354cb7..85896c6` (`Merge branch 'main' into fix/145-atomic-article-writers`)
  - #158: `e86d2c7..b369e2b` (`Merge branch 'main' into fix/146-article-update-race-errors`)

## Kết quả gate (trên kết quả đã merge `origin/main`)

| Cây | `bun test` | `bun run build` |
| --- | --- | --- |
| #157 + main (`85896c6`) | 1084 pass, 0 fail | astro check 0 errors, 0 warnings, build Complete |
| #158 + main (`b369e2b`, = #157 + #158 + main) | 1088 pass, 0 fail | astro check 0 errors, 0 warnings, build Complete |

Ghi chú: ở lần chạy đầu, khi chạy song song hai worktree, mỗi cây có 1 test timeout 10 giây ở file không liên quan: `tests/experience.test.ts` (GitHub activity 503) và `tests/channel-access.test.ts`. Chạy riêng hai file đó (93/97 pass) rồi chạy lại cả suite tuần tự thì cả hai cây đều 0 fail. Đây là test chập chờn do máy bị tải, không phải hồi quy.

## PR #157: review tính đúng đắn

Thay đổi (`src/lib/blocks/articles.ts`): `publishArticle`, `deleteEdition` và `setTagsForArticle` dùng chung khuôn của #142 qua các helper `AT_EXPECTED`, `guardedRevisionStatement`, `guardedTagStatements`, `bumpRevisionStatement`, `commitAtRevision`. `mirrorPrimary` (chạy rời) bị xoá.

Đã kiểm:
- **Ngữ nghĩa D1 batch**: một batch là một transaction, các câu chạy tuần tự, một câu lỗi thì rollback toàn bộ. Mọi write đứng trước câu bump đều mang điều kiện `EXISTS (... revision = expected AND deleted_at IS NULL)`. Câu bump là CAS `WHERE revision = ?`, nằm ở chỉ số `writes.length`, nên `results[writes.length].meta.changes` kiểm đúng câu bump. Phần derived (`mirrorPrimaryStatement`) chạy sau bump nên đọc được trạng thái mới; nếu thua race thì nó chỉ đồng bộ lại cột legacy, vô hại.
- **Publish**: `published_json = draft_json` được copy ngay trong batch có guard, nên draft được publish đúng là bản đã đọc (cùng với `wordCount`/`firstImage`). Một save chen vào sẽ bump revision trước, và publish trả 409. Test xác nhận cả hai chiều.
- **deleteEdition**: thêm guard `deleted_at IS NULL` trong `AT_EXPECTED`, nên một `deleteArticle` (không bump revision) chạy song song cũng chặn được write.
- **setTagsForArticle**: `guardedTagStatements` giữ nguyên ngữ nghĩa của `setArticleTags` (`src/lib/taxonomy/tags.ts:217`): DELETE rồi `INSERT OR IGNORE` theo position. `mirrorLegacyTags` được dời ra sau commit.
- Envelope lỗi vẫn là `AppError(409, 'revision_conflict', ..., { current_revision })` → `errorResponse` trong `src/lib/http.ts:38`. Không đổi chữ ký hay shape response. OpenAPI đã liệt kê 409 sẵn.
- Test (`tests/article-update-atomic.test.ts`) chạy trên SQLite thật. `tests/helpers/d1.ts:50` bọc batch trong `db.transaction`, đúng hợp đồng D1, nên các test inject failure bằng trigger là hợp lệ.

Nhận xét không chặn merge:
- `conflict(db, slug)` ở #157 vẫn tra theo slug, nên trên riêng #157 một rename chen vào sẽ trả 404 thay vì 409. #158 đã sửa điểm này.
- Ở `setTagsForArticle`, `publishArticle` và `deleteEdition`, các bước sau commit (`mirrorLegacyTags`, `reindexArticle`) vẫn ném lỗi ra thành 500 dù dữ liệu đã commit. Hành vi này đã có từ trước PR. Xem phần follow-up.

## PR #158: review tính đúng đắn

Commit riêng `e86d2c7`:
1. **Race slug** (`articles.ts` ~798-804): bọc `commitAtRevision` bằng try/catch. Khi `nextSlug !== art.slug` và lỗi chứa `UNIQUE constraint failed: articles.slug` thì trả `AppError(409, 'slug_taken')`. Ràng buộc tới từ `slug TEXT NOT NULL UNIQUE` (`migrations/0003_articles_and_surveys.sql:6`), nên thông điệp SQLite/D1 có đúng chuỗi `articles.slug`. Cách nhận diện bằng message giống mẫu sẵn có ở `src/lib/booking/store.ts:148` và `src/lib/members/runtime.ts:93`. Batch đã rollback nên không có ghi dở.
2. **Race rename**: `conflict()` nay tra theo `id` và trả `current_revision` qua `n(current, 'revision')`, không cast. Fix này áp dụng cho cả 4 writer vì đều đi qua `commitAtRevision`.
3. **Side effect sau commit** của `updateArticle`: `afterCommit` chỉ log `console.error` (không log secret hay dữ liệu) và trả thành công. Cả hai tác vụ đều idempotent và được lần save sau hoặc `search_reindex` dựng lại.
4. Mô tả MCP `article_update` (`src/lib/blocks/mcp.ts:151`) thêm `409 slug_taken`. `toolCatalogVersion` của #181 là digest tính lúc chạy, không có giá trị hardcode nên không vỡ test.

Không thấy lỗi. Quy tắc TypeScript (không `any`, không cast inline) được tuân thủ.

## Merge #157 + #158 cùng nhau

- Nếu merge thường theo thứ tự #157 rồi #158: không xung đột, vì #158 đã chứa #157.
- **Main dùng squash merge** (các commit có hậu tố `(#NNN)`). Tôi mô phỏng squash #157 lên main rồi merge nhánh #158. Kết quả: **xung đột** ở `src/lib/blocks/articles.ts` (các chỗ `commitAtRevision(db, slug|art.id, ...)` và khối try/catch slug) và `tests/article-update-atomic.test.ts`, do cùng nội dung xuất hiện qua hai lịch sử khác nhau.
  - **Cách giải**: lấy toàn bộ phía #158 (`git checkout --theirs src/lib/blocks/articles.ts tests/article-update-atomic.test.ts`). Tôi đã kiểm: cây sau khi giải **giống hệt** cây `b369e2b` (diff rỗng), mà cây đó đã qua gate.
  - Cách khác đơn giản hơn: chỉ squash #158 (thêm `Closes #145` vào body) và đóng #157 vì đã được bao gồm. Hoặc sau khi squash #157, merge `main` vào #158 và giải xung đột như trên.

## File chung với các PR đang mở khác

Kiểm bằng cách merge thử từng PR lên `b369e2b` (#157 + #158 + main):

| PR | File chung | Xung đột với #158? | Ghi chú |
| --- | --- | --- | --- |
| #168 (`…xb30qi`) | articles.ts | **Có** (articles.ts) | Sạch với main. Đụng `publishArticle` (thêm `published_title`/`published_excerpt`/`published_modified_at`) và khối re-create edition (dùng `atExpected` cũ). |
| #189 (`…e97tyh`) | articles.ts | **Có** (articles.ts, README) | Đụng `publishArticle` (`managedCoverUrl`); vẫn gọi `recordRevision`/`mirrorPrimary` rời. |
| #182 (`…pzeh9r`) | articles.ts, mcp.ts | Có (mcp.ts) | Sạch với main. |
| #193 (`…dtin5m`) | articles.ts, mcp.ts | Chỉ README | README cũng xung đột với main. |
| #179, #186, #190 | mcp.ts | Có (mcp.ts) | Sạch với main. Gần như chắc chắn cùng dòng mô tả `article_update`. |
| #188 | mcp.ts | Có (mcp.ts, README) | |
| #187 | mcp.ts | Chỉ README | |

Hướng giải cho #168/#189 khi merge sau #157/#158: giữ cấu trúc `commitAtRevision([...guarded writes], bumpRevisionStatement, [mirrorPrimaryStatement])`. Chuyển các cột mới và `coverUrl` vào câu UPDATE có guard (`AND ${AT_EXPECTED}`, bind thêm `art.id, expected`). Đổi `atExpected` thành `AT_EXPECTED`. Bỏ các lời gọi `recordRevision`/`mirrorPrimary` rời: `mirrorPrimary` không còn tồn tại, giữ lại sẽ lỗi typecheck. `managedCoverUrl` được await trước batch, như vậy vẫn ổn.

## Migration

Không có.

## Đề xuất follow-up (issue riêng, không mở rộng PR này)

1. `publishArticle`, `deleteEdition`, `setTagsForArticle`: bọc `mirrorLegacyTags`/`reindexArticle` sau commit bằng `afterCommit`, giống `updateArticle`, để không trả 500 khi dữ liệu đã commit. Lưu ý `applyPublishNotification` là write thật, không nên nuốt lỗi.
2. `createArticle` cũng có race slug (kiểm tra rồi INSERT), hiện trả 500 thay vì `409 slug_taken`.

## Câu hỏi còn mở

- Controller muốn squash #157 rồi #158 (phải giải xung đột như trên), hay chỉ squash #158 và đóng #157?
