/**
 * Business (VAT) invoice requests for SePay payments. The buyer gives a tax ID and an email at checkout; the
 * request waits until the order is paid, then admins are emailed and issue the invoice by hand, recording its
 * number in Studio. Card rails (Dodo, PayPal) issue their own receipts and never take an invoice request.
 */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { adminEmailList } from '../members/admins';
import { invoiceRequestEmail, sendLoggedEmail } from '../members/email';
import type { Row } from '../members/runtime';
import { iso, isUniqueViolation, membersRuntime, num, numOrNull, randomId, siteUrl, str, strOrNull } from '../members/runtime';

export type InvoiceSourceKind = 'billing_order' | 'booking' | 'course_order';
export type InvoiceStatus = 'awaiting_payment' | 'requested' | 'issued' | 'cancelled';
export const INVOICE_STATUSES: InvoiceStatus[] = ['awaiting_payment', 'requested', 'issued', 'cancelled'];

/** Vietnamese tax ID: 10 digits, or 10 digits + `-` + 3 digits for a branch. */
export const TAX_ID_RE = /^\d{10}(-\d{3})?$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InvoiceInput {
  taxId: string;
  email: string;
}

/**
 * Reads the optional `invoice: { tax_id, email }` checkout field. Absent or null → no invoice. Only SePay
 * checkouts accept it (`invoice_requires_sepay` otherwise).
 */
export function parseInvoiceField(body: Record<string, unknown>, provider: string): InvoiceInput | null {
  const raw = body.invoice;
  if (raw === undefined || raw === null || raw === false) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new AppError(400, 'invalid_field', 'invoice must be an object { tax_id, email }', { field: 'invoice' });
  if (provider !== 'sepay') throw new AppError(400, 'invoice_requires_sepay', 'Business invoices are issued for bank transfer (SePay) payments only', { field: 'invoice' });
  const fields = Object.fromEntries(Object.entries(raw));
  const taxId = typeof fields.tax_id === 'string' ? fields.tax_id.trim() : '';
  if (!TAX_ID_RE.test(taxId)) throw new AppError(400, 'invalid_field', 'invoice.tax_id must be 10 digits, or 10 digits-3 digits for a branch', { field: 'invoice.tax_id' });
  const email = typeof fields.email === 'string' ? fields.email.trim().toLowerCase() : '';
  if (!EMAIL_RE.test(email) || email.length > 254) throw new AppError(400, 'invalid_field', 'invoice.email must be a valid email', { field: 'invoice.email' });
  return { taxId, email };
}

