# Báo cáo triển khai: OAuth 2.1 + MCP từ xa + CLI thành viên + /docs tương tác

- Ngày: 2026-10-02 (Asia/Saigon)
- Nhánh/worktree: `agent-adf3250bf7ac624fc`, gốc `e6fd123`
- Trạng thái: hoàn thành. `bun test` cho 173 pass và 0 fail. `bun run build` cho 0 lỗi, 0 cảnh báo, 0 gợi ý.

## Kết quả

Đã làm xong toàn bộ phạm vi được giao. Đã chạy thử luồng OAuth thật trên dev server (cổng 4335) bằng HTTP và bằng MCP Inspector CLI chính thức.

### 1. Migration `migrations/0007_oauth_mcp.sql`

Có 5 bảng:

- `oauth_clients`: client DCR và client CIMD được cache.
- `oauth_requests`: yêu cầu uỷ quyền được "đỗ" ở phía server. Nhờ vậy URL `next` của /login luôn ngắn, dưới 300 ký tự.
- `oauth_codes`: lưu hash, PKCE challenge, resource, scopes và thời hạn 2 phút. Mỗi code chỉ dùng một lần qua `used_at`.
- `oauth_tokens`: lưu hash của access và refresh, `family_id`, audience, scopes, `rotated_at`, `revoked_at`, `last_used_at`.
- `oauth_consents`: ràng buộc UNIQUE(user, client).

### 2. Authorization server (`src/lib/oauth/*`, `src/pages/oauth/*`, `src/pages/.well-known/*`)

**Discovery**
- `/.well-known/oauth-authorization-server` theo RFC 8414. Có `client_id_metadata_document_supported` và `authorization_response_iss_parameter_supported`.
- `/.well-known/oauth-protected-resource/mcp` (chèn path) và `/.well-known/oauth-protected-resource` theo RFC 9728.

**Đăng ký client**
- `/oauth/register` theo RFC 7591.
- Redirect URI phải là https, http loopback, hoặc private-use scheme. Cấm javascript/data/file, fragment và thông tin đăng nhập trong URI.
- Giới hạn 20 lần đăng ký mỗi giờ cho mỗi IP (IP được hash).
- Client ID Metadata Document cũng được hỗ trợ:
  - fetch có timeout 5 giây, `redirect: 'error'`, giới hạn 64KB;
  - `client_id` trong tài liệu phải khớp URL;
  - chặn IP literal và host nội bộ.

