---
status: in-progress
created: 2026-10-01
branch: claude/zuey-membership-implementation-ev50kx
parent: plans/261001-1931-zuey-membership-master-plan/plan.md
sources:
  - plans/handoffs/zuey-membership-implementation-20261001-1730.md
  - plans/visuals/explain-zuey-membership.html
---

# Plan: membership lõi (Phase 6 của master plan)

## Mục tiêu

Triển khai toàn bộ các mục còn lại trong bảng "User-requested product scope" của handoff gốc. Sau đó deploy production, chạy migration remote (đã có backup) và kiểm tra trên browser.

**Ràng buộc:**

- Giữ giá và scope như handoff.
- Mọi kiểm tra quyền chạy ở server.
- Secrets chỉ nằm trong env.
- Không có dữ liệu giả.
- Integration nào chưa cấu hình phải trả lỗi 503 rõ ràng.

## Quyết định của user (2026-10-01)

- **Polar bị loại tạm thời**, vì Polar từ chối sản phẩm AI clone.
  - Chỉ dùng SePay (VND).
  - Booking chỉ hiển thị các cổng đã cấu hình.
  - Polar bị gỡ hoàn toàn khỏi code (user chốt ngày 2026-10-02), thay bằng Dodo + PayPal (xem `plans/reports/researcher-261001-2351-polar-alternatives.md`).
- **Ngân hàng nhận tiền SePay:** ACB ****9829 (CTY TNHH MTV DIGITOP). `USD_VND_RATE=26000`.
- **Cổng thẻ thay Polar:**
  - Dodo Payments cho gói membership.
  - PayPal Business cho buổi tư vấn $1,999 (các nhà cung cấp merchant-of-record đều cấm dịch vụ consulting).
  - Cả hai chỉ bật khi đã có key.
- **Cloudflare:** user chốt chuyển toàn bộ production về tài khoản Digitop (`009dc…`), nơi đang giữ zone DNS `zuey.me`. Project và D1 cũ hiện nằm ở NextLevelBuilder. Các bước cutover:
  1. Export lại D1 cũ.
  2. Tạo D1 `zuey_me_db` trên Digitop, import dữ liệu, rồi chạy migrations 0002+.
  3. Tạo Pages project trên Digitop, set secrets từ `.env`, deploy.
  4. Gỡ `zuey.me` và `www` khỏi project cũ, gắn sang project mới, cập nhật CNAME.
  5. Cập nhật `database_id` trong `wrangler.toml` và GitHub secrets `CLOUDFLARE_*`.
  6. Sau khi cutover và verify thành công: xoá Pages project `zuey-me` và D1 `zuey_me_db` ở NextLevelBuilder (user đã đồng ý ngày 2026-10-02). Backup D1 giữ ở `D:/www/zuey/backups/`.
- **Được phép chủ động** chạy migration remote và deploy. Phải backup D1 trước mỗi lần thay đổi schema.

## Quyết định thiết kế

| Vấn đề | Quyết định |
| --- | --- |
| Danh tính | Bảng `users`. Đăng nhập bằng Google OAuth, GitHub OAuth (dùng lại client hiện có) hoặc magic link qua Resend. Chỉ email đã xác minh mới được tính. |
| Admin | Email đã xác minh nằm trong allowlist `ADMIN_EMAILS`, mặc định `goon.nguyen@gmail.com` và `duy@wearetopgroup.com`. Session Studio cũ vẫn được coi là admin. |
| Session | Cookie `zuey_member` (HttpOnly, Secure, SameSite=Lax). Server lưu hash của token. Request thay đổi dữ liệu bằng cookie phải có `Origin` cùng site (CSRF). |
| Gói | `knowledges` $9, `ai` $9, `combo` $19, `community` $29, đều tính theo tháng. Mỗi gói cấp entitlement: knowledges → `read_full`; ai → `ai_chat`; combo → cả hai; community → cả hai + `community`. |
| AI-only | Có `ai_chat` nhưng không có `read_full`. Chat được trích dẫn nhưng không trả full text của bài trả phí. |
| Thanh toán gói | SePay chuyển khoản trả trước 1/3/6/12 tháng, chiết khấu 0/5/10/20%. Giá VND = USD × `USD_VND_RATE`, làm tròn lên bội số 1.000. Order code `ZSB…` nằm trong nội dung chuyển khoản. Webhook SePay đối chiếu và gia hạn `current_period_end`. |
| Đối soát | Admin gọi endpoint reconcile. Endpoint dùng `SEPAY_API_TOKEN` để đọc giao dịch gần đây và khớp với các order đang chờ. Endpoint này là phương án dự phòng khi webhook lỗi. |
| Email | Resend gửi từ `hi@zuey.me` (`RESEND_FROM`) cho magic link, biên nhận, nhắc gia hạn và đổi email. Gửi idempotent theo khóa sự kiện. |
| User API key | Token có prefix `zk_`. Server chỉ lưu SHA-256. Scopes: `articles:read`, `chat:write`, `account:read`, `account:write`, `billing:read`, `checkout:write`. Không có scope admin. Mỗi key có hạn, last-used, rotate (tồn tại song song key cũ) và revoke. Chỉ quản lý được qua session + CSRF. |
| Policy chung | `resolvePrincipal(request, env)` trả về `{ kind, userId, email, scopes, entitlements }`. `can(principal, action)` được dùng chung cho REST, MCP và CLI. |
| OAuth `/mcp` | OAuth 2.1 + PKCE, dynamic client registration và metadata `.well-known`. Token gắn audience và scope. `/api/mcp` cũ vẫn giữ. |
| Zuey AI | Dewee agent `zuey-ai` chạy trên gateway của user. Server proxy stream (SSE). Session chat riêng cho từng user, có quota và hủy giữa chừng. |
| Sandbox | Block tương tác chạy trong iframe `sandbox="allow-scripts"`, không có same-origin, áp CSP. Gọi API ra ngoài qua `postMessage` tới proxy server có allowlist domain và quota. |
| Motion | GSAP. Có hỗ trợ `prefers-reduced-motion`. |
| Thời tiết | Open-Meteo, không cần key. Mặc định dùng thành phố nhập tay. Vị trí trình duyệt chỉ dùng khi user đồng ý, làm tròn 1 chữ số thập phân. |

