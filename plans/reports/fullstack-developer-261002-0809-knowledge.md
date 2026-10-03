# Báo cáo triển khai — Wave B3: Zuey's Knowledges

Ngày: 2026-10-02 (Asia/Saigon) · Worktree: `.claude/worktrees/agent-a1aa45a826bb08876` · Đã commit, chưa push.

## Kết quả

Toàn bộ phạm vi B3 đã hoàn tất: phiên bản bài viết theo ngôn ngữ, trang khám phá `/articles`, tìm kiếm phân quyền trước khi xếp hạng, trình soạn khối kiểu Notion trong Studio, taxonomy kèm đề xuất nhãn bằng AI, chia sẻ, SEO/GEO, cùng REST/OpenAPI/MCP cho mọi tính năng.

- `bun test`: 209 pass, 0 fail (9 file; `tests/knowledge.test.ts` có 61 test).
- `bun run build`: `astro check` 245 file cho 0 errors, 0 warnings, 0 hints; build thành công.
- Migration local D1: đã áp dụng lần lượt 0001 → 0006 → 0009 bằng `wrangler d1 execute zuey_me_db --local`, không lỗi, và đã xác nhận các bảng `article_editions`, `article_labels`, `knowledge_fts`, `taxonomy_*` tồn tại. Hai migration 0007/0008 thuộc các wave song song nên không có trong worktree này.

## Commit

| Commit | Nội dung |
|---|---|
| `eea5f4f` feat(knowledge): add locale editions, authorized search and taxonomy APIs | migration 0009, `src/lib/{blocks,search,taxonomy}`, API articles/search/taxonomy, sitemap, đăng ký MCP/OpenAPI |
| `960484f` feat(knowledge): add article discovery, media blocks, sharing and SEO markup | `src/components/{blocks,knowledge}`, `src/pages/articles/**` |
| `788f3c1` feat(studio): add block article editor and taxonomy review tools | `ArticleEditor.tsx`, `ArticleLabelsPanel.tsx`, `TaxonomyReviewPanel.tsx`, `TaxonomyManager.tsx`, `knowledge-studio-kit.tsx` |
| `c165b8d` test(knowledge): cover paywall leakage, search authorization, labels and locales | `tests/knowledge.test.ts` |

## Phạm vi test (`tests/knowledge.test.ts`)

- **Ma trận rò rỉ paywall** cho 4 vai trò (ẩn danh, thành viên không gói, thành viên Knowledges qua API key `articles:read`, admin). Mỗi vai trò được kiểm tra trên HTML loader (`resolveViewer` + `getArticleView` + render `BlockRenderer`), `.md`, REST, MCP `article_get` (JSON và markdown), snippet tìm kiếm REST/MCP và `/api/v1/articles?q=`. Bốn token chỉ có trong phần trả phí không bao giờ xuất hiện với người không có quyền. JSON-LD khai báo `isAccessibleForFree: false` cùng `hasPart`.
- **FTS phân quyền trước khi xếp hạng**:
  - Từ khoá chỉ có trong phần trả phí trả về 0 kết quả với người không có quyền.
  - Thử với một Vectorize giả cố tình trả về vector tier `full`: kết quả vẫn bị loại, và filter `{tier:{$in:["free","preview"]}}` được truyền vào.
- **Tag**:
  - trùng tên/alias trả về `tag_conflict`
  - slug sai, tên quá 40 ký tự, quá 20 tag mỗi bài đều trả về 400
  - `unknown_tag` trên `PUT /tags`
  - khi lưu bài, tên mới sẽ tạo tag mới
  - CAS `revision_conflict`
  - facet công khai chỉ hiện tag của bài đã xuất bản
- **Nhãn**:
  - fact không có bằng chứng bị từ chối khi áp dụng thủ công, và bị hạ xuống needs-review kèm câu hỏi trong đề xuất
  - với luồng đề xuất → duyệt: `label_revision_conflict`, sau đó áp dụng thành công, duyệt lại trả về `already_applied`
  - revert tạo revision mới; revert dựa trên revision cũ trả về 409
  - nội dung đổi sau khi đề xuất thì đề xuất trả về `edition_changed` và chuyển sang `stale`
  - audit job: không có AI binding thì trả 503 `ai_unavailable`; với AI giả, job chạy theo lô có cursor cho tới `completed`
- **Phiên bản ngôn ngữ**:
  - `?lang=en` và fallback `locale_fallback`
  - bản nháp `ko` không lộ ra
  - header `Link` có canonical cùng hreflang (vi/en/x-default) và có `Content-Language`
  - sitemap có alternates
  - không xoá được phiên bản chính