**`/oauth/authorize`**
- Đây là trang standalone, không dùng Layout, nên không có PostHog.
- Header: `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, `no-store`, `noindex`.
- Bắt buộc PKCE S256 và `response_type=code`. So khớp `redirect_uri` chính xác từng ký tự.
- Nếu `resource` có mặt thì phải bằng `<origin>/mcp`. `prompt=none` sẽ trả `interaction_required`.
- Khi client hoặc redirect sai, trang hiển thị lỗi và không redirect. Các lỗi khác được trả về redirect_uri kèm `state` và `iss`.
- Chưa đăng nhập thì chuyển sang `/login?next=/oauth/authorize?request_id=…`.

**Màn hình đồng ý**
- Hiển thị tên client, host và URI chuyển hướng đầy đủ, client_id và resource.
- Có cảnh báo "tên do ứng dụng tự khai báo" với client DCR.
- Danh sách checkbox scope dùng fieldset/legend, kèm mô tả tiếng Việt. Nút "Từ chối" và "Cho phép".
- Scope `admin` chỉ được đề xuất cho email nằm trong allowlist admin. Nếu người không phải admin sửa form để thêm admin, server bỏ qua phần đó.

**`/oauth/consent`** (POST)
- Bắt buộc same-origin, phiên thành viên, và yêu cầu phải thuộc đúng user đó.
- Mỗi yêu cầu chỉ được xử lý một lần. Trả 303.
- Ghi activity `oauth.granted` hoặc `oauth.denied`.

**`/oauth/token`**
- `authorization_code` + PKCE. Khi code bị dùng lại, toàn bộ family bị thu hồi.
- `refresh_token` có xoay vòng. Dùng lại refresh token cũ thì thu hồi cả family. Scope chỉ có thể thu hẹp.
- Xác thực client theo `none`, `client_secret_basic` hoặc `client_secret_post`, so sánh hash timing-safe.
- Thời hạn: access token 1 giờ (`zoa_`), refresh token 30 ngày (`zor_`).

**`/oauth/revoke`** theo RFC 7009: thu hồi cả family, luôn trả 200.

**Ứng dụng đã kết nối**
- `GET /oauth/connections` không trả bất kỳ token nào.
- `DELETE /oauth/connections/{id}` chỉ dùng được với browser session, có CSRF check và ghi activity `oauth.revoked`.
- Component `src/components/account/ConnectedApps.tsx` đã được gắn vào `/account` ngay dưới AccountApp, có hộp thoại xác nhận trước khi ngắt kết nối.

### 3. `/mcp` (Streamable HTTP, `src/lib/oauth/mcp-http.ts`)

**Giao thức**
- Hỗ trợ hai thế hệ:
  - 2026-07-28: stateless, version đi trong `_meta`, header `MCP-Protocol-Version`/`Mcp-Method`/`Mcp-Name` phải khớp với body;
  - legacy 2025-11-25, 2025-06-18, 2025-03-26: dùng `initialize`.
- Có `server/discover`. Kết quả hiện đại có `resultType` và serverInfo trong `_meta`.
- Mã lỗi: -32020 khi header không khớp, -32022 khi version không hỗ trợ, -32602 khi thiếu `_meta`.
- Notification trả 202. GET và DELETE trả 405. Origin không hợp lệ trả 403. Có thể mở thêm origin qua `MCP_ALLOWED_ORIGINS`.

**Xác thực**
- Chỉ nhận Bearer, cookie bị loại bỏ.
- 401 kèm `WWW-Authenticate: Bearer resource_metadata="…"`, và thêm `error="invalid_token"` khi token hết hạn, bị thu hồi hoặc sai audience.
- Chấp nhận ba loại credential:
  - access token OAuth, audience phải đúng `<origin>/mcp`;
  - key `zk_` của thành viên;
  - admin/read key, qua `resolvePrincipal`.

**Phân quyền**
- Scope OAuth được map vào cùng `Principal` nên `can()` quyết định giống hệt với key cá nhân.
- Quyền admin cần đồng thời scope `admin` và allowlist.
- Khi thiếu scope, trả 403 kèm `error="insufficient_scope", scope="…"` để client step-up.

**Danh sách tool**
- `tools/list` được lọc theo người gọi bằng `TOOL_ACCESS`. Tool chưa có trong map sẽ bị ẩn (fail closed), và có test giữ cho map luôn đầy đủ.
- Các tool cũ được chuyển sang `src/lib/mcp/dispatch.ts`, nên `/mcp` và `/api/mcp` dùng chung tool. Tool checkout cũng có mặt.
- `/api/mcp` vẫn trả lời như trước, với protocol 2024-11-05.
- Thêm tool `me_keys_list`: chỉ đọc metadata (scope account:read), không có tool nào tạo key.

### 4. CLI `packages/cli`

- Config lưu ở thư mục config của hệ điều hành (XDG / `~/Library/Application Support` / `%APPDATA%`), file 0600, thư mục 0700. Biến môi trường `ZUEY_API_KEY`/`ZUEY_API_URL`/`ZUEY_CONFIG_DIR` được ưu tiên hơn file. File cũ `~/.zuey/config.json` vẫn đọc được.
- Lệnh mới:
  - `login`: nhập key ẩn, kiểm tra key trước khi lưu; `--url` chỉ nhận https hoặc localhost;
  - `logout`, `whoami`;
  - `articles list/read`: render các block thành văn bản;
  - `search`: lọc cục bộ theo tiêu đề, excerpt và tag, và nói rõ điều này khi chạy;
  - `chat`: gọi `/api/v1/chat`; nếu server trả 404/405 thì báo thật là chưa có và thoát với mã 2;
  - `plans`;
  - `subscribe <plan> --months`: in thông tin chuyển khoản VietQR;
  - `keys`: hướng dẫn tới /account;
  - `mcp config`.
- Các lệnh admin cũ giữ nguyên.
- Khi lỗi, CLI in status, code và request id.
- Đã cập nhật README và `skills/zuey-me/SKILL.md`.

### 5. `/docs` (Scalar 1.72.3, đã pin phiên bản)

- Cấu hình: `servers=[location.origin]`, `persistAuth:false`, `telemetry:false`, `agent.disabled`, `showDeveloperTools:'never'`, `withDefaultFonts:false`.
- `customFetch` xử lý mọi request:
  - chặn request khác origin;
  - mở `<dialog>` xác nhận trước mọi POST/PUT/PATCH/DELETE; nếu huỷ thì trả về một response tổng hợp `cancelled_by_user` (status 499);
  - với key được dán: chỉ giữ trong biến closure, gửi qua header `Authorization` với `credentials:'omit'`, không bao giờ nằm trong URL hay storage;
  - nếu không dán key thì dùng cookie same-origin.
- Có ví dụ REST/CLI/MCP, chỉ dùng placeholder.
- Scalar có hook (`customFetch`) nên không cần lùi về chế độ chỉ GET.

### 6. Request id và OpenAPI

- `src/middleware.ts` gắn `X-Request-Id` cho mọi response. Nếu id gửi vào hợp lệ thì dùng lại, nếu không thì tạo `req_<uuid>`. Response có header bất biến được clone.
- Envelope lỗi JSON (`success:false`) được thêm `error.request_id`.
- CORS cho `/mcp`, `/oauth/token|register|revoke` và `/.well-known/oauth-*`: preflight trả 204 và expose `WWW-Authenticate` cùng `X-Request-Id`.
- Fragment `src/lib/oauth/openapi.ts` đã đăng ký trong registry. `openapi.json.ts` có thêm security scheme `McpOAuth` (oauth2 authorizationCode) và trường `request_id` trong schema Error.

## Kiểm chứng

**Unit/integration: `tests/oauth-mcp.test.ts`, 25 test**

Luồng PKCE thật đi qua các route handler:
- metadata;
- DCR (hợp lệ, không hợp lệ, rate limit);
- PKCE thành công, verifier sai, code dùng lại (thu hồi family), redirect không khớp ở cả authorize lẫn token, code hết hạn;
- lỗi được báo về redirect_uri kèm state và iss; resource sai thì nhận `invalid_target`;
- từ chối, ràng buộc request với user, CSRF;
- CIMD;
- client confidential;
- refresh rotation, phát hiện dùng lại, thu hẹp scope; refresh từ client khác bị từ chối;
- revoke;
- connected apps: liệt kê, cô lập giữa thành viên, chặn key, ngắt kết nối;
- 401 kèm WWW-Authenticate khi không có token, token hết hạn hoặc token bịa;
- sai audience;
- step-up 403 khi thiếu scope;
- `tools/list` lọc đúng cho member, admin, admin thiếu scope admin, non-admin giả mạo scope admin, key zk_ và admin key; cookie bị bỏ qua;
- `me_keys_list` không lộ secret;
- map quyền tool đầy đủ;
- negotiate version, header mismatch, -32022, 404, 202, Origin 403, 405;
- `/api/mcp` legacy;
- request id.

**Toàn bộ:** `bun test` cho 173 pass, 0 fail. `bun run build` (astro check + build) cho 0 lỗi, 0 cảnh báo, 0 gợi ý.

**Luồng thật trên `bun run dev --port 4335`**
- Áp dụng migration lên D1 local: `wrangler d1 migrations apply zuey_me_db --local`.
- Tạo một thành viên chỉ dùng local bằng script trong scratchpad (không commit).
- Kết quả từng bước:
  1. `/mcp` không token: 401 kèm `resource_metadata`.
  2. DCR: 201.
  3. authorize: 302 sang `request_id`.
  4. Chưa đăng nhập: 302 sang `/login?next=…`.
  5. Màn hình đồng ý: 200, có tên client và redirect host, `X-Frame-Options: DENY`.
  6. Approve: 303 về redirect, có state, iss và code.
  7. Token: 200, scope `articles:read account:read`, có refresh token.
  8. `tools/list` (2026-07-28) trả 13 tool, đúng là chỉ các tool public và các tool member được phép.
  9. Lỗi REST có cả header và `request_id` trong body.

**MCP Inspector CLI** (`npx @modelcontextprotocol/inspector --cli … --transport http --header "Authorization: Bearer <token>"`)
- Với access token OAuth: `tools/list` và `tools/call me_get` thành công (`auth.via=user_api_key`, scopes đúng).
- `subscription_get` bị Inspector báo không tồn tại vì đã bị lọc khỏi danh sách, đúng như mong đợi.
- Với key zk_: `tools/list` thành công.
- Inspector CLI không tự chạy được bước đồng ý trên trình duyệt, nên bước lấy token được làm bằng script HTTP ở trên rồi truyền token vào Inspector.

**Trình duyệt** (Playwright headless Chromium 1243, ở 320/768/1440)
- Màn hình đồng ý, `/account` (ứng dụng đã kết nối) và `/docs`: không tràn ngang ở cả ba kích thước, không có lỗi JS.
- Checkbox đều có label.
- Key dán vào /docs không xuất hiện trong URL, localStorage hay sessionStorage.
- Bấm "Test Request" của POST `/oauth/register` trong Scalar thì dialog xác nhận mở ra. Bấm "Cancel" thì không có request nào được gửi và Scalar hiển thị `cancelled_by_user`.
- Ảnh chụp nằm trong scratchpad, không commit.
- Dev server đã được dừng (taskkill PID 79532 và các tiến trình con).

## File thay đổi

**Mới**
- `migrations/0007_oauth_mcp.sql`
- `src/lib/oauth/{config,errors,clients,tokens,authorize,metadata,caller,mcp-http,tool-access,account-mcp,scope-copy,openapi}.ts`
- `src/lib/mcp/dispatch.ts`
- `src/pages/mcp.ts`
- `src/pages/.well-known/oauth-authorization-server.ts`
- `src/pages/.well-known/oauth-protected-resource.ts`
- `src/pages/.well-known/oauth-protected-resource/mcp.ts`
- `src/pages/oauth/{authorize.astro,consent.ts,register.ts,token.ts,revoke.ts}`
- `src/pages/oauth/connections/{index,[id]}.ts`
- `src/components/account/ConnectedApps.tsx`
- `tests/oauth-mcp.test.ts`

**Sửa**
- `src/pages/api/mcp.ts`: tách ra dùng dispatcher chung.
- `src/lib/mcp/registry.ts`
- `src/lib/openapi/registry.ts`
- `src/pages/api/openapi.json.ts`: thêm `McpOAuth` và `request_id`.
- `src/middleware.ts`
- `src/lib/http.ts`
- `src/env.d.ts`, `.env.example`: thêm `MCP_ALLOWED_ORIGINS`.
- `src/pages/account/index.astro`: gắn ConnectedApps.
- `src/pages/docs/index.astro`
- `packages/cli/bin/zuey.js`, `packages/cli/README.md`
- `skills/zuey-me/SKILL.md`

## Lưu ý và việc tiếp theo

1. **`CredentialVia` chưa có giá trị riêng cho OAuth.** `policy.ts` không thuộc phạm vi của đợt này nên principal OAuth đang dùng `via: 'user_api_key'`. Hành vi là đúng: SESSION_ONLY vẫn bị chặn, scope vẫn được áp dụng. Hệ quả là `/api/v1/me` và `me_get` hiển thị `user_api_key`. Đề xuất thêm `'oauth_token'` vào `CredentialVia` trong một thay đổi riêng.
2. **Các wave song song cần cập nhật `TOOL_ACCESS`.** Nếu B2 (chat), B3 (search) hoặc B5 thêm MCP tool mà không thêm vào `src/lib/oauth/tool-access.ts`, tool đó sẽ bị ẩn trên `/mcp` và test "keeps the tool access map complete" sẽ fail. Đây là chủ đích, để không tool nào lộ ra ngoài ý muốn.
3. **Chat và search trong CLI chưa có REST endpoint.** `zuey chat` gọi `POST /api/v1/chat` với body `{message}` và đọc `reply|answer|content|message`; khi wave chat chốt hợp đồng thì cần đối chiếu lại. `zuey search` đang lọc cục bộ và nói rõ điều đó; có thể chuyển sang endpoint search khi B3 có.
4. **Remote migration chưa chạy.** Cần chạy: `wrangler d1 execute zuey_me_db --remote --file=./migrations/0007_oauth_mcp.sql -y`.
5. **Issuer và audience lấy theo origin của request.** Production sẽ là `https://zuey.me/mcp`. Nếu có thêm domain phụ, mỗi domain sẽ có audience riêng, đây là chủ đích.
6. **Phạm vi chuẩn chưa hỗ trợ.** Chưa có SSE hay GET stream. `/mcp` chỉ trả JSON, được phép theo spec. Chưa có `private_key_jwt`.
7. **Dọn dữ liệu cũ.** `oauth_requests`, `oauth_codes` và token hết hạn chưa có job dọn; có thể thêm vào cron sẵn có.

Status: DONE_WITH_CONCERNS
Summary: Đã hoàn thành OAuth 2.1 (PKCE, refresh xoay vòng, revoke, CIMD + DCR, màn hình đồng ý, quản lý ứng dụng đã kết nối), endpoint `/mcp` Streamable HTTP lọc tool theo người gọi và `/api/mcp` legacy vẫn chạy, CLI thành viên, `/docs` Scalar có xác nhận trước request ghi, `X-Request-Id`, cùng OpenAPI. Test và build đều sạch, luồng thật đã chạy được với MCP Inspector.
Concerns: `via` của OAuth dùng tạm `user_api_key` (cần sửa trong `policy.ts`); các wave song song phải thêm tool mới vào `TOOL_ACCESS`; hợp đồng `/api/v1/chat` của CLI cần đối chiếu với wave chat; cần chạy migration 0007 trên remote.
