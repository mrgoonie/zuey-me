import { describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { GET as checkoutMd } from '../src/pages/checkout.md';
import { GET as llmsTxt } from '../src/pages/llms.txt';
import { GET as llmsFull } from '../src/pages/llms-full.txt';
import { GET as indexMd } from '../src/pages/index.md';
import { PLAN_IDS, BILLING_MONTHS } from '../src/lib/members/plans';

const ctx = (url = 'https://zuey.me/checkout.md', env: Record<string, string> = {}) =>
  ({ request: new Request(url), locals: { runtime: { env } } }) as unknown as APIContext;

async function body(r: Response | Promise<Response>): Promise<string> {
  return (await r).text();
}

describe('/checkout.md', () => {
  it('is public markdown with a short shared cache', async () => {
    const res = await checkoutMd(ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('covers every required section and the live endpoints', async () => {
    const md = await body(checkoutMd(ctx()));
    for (const h of ['## If the user asks you to buy', '## Membership', '## Courses', '## Consultation', '## Connected agents: MCP and REST', '## Handoff to the human', '## Order status', '## Security rules', '## Terms and support']) {
      expect(md).toContain(h);
    }
    for (const id of PLAN_IDS) expect(md).toContain(`\`${id}\``);
    for (const m of BILLING_MONTHS.filter(m => m > 1)) expect(md).toContain(`\`${m}\``);
    for (const needle of ['https://zuey.me/api/v1/plans', 'https://zuey.me/pricing?plan=', 'https://zuey.me/courses.md', 'https://zuey.me/mcp', 'https://zuey.me/business', 'https://zuey.me/api/v1/billing/orders', 'https://zuey.me/api/v1/courses/{course}/checkout', 'checkout:write', 'billing:read', 'billing_checkout_create', 'billing_order_get', 'course_checkout_create', 'course_order_get', 'accept_terms', 'transfer.qr_url', 'needs_attention']) {
      expect(md).toContain(needle);
    }
  });

  it('uses the configured public origin for every link', async () => {
    const md = await body(checkoutMd(ctx('https://preview.example/checkout.md', { PUBLIC_SITE_URL: 'https://staging.zuey.me/' })));
    expect(md).toContain('https://staging.zuey.me/mcp');
    expect(md).not.toContain('https://zuey.me/');
  });

  it('contains no secrets, personal data or static bank details', async () => {
    const md = await body(checkoutMd(ctx('https://zuey.me/checkout.md', { SEPAY_BANK_ACCOUNT: '9999000011', SEPAY_BANK_CODE: 'ACB', SEPAY_API_KEY: 'sepay-secret-value' })));
    expect(md).not.toContain('9999000011');
    expect(md).not.toContain('sepay-secret-value');
    expect(md).not.toMatch(/zk_[A-Za-z0-9]/);
    expect(md).not.toMatch(/qr\.sepay\.vn/);
    expect(md).not.toMatch(/\bZ(SB|SC|BK)[A-Z0-9]{6,}\b/);
    expect(md).not.toMatch(/[?&](key|token|api_key)=/i);
    // The only legacy endpoint mention is the warning against it.
    expect(md).toContain('/api/mcp');
    expect(md).toMatch(/legacy[^\n]*admin endpoint/i);
  });

  it('never invites spending, inventing values or accepting terms for the user', async () => {
    const md = await body(checkoutMd(ctx()));
    expect(md).toMatch(/never pay for them/i);
    expect(md).toMatch(/not permission to spend/i);
    expect(md).toMatch(/Never auto-accept terms/);
    expect(md).toMatch(/Do not invent a QR code, bank account number, amount/);
    expect(md).not.toMatch(/\$\s?\d/);
  });
});

describe('discovery', () => {
  it('links /checkout.md from llms.txt, llms-full.txt and index.md and prefers /mcp', async () => {
    const [llms, full, index] = await Promise.all([body(llmsTxt(ctx('https://zuey.me/llms.txt'))), body(llmsFull(ctx('https://zuey.me/llms-full.txt'))), body(indexMd(ctx('https://zuey.me/index.md')))]);
    for (const text of [llms, full, index]) expect(text).toContain('https://zuey.me/checkout.md');
    for (const text of [llms, full]) {
      expect(text).toContain('https://zuey.me/mcp');
      expect(text).toMatch(/legacy admin endpoint: https:\/\/zuey\.me\/api\/mcp/);
    }
  });
});
