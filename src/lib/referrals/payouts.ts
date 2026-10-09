import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { sendLoggedEmail } from '../members/email';
import type { LoggedEmailStatus } from '../members/email';
import type { Row } from '../members/runtime';
import { escapeHtml, iso, membersRuntime, num, numOrNull, str, strOrNull } from '../members/runtime';
import { logReferralEvent } from './ledger';
import type { PayoutPayee } from './payout-payee-snapshot';
import { assertPayableSnapshot, rowToPayee } from './payout-payee-snapshot';
import { MONTH_RE } from './saigon-calendar';

/**
 * Monthly payout batches. The day-1 close creates one `pending` payout per referrer and period and books
 * a `payout` ledger line of −gross; an admin pays it by hand and marks it `paid` with the bank or PayPal
 * reference, or cancels it, which books an `adjustment` of +gross so the money returns to the balance.
 */
export type PayoutMethod = 'vn_bank' | 'paypal';
export type PayoutStatus = 'pending' | 'paid' | 'cancelled';
export const PAYOUT_STATUSES: PayoutStatus[] = ['pending', 'paid', 'cancelled'];
export const MAX_TRANSACTION_REF_LENGTH = 200;

export interface ReferralPayout {
  id: string;
  referrer_user_id: string;
  period: string;
  method: PayoutMethod;
  gross_cents: number;
  deduction_bp: number;
  deduction_cents: number;
  net_cents: number;
  usd_vnd_rate: number | null;
  net_vnd: number | null;
  status: PayoutStatus;
  transaction_ref: string | null;
  paid_at: string | null;
  paid_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Admin view: the payout plus where to send the money, as snapshotted at close (never national-ID images). */
export interface PayoutAdminView extends ReferralPayout {
  email: string | null;
  name: string | null;
  payee: PayoutPayee;
}

export function rowToPayout(row: Row): ReferralPayout {
  return {
    id: str(row, 'id'),
    referrer_user_id: str(row, 'referrer_user_id'),
    period: str(row, 'period'),
    method: row.method === 'paypal' ? 'paypal' : 'vn_bank',
    gross_cents: num(row, 'gross_cents'),
    deduction_bp: num(row, 'deduction_bp'),
    deduction_cents: num(row, 'deduction_cents'),
    net_cents: num(row, 'net_cents'),
    usd_vnd_rate: numOrNull(row, 'usd_vnd_rate'),
    net_vnd: numOrNull(row, 'net_vnd'),
    status: PAYOUT_STATUSES.find(s => s === row.status) ?? 'pending',
    transaction_ref: strOrNull(row, 'transaction_ref'),
    paid_at: strOrNull(row, 'paid_at'),
    paid_by: strOrNull(row, 'paid_by'),
    created_at: str(row, 'created_at'),
    updated_at: str(row, 'updated_at'),
  };
}

export async function getPayout(d1: D1DatabaseLike, id: string): Promise<ReferralPayout | null> {
  const row = await d1.prepare('SELECT * FROM referral_payouts WHERE id = ?').bind(id).first<Row>();
  return row ? rowToPayout(row) : null;
}

/**
 * Books the payout's −gross ledger line unless it already exists. One statement, so it is idempotent and
 * also repairs a close that was interrupted between creating the payout row and booking its line.
 */
export async function ensurePayoutLedgerLine(d1: D1DatabaseLike, payoutId: string | null = null): Promise<number> {
  const res = await d1.prepare(
    `INSERT INTO referral_ledger (referrer_user_id, kind, amount_cents, payout_id, note, created_at)
     SELECT p.referrer_user_id, 'payout', -p.gross_cents, p.id, 'payout ' || p.period, ?
     FROM referral_payouts p
     WHERE (? IS NULL OR p.id = ?) AND p.gross_cents > 0
       AND NOT EXISTS (SELECT 1 FROM referral_ledger l WHERE l.kind = 'payout' AND l.payout_id = p.id)`
  ).bind(iso(membersRuntime.now()), payoutId, payoutId).run();
  return res.meta?.changes ?? 0;
}

// The payee comes from the payout's own snapshot, never from the live (possibly edited, unverified) profile.
const ADMIN_SELECT = `SELECT p.*, u.email, u.name
  FROM referral_payouts p
  LEFT JOIN users u ON u.id = p.referrer_user_id`;

function rowToAdminView(row: Row): PayoutAdminView {
  return { ...rowToPayout(row), email: strOrNull(row, 'email'), name: strOrNull(row, 'name'), payee: rowToPayee(row) };
}

/** Validates a `YYYY-MM` period filter; undefined when absent. */
export function parsePeriod(raw: unknown): string | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  if (typeof raw !== 'string' || !MONTH_RE.test(raw)) throw new AppError(400, 'invalid_period', 'period must be YYYY-MM', { field: 'period' });
  return raw;
}

