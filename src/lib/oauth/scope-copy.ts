// Vietnamese, member-facing descriptions of OAuth scopes (consent screen + connected apps).
// Plain module with no server imports so it can be bundled into client components.

export const OAUTH_SCOPE_COPY: Record<string, string> = {
  'articles:read': 'Đọc bài viết (theo gói của bạn)',
  'chat:write': 'Chat với Zuey AI (theo gói của bạn)',
  'account:read': 'Xem hồ sơ, gói, khoá API (chỉ thông tin, không có bí mật) và hoạt động',
  'account:write': 'Sửa hồ sơ (tên, ảnh, ngôn ngữ)',
  'billing:read': 'Xem gói và đơn hàng',
  'checkout:write': 'Tạo đơn thanh toán (bạn vẫn tự chuyển khoản)',
  admin: 'Quản trị zuey.me (hồ sơ, liên kết, nội dung) — chỉ dành cho quản trị viên',
};

export function scopeLabel(scope: string): string {
  return OAUTH_SCOPE_COPY[scope] ?? scope;
}
