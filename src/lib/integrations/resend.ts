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