export function parsePayoutStatus(raw: unknown): PayoutStatus | undefined {
  if (raw === null || raw === undefined || raw === '') return undefined;
  const status = PAYOUT_STATUSES.find(s => s === raw);
  if (!status) throw new AppError(400, 'invalid_status', `status must be one of ${PAYOUT_STATUSES.join(', ')}`, { field: 'status' });
  return status;
}

/** Admin: payouts of a period (and/or status), newest first. */
export async function listPayouts(
  d1: D1DatabaseLike, opts: { period?: string; status?: PayoutStatus; limit?: number } = {},
): Promise<PayoutAdminView[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.period) { where.push('p.period = ?'); params.push(opts.period); }
  if (opts.status) { where.push('p.status = ?'); params.push(opts.status); }
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 500) || 500, 1), 1000);
  const { results } = await d1.prepare(
    `${ADMIN_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.period DESC, p.created_at DESC LIMIT ?`
  ).bind(...params, limit).all<Row>();
  return (results ?? []).map(rowToAdminView);
}

const usd = (cents: number): string => (cents / 100).toFixed(2);

/** Cell for a spreadsheet: quoted, and prefixed when it could be read as a formula. */
function csvCell(value: string | number | null): string {
  let text = value === null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text) && typeof value === 'string') text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const CSV_HEADER = [
  'payout_id', 'period', 'status', 'email', 'method', 'full_name', 'national_id', 'address', 'bank_name', 'bank_account',
  'paypal_email', 'payee_verified_at', 'gross_usd', 'deduction_bp', 'deduction_usd', 'net_usd', 'usd_vnd_rate', 'net_vnd', 'transaction_ref', 'paid_at',
];

