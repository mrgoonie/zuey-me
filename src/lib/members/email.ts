import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { sendEmail } from '../integrations/resend';
import type { Row } from './runtime';
import { escapeHtml, isUniqueViolation, membersRuntime, nowIso, str } from './runtime';

export type EmailKind = 'magic_link' | 'email_change_verify' | 'email_change_notice' | 'payment_receipt' | 'renewal_reminder' | 'article_notification' | 'referral_payout' | 'course_receipt' | 'invoice_request';
export type LoggedEmailStatus = 'sent' | 'skipped' | 'failed' | 'duplicate';

export interface LoggedEmail {
  /** Idempotency key: the same key is delivered at most once successfully. */
  key: string;
  kind: EmailKind;
  to: string;
  userId: string | null;
  subject: string;
  html: string;
  text: string;
}

/** A send that is still marked pending after this long is treated as abandoned and may be retried. */
const PENDING_STALE_MS = 2 * 60 * 1000;

/**
 * Sends through Resend at most once per idempotency key and records the outcome in email_log.
 * Missing RESEND_API_KEY is recorded as `skipped` (retryable later), never as success.
 */
export async function sendLoggedEmail(d1: D1DatabaseLike, env: RuntimeEnv, email: LoggedEmail): Promise<{ status: LoggedEmailStatus; error?: string }> {
  const now = nowIso();
  try {
    await d1.prepare(
      "INSERT INTO email_log (idempotency_key, kind, user_id, to_email, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)"
    ).bind(email.key, email.kind, email.userId, email.to, now, now).run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await d1.prepare('SELECT status, updated_at FROM email_log WHERE idempotency_key = ?').bind(email.key).first<Row>();
    const status = existing ? str(existing, 'status') : '';
    if (status === 'sent') return { status: 'duplicate' };
    if (status === 'pending' && existing && membersRuntime.now() - Date.parse(str(existing, 'updated_at')) < PENDING_STALE_MS) {
      return { status: 'duplicate' };
    }
    await d1.prepare("UPDATE email_log SET status = 'pending', to_email = ?, updated_at = ? WHERE idempotency_key = ?").bind(email.to, now, email.key).run();
  }

  const result = await sendEmail(env, { to: email.to, subject: email.subject, html: email.html, text: email.text }, membersRuntime.fetch);
  const status: LoggedEmailStatus = result.status === 'sent' ? 'sent' : result.status === 'unconfigured' ? 'skipped' : 'failed';
  await d1.prepare('UPDATE email_log SET status = ?, provider_id = ?, error = ?, updated_at = ? WHERE idempotency_key = ?')
    .bind(status, result.id ?? null, result.error ?? null, nowIso(), email.key).run();
  return result.error ? { status, error: result.error } : { status };
}

// ---------------------------------------------------------------------------
// Templates (Vietnamese first, short English line for non-Vietnamese readers)
// ---------------------------------------------------------------------------

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html><html lang="vi"><body style="margin:0;background:#F5EFEB;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
<div style="max-width:560px;margin:0 auto;padding:32px 20px">
<p style="font-size:12px;font-weight:bold;letter-spacing:.12em;text-transform:uppercase;color:#b45309;margin:0 0 8px">Zuey</p>
<h1 style="font-family:Georgia,serif;font-size:24px;margin:0 0 16px">${escapeHtml(title)}</h1>
${bodyHtml}
<p style="font-size:12px;color:#78716c;margin-top:32px">Zuey · zuey.me · hi@zuey.me</p>
</div></body></html>`;
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0"><a href="${escapeHtml(href)}" style="display:inline-block;background:#1c1917;color:#fff;text-decoration:none;font-weight:bold;padding:12px 22px;border-radius:999px">${escapeHtml(label)}</a></p>`;
}

