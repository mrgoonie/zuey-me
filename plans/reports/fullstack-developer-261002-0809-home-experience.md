# Báo cáo triển khai: Wave B4, trải nghiệm trang chủ

- Ngày: 2026-10-02 (Asia/Saigon)
- Nhánh/worktree: `agent-ab41c21d703921ed4`, dựa trên `e6fd123`
- Trạng thái: hoàn thành. `bun test` 170 pass / 0 fail. `bun run build` 0 lỗi / 0 cảnh báo / 0 gợi ý. Đã kiểm tra trên trình duyệt ở 320/768/1440.

## Kết quả chính

### 1. Khung trang chủ
File: `src/components/home/HomeShell.tsx`, `src/pages/index.astro`.

- **Desktop (≥1280px):** ba cột. Bên trái là Zuey AI, ở giữa là hồ sơ hiện có, bên phải là Knowledges. Hai cột bên dính (sticky) khi cuộn.
- **Dưới 1280px:** thanh tab với `role=tablist`.
  - Có roving tabindex và hỗ trợ các phím ←/→/Home/End.
  - Trạng thái lưu trong hash `#ai`, `#profile`, `#knowledges` (dùng `replaceState`).
  - Vuốt ngang có chủ đích (≥80px, nhanh, thiên về chiều ngang) để chuyển tab. Thao tác vuốt bỏ qua mép màn hình (để dành cho cử chỉ back của hệ thống), ô nhập liệu, vùng cuộn ngang và biểu đồ.
- **Ẩn/hiện pane bằng CSS:** dựa vào `html[data-home-tab]`, được một script inline gán trước khi vẽ, nên không có nhảy bố cục.
- **Slot cho hai panel bên:** `aiPanel` và `knowledgePanel` (named slot của Astro). Hiện `index.astro` đặt placeholder trung thực "Zuey AI" và "Zuey's Knowledges", dẫn tới `/chat` và `/articles`.
- **Thanh trên cùng:** thời tiết, ngôn ngữ, Commands (Ctrl/⌘K), Account, nút ẩn/hiện Zuey (có chấm báo khi có thông báo của Duy đang chờ).
- **Chọn ngôn ngữ:** `LanguageSwitch` được viết lại thành menu 5 ngôn ngữ EN/VI/ZH/KO/JA.
  - Mỗi lựa chọn là link `?lang=` thật, nên chạy được cả khi không có JS.
  - Khi có JS: lưu cookie `zuey_locale`, mờ dần bằng GSAP, rồi điều hướng.
- **ProfileView:**
  - Nhận `locale`. Nội dung chỉ có bản en/vi; với zh/ko/ja sẽ hiển thị bản tiếng Anh kèm nhãn ghi rõ điều đó.
  - QR, Share, Studio và LinkCard giữ nguyên.
  - Footer có thêm link Privacy.

### 2. GSAP (`gsap@^3.15.0`)
- Chỉ tải động phía client, có chặn `import.meta.env.SSR`.
- **Hiệu ứng khi tải trang:**
  - Thanh trên và các pane lần lượt hiện lên.
  - Các khối bên dưới hiện ra khi cuộn tới (IntersectionObserver).
  - Có CSS dự phòng: nếu script không tải được, nội dung vẫn hiện sau khoảng 1,1 giây.
- **Chuyển tab:** có hiệu ứng trượt theo hướng.
- **Micro-interaction:** nhấn `[data-press]` có độ đàn hồi; hover `[data-lift]` thì khối nhấc lên.
- **Thời tiết:** chuyển tông màu mượt. Danh sách hoạt động GitHub có cột mọc dần.
- **Giảm chuyển động (reduced motion):** chuyển trạng thái tức thì, video nền dừng, không có hạt mưa/tuyết.
- **CLS đo được:** khoảng 0,0003–0,0009, đều do Google Fonts swap trong `Layout.astro` (đã có từ trước). Khung trang, tab và animation không gây layout shift.

### 3. Linh vật Zuey
File: `Mascot.tsx`, `mascot-manifest.ts`.

- Chạy theo `manifest.json`: idle/blink, đi bộ có lật hướng, và các biểu cảm wave/talk/think/happy/surprised.
- Kéo thả được bằng chuột và cảm ứng.
- Là một nút có thể focus:
  - Enter/Space: vẫy tay và hiện bong bóng.
  - Phím mũi tên: di chuyển (24px, hoặc 72px khi giữ Shift).
- Tự đi lang thang nhưng tránh ô nhập liệu, phần tử đang focus và các vùng `[data-mascot-avoid]`. Tự né khi người dùng đang gõ.
- Nút tạm dừng / ẩn / khôi phục, lưu trong localStorage (có try/catch).
- Bong bóng có hai loại:
  - Mẹo ambient: tối đa 4 lần mỗi lượt truy cập.
  - "Notice from Duy": có nhãn riêng.