/** Admin: CSV of one period for the accountant (tax declaration) and for paying by hand. */
export async function payoutsCsv(d1: D1DatabaseLike, period: string): Promise<string> {
  const rows = await listPayouts(d1, { period, limit: 1000 });
  const lines = [CSV_HEADER.map(csvCell).join(',')];
  for (const p of rows) {
    lines.push([
      p.id, p.period, p.status, p.email, p.method, p.payee.full_name, p.payee.national_id, p.payee.address, p.payee.bank_name,
      p.payee.bank_account, p.payee.paypal_email, p.payee.verified_at, usd(p.gross_cents), p.deduction_bp, usd(p.deduction_cents), usd(p.net_cents),
      p.usd_vnd_rate, p.net_vnd, p.transaction_ref, p.paid_at,
    ].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

function payoutEmail(p: ReferralPayout, transactionRef: string): { subject: string; html: string; text: string } {
  const amount = p.method === 'vn_bank' && p.net_vnd !== null
    ? `${new Intl.NumberFormat('vi-VN').format(p.net_vnd)} ₫ (US$${usd(p.net_cents)})`
    : `US$${usd(p.net_cents)}`;
  const deductionLabel = p.method === 'vn_bank' ? 'Thuế TNCN' : 'Phí xử lý & thuế';
  const lines = [
    `Kỳ: ${p.period}`,
    `Hoa hồng: US$${usd(p.gross_cents)}`,
    `${deductionLabel} (${(p.deduction_bp / 100).toFixed(2)}%): −US$${usd(p.deduction_cents)}`,
    `Thực nhận: ${amount}`,
    `Mã giao dịch: ${transactionRef}`,
  ];
  const subject = `Zuey đã thanh toán hoa hồng giới thiệu kỳ ${p.period}`;
  const html = `<!doctype html><html lang="vi"><body style="font-family:Arial,Helvetica,sans-serif;color:#1c1917;max-width:560px;margin:0 auto;padding:32px 20px">
<p style="font-size:12px;font-weight:bold;letter-spacing:.12em;text-transform:uppercase;color:#b45309">Zuey</p>
<h1 style="font-family:Georgia,serif;font-size:24px">Hoa hồng giới thiệu đã được chuyển</h1>
${lines.map(l => `<p style="font-size:15px;margin:0 0 8px">${escapeHtml(l)}</p>`).join('')}
<p style="font-size:15px">Cảm ơn bạn đã giới thiệu Zuey.</p>
<p style="font-size:13px;color:#57534e">English: your referral payout for ${escapeHtml(p.period)} was sent (reference ${escapeHtml(transactionRef)}).</p>
<p style="font-size:12px;color:#78716c;margin-top:32px">Zuey · zuey.me · hi@zuey.me</p></body></html>`;
  return { subject, html, text: `${lines.join('\n')}\n\nCảm ơn bạn đã giới thiệu Zuey.` };
}

export interface MarkPaidResult {
  outcome: 'paid' | 'already_paid';
  payout: ReferralPayout;
  email: LoggedEmailStatus | null;
}

/**
 * Admin: records the manual transfer and emails the referrer. Repeating it on a paid payout changes
 * nothing; a cancelled payout cannot be paid, nor one without a payee snapshot from a verified profile.
 */
export async function markPayoutPaid(
  d1: D1DatabaseLike, env: RuntimeEnv, id: string, rawRef: unknown, adminEmail: string,
): Promise<MarkPaidResult> {
  const transactionRef = typeof rawRef === 'string' ? rawRef.trim() : '';
  if (!transactionRef || transactionRef.length > MAX_TRANSACTION_REF_LENGTH) {
    throw new AppError(400, 'invalid_field', `transaction_ref is required (1–${MAX_TRANSACTION_REF_LENGTH} characters)`, { field: 'transaction_ref' });
  }
  const current = await getPayout(d1, id);
  if (!current) throw new AppError(404, 'not_found', 'Payout not found');
  if (current.status === 'paid') return { outcome: 'already_paid', payout: current, email: null };
  if (current.status === 'cancelled') throw new AppError(409, 'payout_cancelled', 'A cancelled payout cannot be marked paid');
  const snapshot = await d1.prepare('SELECT * FROM referral_payouts WHERE id = ?').bind(id).first<Row>();
  assertPayableSnapshot(current.method, snapshot ? rowToPayee(snapshot) : rowToPayee({}));

  const now = iso(membersRuntime.now());
  const res = await d1.prepare(
    "UPDATE referral_payouts SET status = 'paid', transaction_ref = ?, paid_at = ?, paid_by = ?, updated_at = ? WHERE id = ? AND status = 'pending'"
  ).bind(transactionRef, now, adminEmail, now, id).run();
  const payout = (await getPayout(d1, id)) ?? current;
  if (res.meta?.changes !== 1) {
    if (payout.status === 'paid') return { outcome: 'already_paid', payout, email: null };
    throw new AppError(409, 'payout_cancelled', 'A cancelled payout cannot be marked paid');
  }
  await logReferralEvent(d1, {
    actor: adminEmail, action: 'payout.paid', subjectUserId: payout.referrer_user_id,
    detail: { payout_id: id, period: payout.period, net_cents: payout.net_cents, transaction_ref: transactionRef },
  });

  const user = await d1.prepare('SELECT email FROM users WHERE id = ? AND deleted_at IS NULL').bind(payout.referrer_user_id).first<Row>();
  let email: LoggedEmailStatus | null = null;
  if (user) {
    const content = payoutEmail(payout, transactionRef);
    try {
      email = (await sendLoggedEmail(d1, env, {
        key: `referral_payout:${id}`, kind: 'referral_payout', to: str(user, 'email'), userId: payout.referrer_user_id, ...content,
      })).status;
    } catch (err) {
      // The transfer is already recorded; a failed notice must not undo it.
      console.error('referral payout email failed:', err instanceof Error ? err.message : 'unknown');
      email = 'failed';
    }
  }
  return { outcome: 'paid', payout, email };
}

/**
 * Admin: cancels an unpaid payout and returns its gross to the balance (`adjustment` +gross). Idempotent:
 * both ledger writes are guarded, so a retry after an interruption completes the cancellation exactly once.
 */
export async function cancelPayout(d1: D1DatabaseLike, id: string, actor: string, reason: string | null = null): Promise<{ outcome: 'cancelled' | 'already_cancelled'; payout: ReferralPayout }> {
  const current = await getPayout(d1, id);
  if (!current) throw new AppError(404, 'not_found', 'Payout not found');
  if (current.status === 'paid') throw new AppError(409, 'payout_paid', 'A paid payout cannot be cancelled; book an adjustment instead');
  const now = iso(membersRuntime.now());
  const res = await d1.prepare("UPDATE referral_payouts SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'")
    .bind(now, id).run();
  const changed = res.meta?.changes === 1;
  if (!changed && current.status !== 'cancelled') {
    const fresh = await getPayout(d1, id);
    if (fresh?.status === 'paid') throw new AppError(409, 'payout_paid', 'A paid payout cannot be cancelled; book an adjustment instead');
  }
  // The −gross line must exist before it is offset, or the cancellation would credit money never debited.
  await ensurePayoutLedgerLine(d1, id);
  await d1.prepare(
    `INSERT INTO referral_ledger (referrer_user_id, kind, amount_cents, payout_id, note, created_at)
     SELECT p.referrer_user_id, 'adjustment', p.gross_cents, p.id, 'payout cancelled ' || p.period, ?
     FROM referral_payouts p
     WHERE p.id = ? AND p.status = 'cancelled' AND p.gross_cents > 0
       AND NOT EXISTS (SELECT 1 FROM referral_ledger l WHERE l.kind = 'adjustment' AND l.payout_id = p.id)`
  ).bind(now, id).run();
  if (changed) {
    await logReferralEvent(d1, {
      actor, action: 'payout.cancelled', subjectUserId: current.referrer_user_id,
      detail: { payout_id: id, period: current.period, gross_cents: current.gross_cents, reason },
    });
  }
  return { outcome: changed ? 'cancelled' : 'already_cancelled', payout: (await getPayout(d1, id)) ?? current };
}