function p(text: string): string {
  return `<p style="font-size:15px;line-height:1.6;margin:0 0 12px">${escapeHtml(text)}</p>`;
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export function magicLinkEmail(link: string, minutes: number): EmailContent {
  const subject = 'Đăng nhập Zuey';
  const html = layout('Đăng nhập vào Zuey', [
    p(`Bấm nút bên dưới để đăng nhập. Link chỉ dùng được một lần và hết hạn sau ${minutes} phút.`),
    button(link, 'Đăng nhập'),
    p('Nếu bạn không yêu cầu đăng nhập, hãy bỏ qua email này.'),
    p(`English: use this one-time link within ${minutes} minutes to sign in. Ignore it if you did not ask.`),
  ].join(''));
  const text = `Đăng nhập Zuey (dùng một lần, hết hạn sau ${minutes} phút):\n${link}\n\nNếu bạn không yêu cầu, hãy bỏ qua email này.\nEnglish: one-time sign-in link, valid for ${minutes} minutes.`;
  return { subject, html, text };
}

export function emailChangeVerifyEmail(link: string, minutes: number): EmailContent {
  const subject = 'Xác nhận email mới cho tài khoản Zuey';
  const html = layout('Xác nhận email mới', [
    p(`Ai đó (hy vọng là bạn) muốn dùng địa chỉ này cho tài khoản Zuey. Link hết hạn sau ${minutes} phút.`),
    button(link, 'Xác nhận email'),
    p('Nếu không phải bạn, hãy bỏ qua email này; tài khoản sẽ không thay đổi.'),
    p('English: confirm this address for your Zuey account, or ignore this email.'),
  ].join(''));
  const text = `Xác nhận email mới cho tài khoản Zuey (hết hạn sau ${minutes} phút):\n${link}\n\nNếu không phải bạn, hãy bỏ qua email này.`;
  return { subject, html, text };
}

export function emailChangeNoticeEmail(newEmail: string): EmailContent {
  const subject = 'Email tài khoản Zuey đã được thay đổi';
  const html = layout('Email tài khoản đã thay đổi', [
    p(`Email đăng nhập tài khoản Zuey của bạn vừa được đổi sang ${newEmail}.`),
    p('Nếu bạn không thực hiện thay đổi này, hãy trả lời email này hoặc liên hệ hi@zuey.me ngay.'),
    p(`English: your Zuey sign-in email was changed to ${newEmail}. Contact hi@zuey.me if this was not you.`),
  ].join(''));
  const text = `Email tài khoản Zuey của bạn vừa được đổi sang ${newEmail}.\nNếu không phải bạn, liên hệ hi@zuey.me ngay.`;
  return { subject, html, text };
}

const vnd = (n: number): string => `${new Intl.NumberFormat('vi-VN').format(n)} ₫`;
const viDate = (isoValue: string): string =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'long' }).format(new Date(isoValue));

export function receiptEmail(input: { code: string; planName: string; months: number; amountVnd: number; paidAt: string; periodEnd: string; accountUrl: string }): EmailContent {
  const subject = `Biên nhận thanh toán ${input.code} — Zuey ${input.planName}`;
  const rows = [
    ['Mã đơn', input.code],
    ['Gói', `${input.planName} · ${input.months} tháng`],
    ['Số tiền', vnd(input.amountVnd)],
    ['Thanh toán lúc', viDate(input.paidAt)],
    ['Hiệu lực đến', viDate(input.periodEnd)],
  ];
  const table = `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 16px">${rows
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#57534e">${escapeHtml(k)}</td><td style="padding:6px 0;text-align:right;font-weight:bold">${escapeHtml(v)}</td></tr>`)
    .join('')}</table>`;
  const html = layout('Cảm ơn bạn đã ủng hộ Zuey', [
    p('Thanh toán chuyển khoản của bạn đã được xác nhận.'),
    table,
    button(input.accountUrl, 'Xem tài khoản'),
    p(`English: payment ${input.code} received; ${input.planName} is active until ${input.periodEnd.slice(0, 10)}.`),
  ].join(''));
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nTài khoản: ${input.accountUrl}`;
  return { subject, html, text };
}

