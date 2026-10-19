# Review PR #195: validate refresh scope/resource/consent trước khi rotate

- PR: https://github.com/mrgoonie/zuey-me/pull/195 (Closes #183)
- Head: `cbad4ed` (`fix/183-refresh-validate-before-rotate`), base `main` (không có commit mới trên main kể từ base), MERGEABLE, CI "Test & Build" pass
- Reviewer: agent độc lập (không viết PR). Không push, comment, merge hay gắn label.
- Ngày: 2026-10-19 (Asia/Saigon)

## Kết luận: APPROVE

Fix đúng nguyên nhân, nhỏ gọn (dời khối CAS claim xuống sau phần validate), không đổi contract endpoint. Có một điểm yếu về test (không chặn merge), ghi bên dưới.

## Gate

| Gate | Kết quả |
| --- | --- |
| `bun install` | 742 package, OK |
| `bun test tests/oauth-mcp.test.ts` | 30 pass, 0 fail |
| `bun test` | 1107 pass, 0 fail (62 file) |
| `bun run build` | astro check 0 errors, 0 warnings (66 hints); build Complete |
| Test mới fail trên main | Có: thay `tokens.ts` bằng bản `origin/main` thì 29 pass / 1 fail (`leaves the refresh token usable...`: Expected `invalid_scope`, Received `invalid_grant`) |
| OpenAPI | Không đổi endpoint, không cần cập nhật |

## Checklist review `src/lib/oauth/tokens.ts`

1. **Rotation atomic, một người thắng**: giữ nguyên. CAS `UPDATE ... WHERE id = ? AND rotated_at IS NULL AND revoked_at IS NULL` (tokens.ts:171-176) không đổi, chỉ chạy sau cùng. Bên thua `changes = 0` thì revoke family + `invalid_grant`.
2. **Phát hiện reuse vẫn revoke**: token đã rotate/revoke bị bắt ở tokens.ts:143-146 (trước mọi validate) và vẫn gọi `revokeFamily`. Test mới xác nhận: dùng lại token gốc sau khi retry thành công thì `invalid_grant`, và refresh token kế nhiệm cũng bị vô hiệu.
3. **Không có đường nào để request sai rotate hoặc revoke**: trước CAS, các nhánh lỗi gồm `unauthorized_client` (137), `invalid_request` (139), token lạ hoặc của client khác (141, không revoke), hết hạn (149, không rotate), `invalid_scope` (157-159), `invalid_target` (163). Tất cả throw mà không ghi DB. Nhánh duy nhất revoke là reuse thật (143) và consent bị thu hồi (165-168), cả hai đều có chủ đích.
4. **Thu hồi consent vẫn revoke grant**: giữ nguyên (tokens.ts:165-168), nay chạy trước claim. Kết quả giống trước: family bị revoke, `invalid_grant`.
5. **RFC 6749 §6**: scope refresh phải là tập con của grant ban đầu. Scope ngoài grant hoặc không hợp lệ (`parseScopeParam` trả `null`) trả `invalid_scope` thay vì cắt giao âm thầm. Cách này hợp lệ và rõ ràng hơn với client. `scope` rỗng thì giữ nguyên scope đã cấp. Server vẫn cấp refresh token mới (rotation), đúng với §6 và khuyến nghị BCP.
6. **Error envelope**: endpoint OAuth dùng `OAuthError` và `oauthErrorResponse` (`{ error, error_description }`, 400, header no-store), đúng RFC 6749 §5.2. Không dùng envelope `AppError`, đây là chủ đích cho endpoint giao thức OAuth. Các mã `invalid_scope`, `invalid_target` (RFC 8707), `invalid_grant` đều đúng.
7. **Test chứng minh hành vi**: test widen/unknown/resource thì đạt (fail trên main, pass với fix). Test concurrency thì yếu, xem finding F1.

## Findings

### F1 (Low, không chặn merge): test concurrency không chứng minh CAS
- `tests/oauth-mcp.test.ts:507-514` (`lets only one of two concurrent refreshes rotate the token`).
- Mutation test: bỏ `AND rotated_at IS NULL AND revoked_at IS NULL` khỏi câu claim (tokens.ts:171) thì toàn bộ 30 test vẫn pass. Lý do: helper `tests/helpers/d1.ts` chạy bun:sqlite đồng bộ, nên request thứ hai đọc row sau khi request thứ nhất đã claim, và bị chặn sớm ở check `rotated_at` (tokens.ts:143), không bao giờ tới CAS.
- Hệ quả: test này là guard hồi quy cho hành vi "một 200, một invalid_grant" nhưng sẽ không bắt được việc ai đó xoá điều kiện CAS. Mô tả PR ("two concurrent refreshes still produce exactly one winner") đúng về code nhưng test không chứng minh được.
- Gợi ý (có thể làm ở issue riêng): gọi `refreshTokens` trực tiếp với wrapper D1 cho phép xen kẽ có kiểm soát (ví dụ chặn `consentActive` bằng một promise cho tới khi request kia đã SELECT xong), hoặc set `rotated_at` giữa SELECT và claim.

### F2 (Info, có từ trước, ngoài phạm vi PR): kết quả race của bên thắng không xác định
- tokens.ts:173-177: khi bên thua CAS gọi `revokeFamily`, token mới của bên thắng chỉ bị revoke nếu `issueTokens` đã INSERT trước đó. Nếu bên thua revoke trước thì token mới của bên thắng vẫn sống. Ngoài ra claim và `issueTokens` không nằm trong một batch, nên nếu INSERT lỗi thì token cũ đã bị rotate mà không có token kế nhiệm. Cả hai hành vi đã có trên main và PR không làm xấu đi. Nếu muốn xử lý thì mở issue riêng (theo AGENTS.md, không mở rộng PR này).

### F3 (Info): cửa sổ giữa validate và claim rộng hơn
- Nay có thêm truy vấn `consentActive` giữa SELECT và CAS. Điều này không ảnh hưởng tính đúng: CAS vẫn đảm bảo chỉ một bên thắng, và nếu consent bị thu hồi ngay sau check thì `validateAccessToken` (tokens.ts:195) vẫn từ chối access token ở mỗi lần dùng.

## Dọn dẹp
- Worktree review tại `scratchpad/wt-195` (detached tại `cbad4ed`) đã được gỡ (`git worktree remove --force` + `prune`). Các file tạm `tokens.ts` dùng cho mutation và test trên main đều đã khôi phục trước khi gỡ.

## Câu hỏi còn mở
- Có muốn mở issue riêng để làm test concurrency thật sự kiểm tra CAS (F1) và để claim + issue chạy trong một batch D1 (F2) không?
