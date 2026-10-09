import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';

export const SEPAY_CODE_PREFIX = 'ZBK';
/** Membership billing orders: the full order code (e.g. ZSB7K2M9QXA) is the transfer content. */
export const SEPAY_BILLING_PREFIX = 'ZSB';
/** Course orders: the full order code (e.g. ZSC7K2M9QXA) is the transfer content. */
export const SEPAY_COURSE_PREFIX = 'ZSC';
const CODE_BODY = '[A-Z0-9]{8}';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function parseVndPrice(env: RuntimeEnv): number | null {
  const raw = (env.CONSULTATION_PRICE_VND ?? '').trim();
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

/** Bank details and webhook key required for any SePay transfer to be shown and confirmed. */
export function missingSepayBankConfig(env: RuntimeEnv): string[] {
  const missing: string[] = [];
  if (!env.SEPAY_BANK_ACCOUNT) missing.push('SEPAY_BANK_ACCOUNT');
  if (!env.SEPAY_BANK_CODE) missing.push('SEPAY_BANK_CODE');
  if (!env.SEPAY_WEBHOOK_API_KEY) missing.push('SEPAY_WEBHOOK_API_KEY');
  return missing;
}

export function missingSepayConfig(env: RuntimeEnv): string[] {
  const missing = missingSepayBankConfig(env);
  if (parseVndPrice(env) === null) missing.push('CONSULTATION_PRICE_VND');
  return missing;
}

export interface SepayTransferInfo {
  provider: 'sepay';
  bank_account: string;
  bank_code: string;
  amount: number;
  currency: 'VND';
  transfer_content: string;
  qr_url: string;
}

export function transferContent(code: string): string {
  return `${SEPAY_CODE_PREFIX}${code}`;
}

/** VietQR transfer instructions for an amount and transfer content; no API call is made. */
export function vietQrTransfer(env: RuntimeEnv, amount: number, content: string): SepayTransferInfo {
  const account = env.SEPAY_BANK_ACCOUNT ?? '';
  const bank = env.SEPAY_BANK_CODE ?? '';
  const qs = new URLSearchParams({ acc: account, bank, amount: String(amount), des: content });
  return {
    provider: 'sepay',
    bank_account: account,
    bank_code: bank,
    amount,
    currency: 'VND',
    transfer_content: content,
    qr_url: `https://qr.sepay.vn/img?${qs.toString()}`,
  };
}

/** Builds VietQR transfer instructions for a consultation booking; no API call is made. */
export function buildSepayTransfer(env: RuntimeEnv, code: string): SepayTransferInfo {
  const missing = missingSepayConfig(env);
  const amount = parseVndPrice(env);
  if (missing.length > 0 || amount === null) {
    throw new AppError(503, 'payment_unconfigured', `SePay bank transfer is not configured: missing ${missing.join(', ')}`, { missing });
  }
  return vietQrTransfer(env, amount, transferContent(code));
}

/** Constant-time comparison of two secrets via SHA-256 digests. */
export async function timingSafeEqualStrings(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const va = new Uint8Array(da);
  const vb = new Uint8Array(db);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

/** Checks `Authorization: Apikey <SEPAY_WEBHOOK_API_KEY>`. */
export async function verifySepayAuthorization(env: RuntimeEnv, header: string | null): Promise<boolean> {
  const expected = env.SEPAY_WEBHOOK_API_KEY;
  if (!expected || !header) return false;
  const match = /^Apikey\s+(.+)$/i.exec(header.trim());
  if (!match) return false;
  return timingSafeEqualStrings(match[1].trim(), expected);
}

export interface SepayTransfer {
  eventId: string;
  direction: 'in' | 'out';
  amount: number;
  content: string;
  referenceCode: string | null;
  bookingCode: string | null;
  /** Full membership order code (ZSB + 8 characters) when the content carries one. */
  billingCode: string | null;
  /** Full course order code (ZSC + 8 characters) when the content carries one. */
  courseCode: string | null;
  /** When the bank booked the transfer (epoch ms), or null when SePay sent no readable time. */
  transactedAt: number | null;
}

/** Parses SePay's `YYYY-MM-DD HH:mm:ss` bank time, which is Vietnam local time (UTC+7). */
export function parseSepayTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/.exec(value.trim());
  if (!m) return null;
  const ms = Date.parse(`${m[1]}T${m[2]}+07:00`);
  return Number.isFinite(ms) ? ms : null;
}

/** Extracts a ZSB membership order code from free-form transfer content. */
export function extractBillingCode(content: string): string | null {
  const match = new RegExp(`${SEPAY_BILLING_PREFIX}(${CODE_BODY})`, 'i').exec(content);
  return match ? `${SEPAY_BILLING_PREFIX}${match[1].toUpperCase()}` : null;
}

/** Extracts a ZSC course order code from free-form transfer content. */
export function extractCourseOrderCode(content: string): string | null {
  const match = new RegExp(`${SEPAY_COURSE_PREFIX}(${CODE_BODY})`, 'i').exec(content);
  return match ? `${SEPAY_COURSE_PREFIX}${match[1].toUpperCase()}` : null;
}

/** Validates the SePay webhook payload shape and extracts the ZBK booking / ZSB order codes. */
export function parseSepayPayload(payload: unknown): SepayTransfer | null {
  if (!isRecord(payload)) return null;
  const id = typeof payload.id === 'number' || typeof payload.id === 'string' ? String(payload.id) : null;
  const amount = typeof payload.transferAmount === 'number' ? payload.transferAmount : Number(payload.transferAmount);
  const direction = payload.transferType === 'in' ? 'in' : payload.transferType === 'out' ? 'out' : null;
  if (!id || !direction || !Number.isFinite(amount)) return null;
  const content = typeof payload.content === 'string' ? payload.content : '';
  const match = new RegExp(`${SEPAY_CODE_PREFIX}(${CODE_BODY})`, 'i').exec(content);
  return {
    eventId: id,
    direction,
    amount: Math.round(amount),
    content,
    referenceCode: typeof payload.referenceCode === 'string' ? payload.referenceCode : null,
    bookingCode: match ? match[1].toUpperCase() : null,
    billingCode: extractBillingCode(content),
    courseCode: extractCourseOrderCode(content),
    transactedAt: parseSepayTime(payload.transactionDate),
  };
}