export function renewalReminderEmail(input: { planName: string; periodEnd: string; pricingUrl: string }): EmailContent {
  const subject = `Gói ${input.planName} sắp hết hạn`;
  const html = layout(`Gói ${input.planName} sắp hết hạn`, [
    p(`Gói ${input.planName} của bạn có hiệu lực đến ${viDate(input.periodEnd)}. Thanh toán qua chuyển khoản là trả trước, không tự động gia hạn.`),
    p('Nếu muốn tiếp tục, bạn có thể gia hạn thêm 1, 3, 6 hoặc 12 tháng; thời gian mới được cộng nối tiếp kỳ hiện tại.'),
    button(input.pricingUrl, 'Gia hạn'),
    p(`English: your ${input.planName} plan ends on ${input.periodEnd.slice(0, 10)}. Prepaid plans do not renew automatically.`),
  ].join(''));
  const text = `Gói ${input.planName} của bạn có hiệu lực đến ${viDate(input.periodEnd)}.\nGia hạn: ${input.pricingUrl}`;
  return { subject, html, text };
}

export function courseReceiptEmail(input: { code: string; courseTitle: string; amount: string; paidAt: string; courseUrl: string; policyUrl: string }): EmailContent {
  const subject = `Biên nhận ${input.code} — khoá học ${input.courseTitle}`;
  const rows = [
    ['Mã đơn', input.code],
    ['Khoá học', input.courseTitle],
    ['Số tiền', input.amount],
    ['Thanh toán lúc', viDate(input.paidAt)],
    ['Quyền truy cập', 'Trọn đời'],
  ];
  const table = `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 16px">${rows
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#57534e">${escapeHtml(k)}</td><td style="padding:6px 0;text-align:right;font-weight:bold">${escapeHtml(v)}</td></tr>`)
    .join('')}</table>`;
  const html = layout('Khoá học đã được mở khoá', [
    p('Cảm ơn bạn! Thanh toán đã được xác nhận và khoá học đã sẵn sàng trong tài khoản của bạn.'),
    table,
    button(input.courseUrl, 'Bắt đầu học'),
    p(`Khoá học là sản phẩm số và không hoàn tiền sau khi mở khoá (${input.policyUrl}).`),
    p(`English: payment ${input.code} received; ${input.courseTitle} is unlocked for life.`),
  ].join(''));
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nVào học: ${input.courseUrl}\nChính sách: ${input.policyUrl}`;
  return { subject, html, text };
}

/** To the admins: a SePay order with a business tax ID was paid, so a VAT invoice must be issued by hand. */
export function invoiceRequestEmail(input: {
  sourceCode: string; description: string; taxId: string; email: string; amountVnd: number; paidAt: string; studioUrl: string;
}): EmailContent {
  const amount = `${new Intl.NumberFormat('vi-VN').format(input.amountVnd)} ₫`;
  const subject = `Yêu cầu xuất hoá đơn — MST ${input.taxId} — ${input.sourceCode}`;
  const rows = [
    ['Mã đơn', input.sourceCode],
    ['Nội dung', input.description],
    ['Mã số thuế', input.taxId],
    ['Email nhận hoá đơn', input.email],
    ['Số tiền đã thanh toán', amount],
    ['Thanh toán lúc', viDate(input.paidAt)],
  ];
  const table = `<table style="width:100%;border-collapse:collapse;font-size:14px;margin:8px 0 16px">${rows
    .map(([k, v]) => `<tr><td style="padding:6px 0;color:#57534e">${escapeHtml(k)}</td><td style="padding:6px 0;text-align:right;font-weight:bold">${escapeHtml(v)}</td></tr>`)
    .join('')}</table>`;
  const html = layout('Cần xuất hoá đơn doanh nghiệp', [
    p('Một đơn SePay có yêu cầu xuất hoá đơn (VAT) đã được thanh toán. Xuất hoá đơn rồi đánh dấu "đã xuất" trong Studio.'),
    table,
    button(input.studioUrl, 'Mở danh sách hoá đơn'),
  ].join(''));
  const text = rows.map(([k, v]) => `${k}: ${v}`).join('\n') + `\n\nStudio: ${input.studioUrl}`;
  return { subject, html, text };
}