### 4. Thời tiết
- Endpoint `GET /api/v1/weather` dùng Open-Meteo, không cần khoá.
- **Mặc định tắt.** Người dùng có thể:
  - nhập tên thành phố, hoặc
  - chủ động cho phép geolocation; toạ độ được làm tròn 1 chữ số thập phân và chỉ lưu ở client.
- Có trạng thái cho các trường hợp: offline, bị từ chối quyền, trình duyệt không hỗ trợ, không tìm thấy thành phố, lỗi.
- **Lớp nền thời tiết:** tông màu, mây, và hạt mưa/tuyết vẽ bằng canvas, đặt trên `loop.mp4` (z -5, nằm dưới nội dung). Linh vật cũng phản ứng theo thời tiết.

### 5. Thông báo của Duy
- **Migration `0010_notices_and_community.sql`.**
- **Admin REST:**
  - `GET/POST /api/v1/notices`
  - `POST /api/v1/notices/{id}/expire`
- **MCP:** `notice_send`, `notice_list`, `notice_expire` (chỉ admin).
- **Public:** `GET /api/v1/notices/active`.
- **Phía client:**
  - Chọn thông báo đang hiệu lực và chưa bị đóng (`notice-queue.ts`).
  - Áp dụng TTL chính xác bằng timer.
  - Danh sách thông báo đã đóng lưu trong localStorage và tự dọn khi thông báo hết hạn, nên thông báo đã đóng không bao giờ hiện lại.
  - Không bật lên khi người dùng đang gõ.

### 6. Command palette (Ctrl/⌘K, kèm nút hiển thị trên mobile)
- Dùng `<dialog>` modal (giữ focus bên trong, xử lý Escape) với combobox/listbox và `aria-activedescendant`.
- Có danh sách mục gần đây và chế độ tìm bài viết.
- Các hành động: chat, tìm bài, MCP, pricing, subscribe (`/login?next=/pricing`), account, GitHub activity, API docs, API keys (`/account#keys`), privacy, business.
- **Hộp thoại MCP:** có snippet cho Claude Code, Claude, ChatGPT, Cursor và API key.
  - Chỉ hiển thị placeholder `<YOUR_ZUEY_API_KEY>`, không bao giờ hiện khoá thật.
  - Khi không copy được, snippet được bôi chọn sẵn để người dùng tự copy.

### 7. "Zuey đang làm gì"
- **Endpoint `/api/v1/github/activity`:**
  - Lấy 3 trang × 100 sự kiện, dùng ETag/304.
  - Cache API 15 phút; khi upstream lỗi thì trả bản cũ kèm `error`.
  - Có xử lý rate-limit.
- **UI:**
  - Biểu đồ cột theo ngày, ghi rõ là public events (không phải lịch contribution). Bấm vào ngày để lọc, có điều hướng bằng bàn phím.
  - Danh sách sự kiện có ngày giờ theo Asia/Saigon, hiện 12 mục đầu và có nút "xem tất cả".
  - Có đủ trạng thái loading, rate-limit, offline, dữ liệu cũ và nút thử lại.

### 8. Các trang và khối nội dung
- **`/privacy`:**
  - Bản tiếng Việt là bản gốc, kèm bản tiếng Anh.
  - Nêu rõ: KHÔNG dùng dữ liệu cá nhân cho mục đích khác; không bán dữ liệu, không quảng cáo nhắm mục tiêu, không huấn luyện mô hình khi chưa được đồng ý; cách ly dữ liệu theo người dùng; admin có quyền truy cập chat và việc truy cập được ghi audit.
  - Bảng các bên xử lý: Cloudflare, Resend, SePay, Polar, Dewee/nhà cung cấp mô hình, Google, GitHub, Telegram, Open-Meteo, PostHog.
  - Phần lưu giữ / sao lưu / xoá được đánh dấu "đang hoàn thiện". Không có cam kết zero-retention.
- **Khối "Dành cho doanh nghiệp":** $1,999, được trừ vào gói đồng hành 3–6 tháng, dẫn tới `/business`.
- **Teaser giá:** lấy giá từ `PLANS`, dẫn tới `/pricing`.

### 9. Cộng đồng Telegram
- **Các endpoint:**
  - `GET /api/v1/community`
  - `POST /community/invite`: link một lần dùng, `member_limit=1`, hết hạn sau 1 giờ.
  - `POST /community/sweep` (admin) và MCP `community_sweep`: gỡ thành viên đã hết hạn gói bằng ban rồi unban.
  - `POST /community/telegram-webhook`: nhận sự kiện `chat_member`, dùng secret header.
- Trả 503 `community_unconfigured` (kèm danh sách biến còn thiếu) khi chưa cấu hình.
- **`CommunityAccess.tsx`** dành cho trang account. Xử lý các trạng thái: chưa đăng nhập, chưa có gói, chưa cấu hình, và đủ điều kiện.

