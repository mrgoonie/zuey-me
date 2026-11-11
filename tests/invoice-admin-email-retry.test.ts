import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createTestD1 } from './helpers/d1';
import type { RuntimeEnv } from '../src/env';
import { activateInvoiceRequest, createInvoiceRequest, getInvoiceForSource } from '../src/lib/promos/invoice-requests';
import { membersRuntime } from '../src/lib/members/runtime';

const T0 = Date.parse('2026-10-05T00:00:00.000Z');

let d1: ReturnType<typeof createTestD1>;
let sent: string[];
let resendStatus: number;

function env(): RuntimeEnv {
  return { DB: d1, PUBLIC_SITE_URL: 'https://zuey.test', MEMBER_HASH_SALT: 'salt', RESEND_API_KEY: 're_test', ADMIN_EMAILS: 'boss@example.com,ops@example.com' };
}

async function fakeFetch(_input: string, init?: RequestInit): Promise<Response> {
  if (resendStatus !== 200) return new Response('{"message":"boom"}', { status: resendStatus });
  const parsed: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
  const to = typeof parsed === 'object' && parsed !== null && 'to' in parsed ? parsed.to : '';
  sent.push(Array.isArray(to) ? String(to[0]) : String(to));
  return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function seedRequest(): Promise<void> {
  await createInvoiceRequest(d1, {
    kind: 'billing_order', sourceId: 'ord_1', sourceCode: 'ZY-1', userId: null,
    invoice: { taxId: '0312345678', email: 'ketoan@acme.vn' }, description: 'AI plan', amountVnd: 500_000,
  });
}

beforeEach(() => {
  d1 = createTestD1();
  sent = [];
  resendStatus = 200;
  membersRuntime.now = () => T0;
  membersRuntime.fetch = fakeFetch;
});

afterEach(() => {
  membersRuntime.now = () => Date.now();
});

describe('invoice request admin email retry', () => {
  it('emails each admin exactly once across repeated calls', async () => {
    await seedRequest();
    await activateInvoiceRequest(d1, env(), 'billing_order', 'ord_1', 500_000);
    await activateInvoiceRequest(d1, env(), 'billing_order', 'ord_1', 500_000);
    expect(sent.sort()).toEqual(['boss@example.com', 'ops@example.com']);
  });

  it('sends the email on retry when the worker died right after the status update', async () => {
    await seedRequest();
    // The crashed run committed the status change but never reached the email step.
    await d1.prepare("UPDATE invoice_requests SET status = 'requested', amount_paid_vnd = 500000, paid_at = ? WHERE source_id = 'ord_1'").bind(new Date(T0).toISOString()).run();
    expect(sent).toHaveLength(0);

    await activateInvoiceRequest(d1, env(), 'billing_order', 'ord_1', 500_000);
    expect(sent.sort()).toEqual(['boss@example.com', 'ops@example.com']);

    await activateInvoiceRequest(d1, env(), 'billing_order', 'ord_1', 500_000);
    expect(sent).toHaveLength(2);
    const log = await d1.prepare("SELECT COUNT(*) AS n FROM email_log WHERE kind = 'invoice_request' AND status = 'sent'").first<{ n: number }>();
    expect(log?.n).toBe(2);
  });

  it('retries a failed send and then stops', async () => {
    await seedRequest();
    resendStatus = 500;
    await activateInvoiceRequest(d1, env(), 'billing_order', 'ord_1', 500_000);
    expect(sent).toHaveLength(0);
    expect((await getInvoiceForSource(d1, 'billing_order', 'ord_1'))?.status).toBe('requested');

    resendStatus = 200;
    await activateInvoiceRequest(d1, env(), 'billing_order', 'ord_1', 500_000);
    await activateInvoiceRequest(d1, env(), 'billing_order', 'ord_1', 500_000);
    expect(sent.sort()).toEqual(['boss@example.com', 'ops@example.com']);
  });

  it('does not email for an unknown request or once the invoice is issued', async () => {
    await activateInvoiceRequest(d1, env(), 'billing_order', 'missing', null);
    await seedRequest();
    await d1.prepare("UPDATE invoice_requests SET status = 'issued', invoice_no = 'X1', paid_at = ? WHERE source_id = 'ord_1'").bind(new Date(T0).toISOString()).run();
    await activateInvoiceRequest(d1, env(), 'billing_order', 'ord_1', 500_000);
    expect(sent).toHaveLength(0);
  });
});
