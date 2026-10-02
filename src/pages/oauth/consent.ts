import type { APIRoute } from 'astro';
import { decideConsent } from '../../lib/oauth/authorize';
import { escapeHtml } from '../../lib/members/runtime';

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer',
};

function errorHtml(status: number, title: string, message: string): Response {
  const html = `<!doctype html><html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)} — Zuey</title></head>`
    + `<body style="font-family:system-ui,sans-serif;background:#181513;color:#1c1917;margin:0;padding:24px"><main style="max-width:520px;margin:10vh auto;background:#F5EFEB;border-radius:24px;padding:28px">`
    + `<h1 style="font-size:1.4rem;margin:0 0 12px">${escapeHtml(title)}</h1><p style="line-height:1.6;margin:0 0 16px">${escapeHtml(message)}</p>`
    + '<p style="margin:0"><a href="/account" style="color:#1c1917;font-weight:600">Về trang tài khoản</a></p></main></body></html>';
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS } });
}

/** Consent decision (approve/deny) posted by the /oauth/authorize screen. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  if (!env.DB) return errorHtml(503, 'Tạm thời không khả dụng', 'Hệ thống uỷ quyền cần cơ sở dữ liệu. Vui lòng thử lại sau.');
  try {
    const text = await request.text();
    if (text.length > 8192) return errorHtml(400, 'Yêu cầu không hợp lệ', 'Dữ liệu gửi lên quá lớn.');
    const outcome = await decideConsent(env.DB, env, request, new URLSearchParams(text));
    if (outcome.kind === 'error') return errorHtml(outcome.status, outcome.title, outcome.message);
    // 303 so the browser follows with GET; the code travels only in the client's registered redirect_uri.
    return new Response(null, { status: 303, headers: { Location: outcome.location, ...SECURITY_HEADERS } });
  } catch (err) {
    console.error('OAuth consent error:', err instanceof Error ? err.message : 'unknown');
    return errorHtml(500, 'Đã có lỗi xảy ra', 'Không xử lý được lựa chọn của bạn. Vui lòng kết nối lại từ ứng dụng.');
  }
};
