---
status: in-progress
created: 2026-10-01
branch: claude/zuey-membership-implementation-ev50kx
sources:
  - plans/handoffs/zuey-membership-implementation-20261001-1730.md
  - plans/handoffs/zuey-membership-new-scope-prompt-20261001.md
  - plans/visuals/explain-zuey-membership.html
---

# Plan tổng: Zuey membership + 4 yêu cầu bổ sung

Stack: Astro SSR + React islands trên Cloudflare Pages, D1 `zuey_me_db`. Mọi quyền kiểm tra ở server.
REST, MCP (`/api/mcp`), OpenAPI (`/api/openapi.json`) và Scalar (`/docs`) dùng chung một module nghiệp vụ cho từng tính năng.

## Quyết định đã chốt (theo phương án đề xuất trong prompt)

| Câu hỏi | Quyết định |
| --- | --- |
| LLM tóm tắt Reads | Cloudflare Workers AI qua binding `AI` (model `@cf/meta/llama-3.1-8b-instruct`). Không có binding thì sync báo lỗi `llm_unconfigured`, không ghi tóm tắt giả. |
| Google Meet | OAuth refresh token của lịch Zuey (`GOOGLE_CALENDAR_REFRESH_TOKEN`, dùng lại `GOOGLE_CLIENT_ID/SECRET`). |
| Lịch sync AnyMD | GitHub Actions schedule gọi `POST /api/v1/reads/sync` bằng admin key (`ZUEY_ADMIN_API_KEY`). |
| AnyMD lọc tag | Đã kiểm chứng qua `anymd.cc/api/v1/openapi.json`: `GET /library` trả `tags` (chuỗi cách nhau bởi dấu cách) nhưng KHÔNG có tham số lọc tag. Cơ chế giữ nguyên: phân trang toàn bộ bằng `before`/`next_cursor`, lọc `zuey-reads` phía server mình. |

## Phase và mapping

### Phase 1 — Nền tảng dùng chung
- `src/env.d.ts`: biến môi trường và binding mới.
- `src/lib/http.ts`: response JSON/lỗi chuẩn `{ success, error: { code, message } }`.
- `src/lib/auth.ts`: `authenticateAdmin` (session Studio hoặc API key role `admin`).
- `src/db/store.ts`: `D1RunResultLike` để đọc `meta.changes`.
- `tests/helpers/d1.ts`: adapter `bun:sqlite` chạy toàn bộ `migrations/*.sql`, test chạy trên SQL thật (partial unique index thật).

### Phase 2 — Zuey Reads (làm sớm, độc lập)
- Migration `0002_zuey_reads.sql`: bảng `reads` (`anymd_id` unique, `content_hash`, `summary`, `visible`, `synced_at`), bảng `reads_sync_runs`.
- `src/lib/reads/anymd-client.ts`, `src/lib/reads/summarizer.ts`, `src/lib/reads/sync.ts`, `src/lib/reads/store.ts`, `src/lib/reads/markdown.ts`.
- REST: `GET /api/v1/reads`, `POST /api/v1/reads/sync` (admin). Trang `/reads`, `/reads.md`.
- MCP: `reads_list`, `reads_sync`. OpenAPI + Scalar.
- `.github/workflows/reads-sync.yml`.
- Test: sync lần 2 nội dung không đổi gọi LLM 0 lần; bỏ tag → `visible=0`; thiếu `ANYMD_API_KEY` → lỗi trung thực.

### Phase 3 — Block editor + rich blocks + layouts (cùng phase editor)
- Migration `0003_articles_and_surveys.sql`: `articles` (blocks JSON, status draft|published, revision, access free|knowledges), `survey_votes` unique `(block_id, voter_key)`, `survey_rate_limits`.
- `src/lib/blocks/schema.ts` (discriminated union v1: paragraph, heading, list, checklist, quote, callout, code, divider, image, embed, table, chart, diagram, survey, layout), `validate.ts` (cols 1–5 theo `{base, md, lg}`, span ≤ cols, lồng ≤ 2 cấp), `markdown.ts`, `paywall.ts` (cắt ~1/3 ở server).
- Renderer `src/components/blocks/*`; chart/Mermaid chỉ dynamic import trong client island.
- Editor Studio `src/components/studio/ArticleEditor.tsx`; survey results + CSV.
- REST `/api/v1/articles`, `/api/v1/articles/{id}`, `/api/v1/surveys/{blockId}/vote|results|export.csv`. Trang `/articles`, `/articles/[slug]`, `/articles/[slug].md`.
- MCP: `article_list/get/create/update/publish/delete`, `survey_results`.
- Test: validate layout, 5 cột → 1 cột ở 375px (browser), survey 1 phiếu/người, rate limit, Markdown fallback.

