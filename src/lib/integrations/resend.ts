import type { RuntimeEnv } from '../../env';
import type { FetchLike, IntegrationStatus } from './google-calendar';

export const DEFAULT_RESEND_FROM = 'Zuey <hi@zuey.me>';

export interface EmailAttachment {
  filename: string;
  /** Base64-encoded content. */
  content: string;
  content_type?: string;
}

export interface EmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

export interface EmailResult {
  status: IntegrationStatus;
  id?: string;
  error?: string;
}

/** Sends a transactional email through Resend; never throws. */
export async function sendEmail(env: RuntimeEnv, input: EmailInput, fetchImpl: FetchLike): Promise<EmailResult> {
  if (!env.RESEND_API_KEY) return { status: 'unconfigured', error: 'resend_unconfigured' };
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.RESEND_FROM || DEFAULT_RESEND_FROM,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        attachments: input.attachments,
      }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) return { status: 'failed', error: `resend_${res.status}` };
    const id = typeof body === 'object' && body !== null && 'id' in body && typeof body.id === 'string' ? body.id : undefined;
    return { status: 'sent', id };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message.slice(0, 120) : 'resend_error' };
  }
}

/** Resend accepts at most this many emails per batch request. */
export const RESEND_BATCH_LIMIT = 100;

export interface BulkEmailInput extends EmailInput {
  /** Overrides RESEND_FROM (e.g. a dedicated newsletter sender). */
  from?: string;
  replyTo?: string;
  /** Extra headers such as List-Unsubscribe. */
  headers?: Record<string, string>;
}

export interface BatchEmailResult {
  status: IntegrationStatus;
  /** Per input, in order: provider id or the per-email validation error. Empty when the whole request failed. */
  items: { id?: string; error?: string }[];
  error?: string;
  /** True when the whole request may be retried later (rate limit, 5xx, network). */
  retryable?: boolean;
  /** HTTP status of a rejected request; absent on network errors (outcome unknown). */
  httpStatus?: number;
}

function batchItems(body: unknown, count: number): { id?: string; error?: string }[] {
  const items: { id?: string; error?: string }[] = Array.from({ length: count }, () => ({}));
  if (typeof body !== 'object' || body === null) return items;
  const data = 'data' in body && Array.isArray(body.data) ? body.data : [];
  const errors = 'errors' in body && Array.isArray(body.errors) ? body.errors : [];
  // Permissive validation returns ids for accepted emails in order, skipping the rejected indexes listed in `errors`.
  const rejected = new Map<number, string>();
  for (const e of errors) {
    if (typeof e === 'object' && e !== null && 'index' in e && typeof e.index === 'number') {
      rejected.set(e.index, 'message' in e && typeof e.message === 'string' ? e.message.slice(0, 120) : 'rejected');
    }
  }
  let next = 0;
  for (let i = 0; i < count; i++) {
    const reason = rejected.get(i);
    if (reason !== undefined) { items[i] = { error: reason }; continue; }
    const d: unknown = data[next++];
    items[i] = typeof d === 'object' && d !== null && 'id' in d && typeof d.id === 'string' ? { id: d.id } : { error: 'missing_id' };
  }
  return items;
}

/**
 * Sends up to RESEND_BATCH_LIMIT emails in one Resend batch request (permissive validation: one bad address does not
 * reject the rest). `idempotencyKey` makes a retried request a no-op on Resend's side for 24 hours. Never throws.
 */
export async function sendEmailBatch(
  env: RuntimeEnv, inputs: BulkEmailInput[], fetchImpl: FetchLike, idempotencyKey?: string,
): Promise<BatchEmailResult> {
  if (!env.RESEND_API_KEY) return { status: 'unconfigured', items: [], error: 'resend_unconfigured' };
  if (inputs.length === 0) return { status: 'sent', items: [] };
  if (inputs.length > RESEND_BATCH_LIMIT) return { status: 'failed', items: [], error: 'batch_too_large' };
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      'x-batch-validation': 'permissive',
    };
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
    const res = await fetchImpl('https://api.resend.com/emails/batch', {
      method: 'POST',
      headers,
      body: JSON.stringify(inputs.map(input => ({
        from: input.from || env.RESEND_FROM || DEFAULT_RESEND_FROM,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        ...(input.headers ? { headers: input.headers } : {}),
      }))),
    });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) return { status: 'failed', items: [], error: `resend_${res.status}`, retryable: res.status === 429 || res.status >= 500, httpStatus: res.status };
    return { status: 'sent', items: batchItems(body, inputs.length) };
  } catch (err) {
    return { status: 'failed', items: [], error: err instanceof Error ? err.message.slice(0, 120) : 'resend_error', retryable: true };
  }
}