### 10. Đăng ký và kiểm thử
- OpenAPI fragment (tag "Homepage experience") và MCP module đã được đăng ký vào registry.
- Biến môi trường khai báo trong `env.d.ts` và `.env.example`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_EN_ID`, `TELEGRAM_GROUP_VI_ID`, `TELEGRAM_WEBHOOK_SECRET`.
- `tests/experience.test.ts` có 22 test, gồm cả test cho manifest linh vật, notice queue và các parser phía client.

## Kiểm tra trên trình duyệt
Dùng Playwright + Chromium với `bun run dev --port 4334`. Server đã được dừng sau khi kiểm tra.

| Hạng mục | Kết quả |
|---|---|
| Tràn ngang ở 320/768/1440 | 0 |
| Pane hiển thị | 320/768: chỉ Profile, có tab. 1440: đủ 3 cột, không có tab |
| Lỗi console (trang chủ) | Không có |
| Chỉ dùng bàn phím | Skip link xuất hiện đầu tiên. Thứ tự Tab hợp lý. Mũi tên đổi tab và cập nhật hash. Ctrl+K mở palette, lọc, Escape đóng và trả focus. MCP giữ focus trong dialog. Linh vật: Enter hiện bong bóng, mũi tên di chuyển |
| Reduced motion | Không có class pending, nội dung hiện ngay (opacity 1), video dừng |
| Locale | `?lang=ja` cho `html lang=ja` kèm nhãn fallback. `?lang=vi` không có nhãn |
| Thông báo Duy (seed local, đã xoá sau) | Bong bóng "Notice from Duy" hiện. Đóng xong reload thì không hiện lại |
| Ẩn/khôi phục linh vật | Giữ nguyên sau khi reload |
| Vuốt (synthetic touch) | Profile → AI → Profile. Vuốt ở mép bị bỏ qua. Profile → Knowledges |
| API | weather Hanoi 200, toạ độ sai 400, github activity 200 (dữ liệu thật), community 200 (`signed_in:false`), privacy 200 (vi/en) |

## Lưu ý và việc cần làm tiếp
- **Đã sửa file dùng chung ngoài danh sách sở hữu** (mỗi file thêm 1 dòng hoặc 1 khối nhỏ; có thể conflict khi merge):
  - `src/lib/mcp/registry.ts`, `src/lib/openapi/registry.ts`, `src/env.d.ts`, `.env.example`.
  - Ngoài ra có thư mục mới `src/lib/experience/**`.
  - Không chạm vào `Layout.astro` và `global.css`.
- **Placeholder chờ thay:** integrator cần thay hai placeholder bằng `ZueyAiPanel({locale})` và `KnowledgesPanel({locale})`, và mount `CommunityAccess` vào trang `/account`.
- **Phụ thuộc wave khác:**
  - `/mcp` (OAuth) do B1 cung cấp; `/chat` do B2 cung cấp. Worktree này chưa có hai route đó.
  - Ô tìm bài trong palette gọi `/api/v1/articles?q=` và lọc thêm ở client. Ở D1 local endpoint này đang trả 500 vì thiếu bảng của articles. UI hiện thông báo "không tìm được" một cách gọn gàng.
- **Rủi ro GitHub API không xác thực:** giới hạn 60 req/giờ trên IP dùng chung của Cloudflare. Đã có cache 15 phút, memo khi bị chặn và trả dữ liệu cũ.
- **Telegram:** cần đặt webhook (`setWebhook` với `secret_token` và `allowed_updates=["chat_member"]`, xem `.env.example`). Cần cron gọi `/api/v1/community/sweep`.
- **Migration 0010:** cần chạy remote bằng `wrangler d1 execute zuey_me_db --remote --file=./migrations/0010_notices_and_community.sql -y`.
- **Privacy:** câu "truy cập chat của admin được ghi audit" phụ thuộc vào việc B2 thực sự ghi log đó. Thời hạn lưu giữ và quy trình xoá đang để "đang hoàn thiện".
- **Môi trường kiểm tra:** sandbox Bash của phiên bị lỗi môi trường ("expo: command not found"), nên lệnh được chạy với sandbox tắt, chỉ trong worktree và thư mục scratchpad.

Status: DONE_WITH_CONCERNS
Summary: Đã hoàn thành khung trang chủ ba cột/tab, GSAP, linh vật, thời tiết, thông báo của Duy, command palette + MCP, GitHub activity, /privacy, khối business/pricing, cộng đồng Telegram cùng OpenAPI/MCP và test. Test và build đều sạch, đã kiểm tra trên trình duyệt ở cả ba kích thước.
Concerns/Blockers: Có sửa 4 file dùng chung (registry/env). Integrator cần thay placeholder và mount CommunityAccess. Còn phụ thuộc B1 (/mcp), B2 (/chat, audit log) và tìm kiếm bài viết của B3. Cần cấu hình webhook/cron Telegram và chạy migration 0010 remote.