## Migrations (đặt số trước để tránh xung đột)

| File | Wave |
| --- | --- |
| `0006_members_and_billing.sql` | A |
| `0007_oauth_mcp.sql` | B1 |
| `0008_ai_chat.sql` | B2 |
| `0009_knowledge_taxonomy.sql` | B3 |
| `0010_notices_and_community.sql` | B4 |
| `0011_card_payments.sql` | B5 (Dodo + PayPal) |

## Waves

### Wave 1 (song song)

- **A — Nền tảng membership**
  - identity, session, admin allowlist, policy
  - gói, checkout SePay, webhook, reconcile, email
  - user API keys
  - trang `/account`, `/pricing`, `/billing/[id]`
  - paywall dựa trên entitlement
  - REST + OpenAPI + MCP
- **M — Mascot:** sinh spritesheet bằng codex CLI, kèm manifest và provenance.
- **D — Dewee:** provision agent `zuey-ai`, tìm hiểu API gateway, viết client có test.

### Wave 2 (sau A, mỗi agent dùng worktree riêng)

- **B1 — Bề mặt cho developer:** OAuth `/mcp` + tool member/checkout, CLI membership, Scalar Try-it.
- **B2 — Zuey AI:** chat streaming, session/memory, quota, block tương tác sinh bởi AI + sandbox/proxy, admin truy vấn session có audit.
- **B3 — Knowledge:**
  - locale editions EN/VI/ZH/KO/JA
  - taxonomy + tag công khai
  - mở rộng block/embed
  - vòng đời đề xuất nhãn bởi AI + duyệt + audit
  - tìm kiếm FTS5 + vector
  - chia sẻ/Markdown theo locale
- **B4 — Trải nghiệm:**
  - trang chủ 3 panel + tabs mobile
  - GSAP, mascot, thời tiết + video
  - thông báo của Duy
  - command palette
  - hoạt động GitHub
  - trang privacy
  - Telegram community

### Wave 3

Merge, sau đó chạy test và build. Backup D1 rồi chạy migration remote, set secrets, deploy. Kiểm tra trên browser ở 320/768/1440 và sửa lỗi UX/AX. Cập nhật docs.

## Acceptance

Theo bước 9 của handoff, trong phạm vi credential đang có:

- `bun test` 0 fail.
- `bun run build` 0 lỗi, 0 warning.
- Các role và gói đều được kiểm tra quyền ở server.
- Paywall không lộ nội dung qua HTML, `.md`, REST, MCP hay search.
- Webhook gửi lại nhiều lần vẫn idempotent.
- Key bị revoke hoặc hết hạn thì bị từ chối.
- Deploy production và kiểm tra trên browser.

## Trạng thái (2026-10-02)

- Wave 1, 2 đã merge vào nhánh `claude/zuey-membership-implementation-ev50kx`; `bun test` 307/0, `bun run build` 0/0/0.
- D1 production (tài khoản sở hữu DNS) đã chạy đủ `0001`–`0011`; secrets đã đặt; bản deploy chạy trên `zuey-me-aub.pages.dev`.
- 2026-10-03: rule chuyển hướng sang Substack đã được tắt (không xoá); `zuey.me` và `www` phục vụ app, verify 320/768/1440 đạt. Pages project và D1 cũ ở NextLevelBuilder đã xoá; cutover hoàn tất.

## Đã biết chưa có

- Link Telegram (user cung cấp sau).
- Cổng thẻ quốc tế: chọn Dodo (gói) + PayPal (tư vấn); chưa có API key.

## Quyết định đã chốt

- Chiết khấu trả trước: 5% (3 tháng), 10% (6 tháng), 20% (12 tháng); áp cho cả USD và VND.
- Ngân sách AI hằng tháng theo gói: $3 (AI), $5 (combo), $5 (cộng đồng); kiểm tra nguyên tử trong `consumeQuota`.
- Jev (TypeSafe AI System One, câu hỏi `noul`) xếp hạng lại search và lọc nguồn grounding của Zuey AI (ngưỡng 0,15); fail-open về BM25.