export interface InvoiceRequest {
  id: string;
  source_kind: InvoiceSourceKind;
  source_id: string;
  source_code: string;
  user_id: string | null;
  tax_id: string;
  email: string;
  description: string;
  amount_vnd: number;
  amount_paid_vnd: number | null;
  status: InvoiceStatus;
  paid_at: string | null;
  invoice_no: string | null;
  issued_at: string | null;
  issued_by: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

function rowToInvoice(r: Row): InvoiceRequest {
  const kind = str(r, 'source_kind');
  return {
    id: str(r, 'id'),
    source_kind: kind === 'booking' || kind === 'course_order' ? kind : 'billing_order',
    source_id: str(r, 'source_id'),
    source_code: str(r, 'source_code'),
    user_id: strOrNull(r, 'user_id'),
    tax_id: str(r, 'tax_id'),
    email: str(r, 'email'),
    description: str(r, 'description'),
    amount_vnd: num(r, 'amount_vnd'),
    amount_paid_vnd: numOrNull(r, 'amount_paid_vnd'),
    status: INVOICE_STATUSES.find(s => s === r.status) ?? 'awaiting_payment',
    paid_at: strOrNull(r, 'paid_at'),
    invoice_no: strOrNull(r, 'invoice_no'),
    issued_at: strOrNull(r, 'issued_at'),
    issued_by: strOrNull(r, 'issued_by'),
    note: strOrNull(r, 'note'),
    created_at: str(r, 'created_at'),
    updated_at: str(r, 'updated_at'),
  };
}

/** Buyer-facing summary shown on the order page. */
export interface InvoiceSummary { tax_id: string; email: string; status: InvoiceStatus; invoice_no: string | null }

export function toInvoiceSummary(inv: InvoiceRequest | null): InvoiceSummary | null {
  return inv ? { tax_id: inv.tax_id, email: inv.email, status: inv.status, invoice_no: inv.invoice_no } : null;
}

export async function getInvoiceForSource(d1: D1DatabaseLike, kind: InvoiceSourceKind, sourceId: string): Promise<InvoiceRequest | null> {
  const row = await d1.prepare('SELECT * FROM invoice_requests WHERE source_kind = ? AND source_id = ?').bind(kind, sourceId).first<Row>();
  return row ? rowToInvoice(row) : null;
}

/** Records the request next to a freshly created SePay order (one per order). */
export async function createInvoiceRequest(
  d1: D1DatabaseLike,
  input: { kind: InvoiceSourceKind; sourceId: string; sourceCode: string; userId: string | null; invoice: InvoiceInput; description: string; amountVnd: number },
): Promise<void> {
  const now = iso(membersRuntime.now());
  try {
    await d1.prepare(
      `INSERT INTO invoice_requests (id, source_kind, source_id, source_code, user_id, tax_id, email, description, amount_vnd, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', ?, ?)`
    ).bind(randomId('inv'), input.kind, input.sourceId, input.sourceCode, input.userId, input.invoice.taxId, input.invoice.email,
      input.description.slice(0, 300), input.amountVnd, now, now).run();
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

/**
 * The order was paid: the request becomes `requested` and every admin is emailed once. Safe to call from every
 * fulfilment path (webhook, reconciliation, admin grant); only the first call changes anything. Email failures
 * are logged and never undo the payment.
 */
export async function activateInvoiceRequest(
  d1: D1DatabaseLike, env: RuntimeEnv, kind: InvoiceSourceKind, sourceId: string, amountPaidVnd: number | null,
): Promise<void> {
  const now = iso(membersRuntime.now());
  const res = await d1.prepare(
    "UPDATE invoice_requests SET status = 'requested', amount_paid_vnd = ?, paid_at = ?, updated_at = ? WHERE source_kind = ? AND source_id = ? AND status = 'awaiting_payment'"
  ).bind(amountPaidVnd, now, now, kind, sourceId).run();
  if (res.meta?.changes !== 1) return;
  const inv = await getInvoiceForSource(d1, kind, sourceId);
  if (!inv) return;
  const content = invoiceRequestEmail({
    sourceCode: inv.source_code,
    description: inv.description,
    taxId: inv.tax_id,
    email: inv.email,
    amountVnd: inv.amount_paid_vnd ?? inv.amount_vnd,
    paidAt: inv.paid_at ?? now,
    studioUrl: `${siteUrl(env)}/studio#invoices`,
  });
  for (const admin of adminEmailList(env)) {
    try {
      const mail = await sendLoggedEmail(d1, env, { key: `invoice-request:${inv.id}:${admin}`, kind: 'invoice_request', to: admin, userId: null, ...content });
      if (mail.status !== 'sent' && mail.status !== 'duplicate') console.warn(`invoice request email for ${inv.source_code} ${mail.status}`);
    } catch (err) {
      console.error(`invoice request email for ${inv.source_code} failed:`, err instanceof Error ? err.message : 'unknown');
    }
  }
}

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

export function parseInvoiceStatus(value: unknown): InvoiceStatus | null {
  if (value === undefined || value === null || value === '' || value === 'all') return null;
  const found = INVOICE_STATUSES.find(s => s === value);
  if (!found) throw new AppError(400, 'invalid_field', `status must be one of ${INVOICE_STATUSES.join(', ')} or all`, { field: 'status' });
  return found;
}

/** Admin: requests newest first; by default only paid requests that still need an invoice. */
export async function listInvoiceRequests(d1: D1DatabaseLike, filter: { status?: InvoiceStatus | null; limit?: number } = {}): Promise<InvoiceRequest[]> {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 1000);
  const stmt = filter.status
    ? d1.prepare('SELECT * FROM invoice_requests WHERE status = ? ORDER BY COALESCE(paid_at, created_at) DESC LIMIT ?').bind(filter.status, limit)
    : d1.prepare('SELECT * FROM invoice_requests ORDER BY COALESCE(paid_at, created_at) DESC LIMIT ?').bind(limit);
  const { results } = await stmt.all<Row>();
  return (results ?? []).map(rowToInvoice);
}

/** Admin: records the issued invoice number (paid requests only). Repeating it updates the number. */
export async function markInvoiceIssued(d1: D1DatabaseLike, id: string, body: Record<string, unknown>, actor: string): Promise<InvoiceRequest> {
  const invoiceNo = typeof body.invoice_no === 'string' ? body.invoice_no.trim() : '';
  if (!invoiceNo || invoiceNo.length > 64) throw new AppError(400, 'invalid_field', 'invoice_no is required (max 64 characters)', { field: 'invoice_no' });
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) || null : null;
  const now = iso(membersRuntime.now());
  const res = await d1.prepare(
    `UPDATE invoice_requests SET status = 'issued', invoice_no = ?, note = COALESCE(?, note), issued_at = COALESCE(issued_at, ?), issued_by = ?, updated_at = ?
     WHERE id = ? AND status IN ('requested', 'issued')`
  ).bind(invoiceNo, note, now, actor, now, id).run();
  const row = await d1.prepare('SELECT * FROM invoice_requests WHERE id = ?').bind(id).first<Row>();
  if (!row) throw new AppError(404, 'not_found', 'Invoice request not found');
  if (res.meta?.changes !== 1) throw new AppError(409, 'invalid_state', 'Only paid invoice requests can be marked issued', { status: str(row, 'status') });
  return rowToInvoice(row);
}

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  // Leading =, +, - or @ would run as a formula in a spreadsheet.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** Admin: CSV for the accountant (default: paid requests still waiting for an invoice). */
export async function invoiceRequestsCsv(d1: D1DatabaseLike, status: InvoiceStatus | null): Promise<string> {
  const rows = await listInvoiceRequests(d1, { status, limit: 1000 });
  const header = ['source_code', 'source_kind', 'description', 'tax_id', 'email', 'amount_vnd', 'amount_paid_vnd', 'paid_at', 'status', 'invoice_no', 'issued_at', 'note'];
  const lines = rows.map(r => [r.source_code, r.source_kind, r.description, r.tax_id, r.email, r.amount_vnd, r.amount_paid_vnd, r.paid_at, r.status, r.invoice_no, r.issued_at, r.note]
    .map(csvCell).join(','));
  return [header.join(','), ...lines].join('\n') + '\n';
}