- **Nhúng nội dung**: nhận diện URL cho 9 nhà cung cấp, cùng các trường hợp generic, http và URL thiếu id.
- **Markdown fallback**: đủ 22 loại khối, kèm khẳng định danh sách khớp `BLOCK_TYPES`.
- **Đăng ký**: các path OpenAPI và tool MCP; ghi qua MCP taxonomy bắt buộc quyền admin.

## Sửa lỗi phát hiện khi viết test

`adminRoute` (`src/lib/taxonomy/routes.ts`) từng trả 400 `invalid_json` cho POST không có body. Lỗi này làm hỏng nút "Chạy 1 lô" và "Huỷ" trong Studio, vì các nút đó gửi POST không kèm body. Giờ body rỗng được coi là `{}`, còn body có nội dung nhưng không phải JSON object vẫn bị từ chối (đã có test).

## Quyết định và sai khác so với đặc tả

1. **`searchKnowledge(principal, query, locale, limit, env)`** có thêm tham số thứ năm `env`, khác chữ ký trong đặc tả. Hàm cần `env.DB`, `env.AI` và `env.VECTORIZE`; không có `env` thì không thể truy cập D1 và binding mà không dùng biến toàn cục.
2. **`wrangler.toml` không bị sửa.** Tìm kiếm ngữ nghĩa là tuỳ chọn; thiếu binding thì chạy BM25 và trả `semantic: false`. Để bật trên production:
   ```
   wrangler vectorize create zuey-knowledge --dimensions=1024 --metric=cosine
   wrangler vectorize create-metadata-index zuey-knowledge --property-name=tier --type=string
   wrangler vectorize create-metadata-index zuey-knowledge --property-name=locale --type=string
   ```
   Sau đó bind index với tên `VECTORIZE` (Pages → Settings → Bindings, hoặc khối `[[vectorize]]`) cùng binding `AI`, rồi gọi `POST /api/v1/search/reindex` một lần. Metadata index phải được tạo **trước** khi chèn vector, vì bộ lọc tier nằm ngay trong truy vấn Vectorize. Model embedding là `@cf/baai/bge-m3`.
3. **Không có endpoint lấy OG preview cho bookmark.** Một endpoint như vậy sẽ fetch URL tuỳ ý từ phía server (rủi ro SSRF). Tiêu đề, mô tả và site của bookmark do người soạn tự nhập.
4. **Chuỗi giao diện của embed và media chỉ có tiếng Việt**, chưa tách theo locale.
5. **Giao diện taxonomy trong Studio** là các tab con trong `ArticlesPanel` (Bài viết / Duyệt nhãn AI / Tags·Danh mục·Nhãn), vì `StudioApp.tsx` không thuộc phạm vi sở hữu của wave này.
6. **Chưa cập nhật tài liệu trong `docs/`** vì nằm ngoài danh sách file sở hữu. OpenAPI (`/api/openapi.json`) đã đầy đủ các path mới và là nguồn tham chiếu máy đọc được.
7. **Tương thích với B2 (khối `interactive`)**: schema chỉ mở rộng theo kiểu union. Trình soạn dùng `Partial<Record<BlockType,…>>`, `newBlock` trả `null` với loại chưa biết, và trường của loại chưa biết hướng người dùng sửa ở tab JSON.

## Kiểm tra trình duyệt

Agent này không có công cụ điều khiển trình duyệt, nên **chưa kiểm tra trực quan ở 320/768/1440px**. Thay vào đó đã chạy `bun run dev --port 4333` và smoke test bằng HTTP:

- `/articles`, `/articles?q=…&tag=…`, `/articles?lang=en` trả 200; trạng thái rỗng và liên kết "Đặt lại" hiển thị; không có dropdown quyền đọc.
- Bài không tồn tại trả 404 cho cả `.md` lẫn HTML.
- `/api/v1/search` trả 200, và 400 khi `q` rỗng.
- `/api/v1/taxonomy` trả 200; `/api/v1/taxonomy/tags` trả 401 khi chưa đăng nhập.
- `/sitemap.xml`, `/api/openapi.json` (có đủ path taxonomy) và `/studio` đều trả 200.

Dev server đã được dừng (PID 92068 và các tiến trình con); cổng 4333 đã trống.

## Status

Status: DONE_WITH_CONCERNS
Summary: Wave B3 Knowledges đã hoàn tất và được commit trong 4 commit; `bun test` 209/0 và `bun run build` 0/0/0; migration áp dụng sạch trên local D1.
Concerns/Blockers: Chưa kiểm tra trực quan responsive 320/768/1440 vì không có công cụ trình duyệt (chỉ smoke test HTTP). `searchKnowledge` có thêm tham số `env`. Vectorize cần cấu hình thủ công theo các bước trên. Chưa có migration 0007/0008 của các wave song song trong worktree này, nên cần chạy lại toàn bộ test sau khi merge.