### Phase 4 — Workflows (cùng phase MCP/REST)
- Migration `0004_workflows.sql`: `workflows` (name, slug, summary, tools, trigger, steps, metrics, tags, status, revision, deleted_at), `workflow_audit`.
- `src/lib/workflows/{schema,secret-scan,store,markdown}.ts`.
- REST `/api/v1/workflows`, `/api/v1/workflows/{slug}`, `/api/v1/workflows/{slug}/publish`. Trang `/workflows`, `/workflows/[slug]`, `/workflows/[slug].md`.
- MCP `workflow_list/get/create/update/delete/publish` (create/update chỉ draft + `expected_revision`; publish cần `confirm: true`; secret → chặn).
- Skill local `skills/zuey-me/workflows/` (SKILL + script redact, không upload raw session).
- Test: draft chứa secret bị chặn publish; revision conflict; viewer không thấy draft.

### Phase 5 — Payments + Booking Zuey for Business (cùng phase payments)
- Migration `0005_booking_and_payments.sql`: `availability_rules`, `availability_exceptions`, `bookings` (partial unique index `slot_start` WHERE status IN ('held','confirmed')), `payment_events` (idempotent).
- `src/lib/booking/{availability,store,ics}.ts`, `src/lib/payments/{polar,sepay}.ts`, `src/lib/integrations/{google-calendar,resend}.ts`.
- REST: `GET /api/v1/booking/slots`, `POST /api/v1/booking/hold`, `POST /api/v1/booking/{id}/checkout`, `GET /api/v1/booking/{id}`, `POST /api/v1/booking/{id}/reschedule`, admin `GET/PUT /api/v1/booking/availability`, `GET /api/v1/booking/admin`; webhooks `POST /api/webhooks/polar`, `POST /api/webhooks/sepay`.
- Trang `/business` (đặt lịch theo timezone khách), `/booking/[id]` (trạng thái, đổi lịch). Studio tab Booking.
- MCP: `booking_slots`, `booking_list`, `availability_get/set`.
- Test: 2 request đồng thời cùng slot → đúng 1 thành công; webhook thiếu tiền không confirm; webhook trùng idempotent; thanh toán sau khi hold hết hạn → `needs_attention`; đổi lịch 1 lần, ≥ 48h; thiếu credential → lỗi trung thực.

### Phase 6 — Phần còn lại của handoff gốc (membership lõi)
Bảng dưới là các mục của handoff gốc. Mục nào chưa làm trong lượt này được ghi rõ trạng thái, không bị âm thầm cắt.

| Mục handoff | Trạng thái |
| --- | --- |
| Pricing $9/$9/$19/$29, checkout SePay + thẻ (Dodo), entitlement | Đã triển khai (plan `261001-2351-zuey-membership-core`, wave A + B5). Polar bị loại vì không duyệt sản phẩm AI clone. |
| Paywall ~1/3 ở server cho article/.md/REST/MCP | Đã triển khai, theo entitlement `read_full`. |
| Identity thành viên, user API keys theo scope, OAuth `/mcp` | Đã triển khai (wave A + B1). |
| Dewee `zuey-ai` chat streaming, interactive code sandbox | Đã triển khai (wave D + B2). |
| Mascot sprite (codex CLI), GSAP, thời tiết, Duy notices | Đã triển khai (wave M + B4). |
| Telegram community, command palette, GitHub activity, privacy policy | Đã triển khai; Telegram chờ bot token và ID nhóm. |
| Taxonomy/tags công khai, audit nhãn bằng AI | Đã triển khai (wave B3). |

## Acceptance (Done means của prompt)
1. Mỗi tính năng: migration mới, test, OpenAPI + Scalar, MCP tool.
2. Hai request đồng thời cùng slot → đúng 1 thành công.
3. Sync lần hai không đổi → LLM 0 lần.
4. Draft chứa secret bị chặn publish.
5. Layout 5 cột → 1 cột ở 375px, không cuộn ngang.
6. Survey 1 phiếu/người.
7. Thiếu credential → lỗi trung thực.
8. `bun test` 0 fail, `bun run build` 0 lỗi 0 warning, browser 320/768/1440.
9. README liệt kê tên biến secret mới.

## Rủi ro
- Polar giữ `metadata` trên checkout và trả lại trong webhook `order.paid` (theo docs Polar); SePay không có metadata nên mã đặt chỗ được nhúng vào nội dung chuyển khoản (`ZBK<id>`), webhook đối chiếu theo mã này. Cần kiểm chứng bằng tài khoản thật.
- Session log thực tế trên máy Zuey chưa kiểm chứng; script skill đọc JSONL và bỏ qua dòng không parse được.
