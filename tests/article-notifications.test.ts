import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { APIContext } from 'astro';
import { createTestD1 } from './helpers/d1';
import type { D1DatabaseLike } from '../src/db/store';
import type { RuntimeEnv } from '../src/env';
import { createArticle, deleteArticle, getArticleView, publishArticle, updateArticle } from '../src/lib/blocks/articles';
import type { ArticleDocument } from '../src/lib/blocks/schema';
import { membersRuntime } from '../src/lib/members/runtime';
import { findOrCreateVerifiedUser } from '../src/lib/members/users';
import {
  getArticleEmailSubscription, suppressionReason, unsubscribeToken, verifyUnsubscribeToken,
} from '../src/lib/notifications/article-email-subscription';
import { renderArticleEmail, withFooter } from '../src/lib/notifications/article-email-render';
import {
  dispatchArticleNotifications, dispatchRuntime, isQuietHour, quietHours, warmupDailyLimit,
} from '../src/lib/notifications/article-notification-dispatch';
import { ARTICLE_EMAIL_DELAY_MS, getArticleNotification } from '../src/lib/notifications/article-notification-schedule';
import { signStandardWebhook } from '../src/lib/payments/standard-webhooks';
import { POST as dispatchApi } from '../src/pages/api/v1/articles/notifications/dispatch';
import { POST as unsubscribeApi } from '../src/pages/api/email/unsubscribe';
import { POST as resendWebhook } from '../src/pages/api/webhooks/resend';
import { isForbiddenCrossSiteSubmission } from '../src/lib/csrf-origin-check';

const SALT = 'test-member-salt';
const WEBHOOK_SECRET = `whsec_${btoa('resend-webhook-test-key')}`;

interface SentEmail { from: string; to: string[]; subject: string; html: string; text: string; headers?: Record<string, string> }

const realNow = membersRuntime.now;
const realFetch = membersRuntime.fetch;
const realSleep = dispatchRuntime.sleep;
let sent: SentEmail[];
let batchStatus: number;

function baseEnv(d1: D1DatabaseLike, extra: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return { DB: d1, RESEND_API_KEY: 're_test', MEMBER_HASH_SALT: SALT, PUBLIC_SITE_URL: 'https://zuey.me', ARTICLE_EMAIL_QUIET_HOURS: 'off', ...extra };
}

/** Moves the dispatcher clock past the 30-minute delay of anything published "now". */
function afterDelay(): void {
  const at = Date.now() + ARTICLE_EMAIL_DELAY_MS + 60_000;
  membersRuntime.now = () => at;
}

function paragraphs(prefix: string, n: number): ArticleDocument {
  return { version: 1, blocks: Array.from({ length: n }, (_, i) => ({ id: `p${i}`, type: 'paragraph' as const, text: `${prefix} paragraph ${i} with enough words to weigh something.` })) };
}

async function member(d1: D1DatabaseLike, email: string, locale = 'vi'): Promise<string> {
  const { user } = await findOrCreateVerifiedUser(d1, { email });
  await d1.prepare('UPDATE users SET locale = ? WHERE id = ?').bind(locale, user.id).run();
  return user.id;
}

async function grantKnowledges(d1: D1DatabaseLike, userId: string): Promise<void> {
  const now = new Date().toISOString();
  await d1.prepare("INSERT INTO subscriptions (id, user_id, plan, status, current_period_end, created_at, updated_at) VALUES (?, ?, 'knowledges', 'active', ?, ?, ?)")
    .bind(`sub_${userId}`, userId, new Date(Date.now() + 30 * 86_400_000).toISOString(), now, now).run();
}

async function publishNew(d1: D1DatabaseLike, slug: string, opts: { access?: 'free' | 'knowledges'; notify?: unknown; publishedAt?: string; doc?: ArticleDocument } = {}) {
  const created = await createArticle(d1, { slug, title: `Title ${slug}`, excerpt: `Excerpt ${slug}`, locale: 'vi', access: opts.access ?? 'free', document: opts.doc ?? paragraphs('Vi', 6) });
  return publishArticle(d1, slug, created.revision, true, { notify: opts.notify, publishedAt: opts.publishedAt });
}

function ctx(request: Request, env: RuntimeEnv): APIContext {
  return { request, url: new URL(request.url), params: {}, locals: { runtime: { env } } } as unknown as APIContext;
}

beforeEach(() => {
  sent = [];
  batchStatus = 200;
  // Other suites may leave a fake clock behind; webhook signatures and schedules here use real time.
  membersRuntime.now = () => Date.now();
  dispatchRuntime.sleep = async () => {};
  membersRuntime.fetch = async (input: string, init?: RequestInit) => {
    if (!String(input).endsWith('/emails/batch')) throw new Error(`unexpected fetch ${input}`);
    if (batchStatus !== 200) return new Response(JSON.stringify({ message: 'rate limited' }), { status: batchStatus });
    const emails = JSON.parse(String(init?.body)) as SentEmail[];
    sent.push(...emails);
    return new Response(JSON.stringify({ data: emails.map((_, i) => ({ id: `em_${sent.length}_${i}` })) }), { status: 200 });
  };
});

afterEach(() => {
  membersRuntime.now = realNow;
  membersRuntime.fetch = realFetch;
  dispatchRuntime.sleep = realSleep;
});

describe('publish schedules the member email', () => {
  it('schedules the first publish 30 minutes later and never again on republish', async () => {
    const d1 = createTestD1();
    const before = Date.now();
    const rec = await publishNew(d1, 'first');
    expect(rec.email_notification?.status).toBe('scheduled');
    const sendAfter = Date.parse(rec.email_notification?.send_after ?? '');
    expect(sendAfter - before).toBeGreaterThanOrEqual(ARTICLE_EMAIL_DELAY_MS);
    expect(sendAfter - Date.now()).toBeLessThanOrEqual(ARTICLE_EMAIL_DELAY_MS);

    const again = await publishArticle(d1, 'first', rec.revision, true);
    expect(again.email_notification?.send_after).toBe(rec.email_notification?.send_after);
  });

  it('skips when the publisher opts out or backdates, and lets an explicit notify schedule later', async () => {
    const d1 = createTestD1();
    const off = await publishNew(d1, 'quiet', { notify: false });
    expect(off.email_notification).toMatchObject({ status: 'skipped', reason: 'publisher_opted_out' });
    const old = await publishNew(d1, 'archive', { publishedAt: '2024-01-02T03:04:05Z' });
    expect(old.email_notification).toMatchObject({ status: 'skipped', reason: 'backdated' });
    const plainRepublish = await publishArticle(d1, 'archive', old.revision, true);
    expect(plainRepublish.email_notification?.status).toBe('skipped');
    const explicit = await publishArticle(d1, 'archive', plainRepublish.revision, true, { notify: true });
    expect(explicit.email_notification?.status).toBe('scheduled');
    const cancelled = await publishArticle(d1, 'archive', explicit.revision, true, { notify: false });
    expect(cancelled.email_notification?.status).toBe('skipped');
  });

  it('rejects a non-boolean notify before publishing', async () => {
    const d1 = createTestD1();
    const created = await createArticle(d1, { slug: 'bad-flag', title: 'T', locale: 'vi', document: paragraphs('x', 1) });
    await expect(publishArticle(d1, 'bad-flag', created.revision, true, { notify: 'soon' })).rejects.toMatchObject({ code: 'invalid_field' });
    expect((await getArticleView(d1, 'bad-flag', { isAdmin: false, entitlements: [] }))).toBeNull();
  });

  it('shows the email state on the admin draft view only', async () => {
    const d1 = createTestD1();
    await publishNew(d1, 'visible');
    const admin = await getArticleView(d1, 'visible', { isAdmin: true, entitlements: [] }, { draft: true });
    expect(admin?.email_notification?.status).toBe('scheduled');
    const reader = await getArticleView(d1, 'visible', { isAdmin: false, entitlements: [] });
    expect(reader && 'email_notification' in reader).toBe(false);
  });

  it('cancels a pending email when the article is deleted', async () => {
    const d1 = createTestD1();
    const rec = await publishNew(d1, 'gone');
    await deleteArticle(d1, 'gone');
    expect((await getArticleNotification(d1, rec.id))?.status).toBe('cancelled');
  });

  it('migration backfill marks articles published before the feature as skipped', async () => {
    const d1 = createTestD1();
    const rec = await publishNew(d1, 'legacy');
    await d1.prepare('DELETE FROM article_notifications').run();
    const sql = (await Bun.file(new URL('../migrations/0013_article_email_notifications.sql', import.meta.url)).text())
      .split(';').find(stmt => stmt.includes('INSERT OR IGNORE INTO article_notifications'));
    await d1.prepare(sql ?? '').run();
    expect(await getArticleNotification(d1, rec.id)).toMatchObject({ status: 'skipped', reason: 'published_before_notifications' });
  });
});

describe('dispatching article emails', () => {
  it('waits for the delay, then emails verified members once with the latest edit', async () => {
    const d1 = createTestD1();
    const env = baseEnv(d1);
    await member(d1, 'a@example.com');
    await member(d1, 'b@example.com');
    const rec = await publishNew(d1, 'fresh');

    const early = await dispatchArticleNotifications(d1, env);
    expect(early.articles).toEqual([]);
    expect(sent).toHaveLength(0);

    // Edit within the 30 minutes: the email must carry the corrected text.
    const edited = await updateArticle(d1, 'fresh', { locale: 'vi', document: paragraphs('Corrected', 6) }, rec.revision);
    await publishArticle(d1, 'fresh', edited.revision, true);

    afterDelay();
    const first = await dispatchArticleNotifications(d1, env);
    expect(first.articles).toEqual([expect.objectContaining({ slug: 'fresh', status: 'sent', sent: 2, failed: 0 })]);
    expect(sent.map(e => e.to[0]).sort()).toEqual(['a@example.com', 'b@example.com']);
    expect(sent[0].html).toContain('Corrected paragraph 0');
    expect(sent[0].html).not.toContain('Vi paragraph 0');
    expect(sent[0].subject).toBe('Title fresh');
    expect(sent[0].headers?.['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    expect(sent[0].headers?.['List-Unsubscribe']).toMatch(/^<https:\/\/zuey\.me\/api\/email\/unsubscribe\?token=/);
    expect(sent[0].text).toContain('https://zuey.me/unsubscribe?token=');

    const second = await dispatchArticleNotifications(d1, env);
    expect(second.articles).toEqual([]);
    expect(sent).toHaveLength(2);
    expect((await getArticleNotification(d1, rec.id))).toMatchObject({ status: 'sent', sent_count: 2 });
  });

  it('excludes unverified, deleted, opted-out and later-joining members', async () => {
    const d1 = createTestD1();
    const env = baseEnv(d1);
    await member(d1, 'ok@example.com');
    const unverified = await member(d1, 'unverified@example.com');
    await d1.prepare('UPDATE users SET email_verified_at = NULL WHERE id = ?').bind(unverified).run();
    const deleted = await member(d1, 'deleted@example.com');
    await d1.prepare('UPDATE users SET deleted_at = ? WHERE id = ?').bind(new Date().toISOString(), deleted).run();
    const optedOut = await member(d1, 'out@example.com');
    await d1.prepare("UPDATE users SET article_emails_opt_out_at = ?, article_emails_opt_out_reason = 'unsubscribe' WHERE id = ?").bind(new Date().toISOString(), optedOut).run();
    await publishNew(d1, 'audience');
    const late = await member(d1, 'late@example.com');
    await d1.prepare('UPDATE users SET created_at = ? WHERE id = ?').bind(new Date(Date.now() + 2 * ARTICLE_EMAIL_DELAY_MS).toISOString(), late).run();

    afterDelay();
    await dispatchArticleNotifications(d1, env);
    expect(sent.map(e => e.to[0])).toEqual(['ok@example.com']);
  });

  it('sends paid articles in full to entitled members and as a teaser with a subscribe button to others', async () => {
    const d1 = createTestD1();
    const env = baseEnv(d1);
    await member(d1, 'free@example.com');
    const paid = await member(d1, 'paid@example.com');
    await grantKnowledges(d1, paid);
    await publishNew(d1, 'deep-dive', { access: 'knowledges', doc: paragraphs('Body', 9) });

    afterDelay();
    await dispatchArticleNotifications(d1, env);
    const byTo = new Map(sent.map(e => [e.to[0], e]));
    const full = byTo.get('paid@example.com');
    const teaser = byTo.get('free@example.com');
    expect(full?.html).toContain('Body paragraph 8');
    expect(full?.html).not.toContain('/pricing');
    expect(teaser?.html).toContain('Body paragraph 0');
    expect(teaser?.html).not.toContain('Body paragraph 8');
    expect(teaser?.html).toContain('https://zuey.me/pricing?');
    expect(teaser?.text).not.toContain('Body paragraph 8');
  });

  it('uses the member locale edition when published, else the primary edition', async () => {
    const d1 = createTestD1();
    const env = baseEnv(d1);
    await member(d1, 'vi@example.com', 'vi');
    await member(d1, 'en@example.com', 'en');
    await member(d1, 'ja@example.com', 'ja');
    const rec = await publishNew(d1, 'bilingual');
    const withEn = await updateArticle(d1, 'bilingual', { locale: 'en', title: 'English title', document: paragraphs('English', 3) }, rec.revision);
    await publishArticle(d1, 'bilingual', withEn.revision, true, { locale: 'en' });

    afterDelay();
    await dispatchArticleNotifications(d1, env);
    const byTo = new Map(sent.map(e => [e.to[0], e]));
    expect(byTo.get('en@example.com')?.subject).toBe('English title');
    expect(byTo.get('en@example.com')?.html).toContain('Unsubscribe from new-article emails');
    expect(byTo.get('vi@example.com')?.subject).toBe('Title bilingual');
    expect(byTo.get('vi@example.com')?.html).toContain('Huỷ nhận email bài viết mới');
    expect(byTo.get('ja@example.com')?.subject).toBe('Title bilingual');
  });

  it('keeps members for the next run when Resend rejects the whole batch', async () => {
    const d1 = createTestD1();
    const env = baseEnv(d1);
    await member(d1, 'retry@example.com');
    const rec = await publishNew(d1, 'retry');
    afterDelay();
    batchStatus = 429;
    const failed = await dispatchArticleNotifications(d1, env);
    expect(failed.articles[0]).toMatchObject({ status: 'error', error: 'resend_429' });
    expect((await getArticleNotification(d1, rec.id))?.status).toBe('sending');

    batchStatus = 200;
    const retried = await dispatchArticleNotifications(d1, env);
    expect(retried.articles[0]).toMatchObject({ status: 'sent', sent: 1 });
    expect(sent.map(e => e.to[0])).toEqual(['retry@example.com']);
  });

  it('respects the warm-up budget and continues on the next run', async () => {
    const d1 = createTestD1();
    const env = baseEnv(d1, { ARTICLE_EMAIL_DAILY_CAP: '2' });
    for (const n of [1, 2, 3]) await member(d1, `m${n}@example.com`);
    const rec = await publishNew(d1, 'warm');
    afterDelay();
    const first = await dispatchArticleNotifications(d1, env);
    expect(first.daily_limit).toBe(2);
    expect(first.articles[0]).toMatchObject({ status: 'sending', sent: 2 });
    const blocked = await dispatchArticleNotifications(d1, env);
    expect(blocked.articles).toEqual([]);
    expect(sent).toHaveLength(2);

    // A day later the rolling window has room again.
    const nextDay = membersRuntime.now() + 86_400_000 + 1000;
    membersRuntime.now = () => nextDay;
    await dispatchArticleNotifications(d1, env);
    expect(sent).toHaveLength(3);
    expect((await getArticleNotification(d1, rec.id))?.status).toBe('sent');
  });

  it('holds emails during quiet hours', async () => {
    const d1 = createTestD1();
    await member(d1, 'night@example.com');
    await publishNew(d1, 'night');
    const env = baseEnv(d1, { ARTICLE_EMAIL_QUIET_HOURS: '0-24' });
    // 16:00 UTC = 23:00 in Ho Chi Minh City.
    const night = Date.parse('2030-01-01T16:30:00Z');
    membersRuntime.now = () => night;
    const result = await dispatchArticleNotifications(d1, { ...env, ARTICLE_EMAIL_QUIET_HOURS: '23-7' });
    expect(result.quiet_hours).toBe(true);
    expect(sent).toHaveLength(0);
  });

  it('refuses to run without Resend or the unsubscribe signing secret', async () => {
    const d1 = createTestD1();
    await expect(dispatchArticleNotifications(d1, baseEnv(d1, { RESEND_API_KEY: undefined }))).rejects.toMatchObject({ status: 503, code: 'email_unconfigured' });
    await expect(dispatchArticleNotifications(d1, baseEnv(d1, { MEMBER_HASH_SALT: undefined }))).rejects.toMatchObject({ status: 503 });
  });
});

describe('warm-up and quiet hours helpers', () => {
  it('doubles the daily limit from 50 up to the cap', () => {
    const t0 = Date.parse('2030-01-01T00:00:00Z');
    expect(warmupDailyLimit(null, t0, 2000)).toBe(50);
    expect(warmupDailyLimit(t0, t0 + 86_400_000 * 1.5, 2000)).toBe(100);
    expect(warmupDailyLimit(t0, t0 + 86_400_000 * 3, 2000)).toBe(400);
    expect(warmupDailyLimit(t0, t0 + 86_400_000 * 30, 2000)).toBe(2000);
  });

  it('parses quiet hours across midnight in Ho Chi Minh time', () => {
    const hours = quietHours({});
    expect(isQuietHour(Date.parse('2030-01-01T16:30:00Z'), hours)).toBe(true); // 23:30
    expect(isQuietHour(Date.parse('2030-01-01T23:30:00Z'), hours)).toBe(true); // 06:30
    expect(isQuietHour(Date.parse('2030-01-02T00:30:00Z'), hours)).toBe(false); // 07:30
    expect(quietHours({ ARTICLE_EMAIL_QUIET_HOURS: 'off' })).toBeNull();
  });
});

describe('email rendering', () => {
  it('escapes article text and keeps inline formatting', () => {
    const body = renderArticleEmail({
      locale: 'en', title: 'A <b>title</b>', excerpt: 'x', access: 'free', coverUrl: '/media/cover.png',
      document: { version: 1, blocks: [
        { id: 'a', type: 'paragraph', text: '<script>alert(1)</script> **bold** [link](https://example.com)' },
        { id: 'b', type: 'chart', kind: 'bar', labels: ['a'], series: [{ name: 's', data: [1] }] },
      ] },
      articleUrl: 'https://zuey.me/articles/a', pricingUrl: 'https://zuey.me/pricing', siteUrl: 'https://zuey.me', mode: 'full',
    });
    const { html } = withFooter(body, 'en', 'https://zuey.me/unsubscribe?token=t');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('src="https://zuey.me/media/cover.png"');
    expect(html).toContain('View the chart on zuey.me');
    expect(html).toContain('A &lt;b&gt;title&lt;/b&gt;');
  });

  it('stops long articles before Gmail clipping and links to the web', () => {
    const big: ArticleDocument = { version: 1, blocks: Array.from({ length: 400 }, (_, i) => ({ id: `b${i}`, type: 'paragraph' as const, text: 'word '.repeat(80) })) };
    const body = renderArticleEmail({
      locale: 'vi', title: 'Long', excerpt: '', access: 'free', coverUrl: null, document: big,
      articleUrl: 'https://zuey.me/articles/long', pricingUrl: 'https://zuey.me/pricing', siteUrl: 'https://zuey.me', mode: 'full',
    });
    expect(body.html.length).toBeLessThan(90_000);
    expect(body.html).toContain('Đọc toàn bộ bài viết');
  });
});

describe('unsubscribe', () => {
  it('signs tokens per member and rejects tampering', async () => {
    const token = await unsubscribeToken(SALT, 'usr_1');
    expect(await verifyUnsubscribeToken(SALT, token)).toBe('usr_1');
    expect(await verifyUnsubscribeToken(SALT, token.replace('usr_1', 'usr_2'))).toBeNull();
    expect(await verifyUnsubscribeToken('other-salt', token)).toBeNull();
    expect(await verifyUnsubscribeToken(null, token)).toBeNull();
  });

  it('handles RFC 8058 one-click posts without an Origin header', async () => {
    const d1 = createTestD1();
    const userId = await member(d1, 'click@example.com');
    const token = await unsubscribeToken(SALT, userId);
    const url = `https://zuey.me/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
    const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
    expect(isForbiddenCrossSiteSubmission(request, new URL(url))).toBe(false);
    const res = await unsubscribeApi(ctx(request, baseEnv(d1)));
    expect(res.status).toBe(200);
    expect(await getArticleEmailSubscription(d1, userId)).toMatchObject({ subscribed: false, reason: 'unsubscribe' });
  });

  it('lets the page form resubscribe and redirects back', async () => {
    const d1 = createTestD1();
    const userId = await member(d1, 'back@example.com');
    const token = await unsubscribeToken(SALT, userId);
    const post = (action: string) => unsubscribeApi(ctx(new Request('https://zuey.me/api/email/unsubscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://zuey.me' },
      body: new URLSearchParams({ token, action }).toString(),
    }), baseEnv(d1)));
    const off = await post('unsubscribe');
    expect(off.status).toBe(303);
    expect(off.headers.get('location')).toContain('done=unsubscribed');
    const on = await post('resubscribe');
    expect(on.headers.get('location')).toContain('done=resubscribed');
    expect((await getArticleEmailSubscription(d1, userId))?.subscribed).toBe(true);
  });

  it('rejects an invalid token', async () => {
    const d1 = createTestD1();
    const res = await unsubscribeApi(ctx(new Request('https://zuey.me/api/email/unsubscribe?token=usr_x.bad', { method: 'POST' }), baseEnv(d1)));
    expect(res.status).toBe(400);
  });
});

describe('Resend webhook suppression', () => {
  async function deliver(d1: D1DatabaseLike, payload: unknown, signed = true): Promise<Response> {
    const body = JSON.stringify(payload);
    const id = 'msg_1';
    const ts = String(Math.floor(Date.now() / 1000));
    const signature = signed ? await signStandardWebhook(WEBHOOK_SECRET, id, ts, body) : 'v1,AAAA';
    const request = new Request('https://zuey.me/api/webhooks/resend', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': signature }, body,
    });
    return resendWebhook(ctx(request, baseEnv(d1, { RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET })));
  }

  it('suppresses hard bounces and complaints, ignores soft bounces and bad signatures', async () => {
    const d1 = createTestD1();
    const bounced = await member(d1, 'bounce@example.com');
    const soft = await member(d1, 'soft@example.com');
    const complainer = await member(d1, 'spam@example.com');

    expect((await deliver(d1, { type: 'email.bounced', data: { to: ['bounce@example.com'], bounce: { type: 'Permanent' } } }, false)).status).toBe(401);
    expect((await getArticleEmailSubscription(d1, bounced))?.subscribed).toBe(true);

    await deliver(d1, { type: 'email.bounced', data: { to: ['bounce@example.com'], bounce: { type: 'Permanent' } } });
    await deliver(d1, { type: 'email.bounced', data: { to: ['soft@example.com'], bounce: { type: 'Transient' } } });
    await deliver(d1, { type: 'email.complained', data: { to: ['Spam@Example.com'] } });
    expect(await getArticleEmailSubscription(d1, bounced)).toMatchObject({ subscribed: false, reason: 'bounce' });
    expect((await getArticleEmailSubscription(d1, soft))?.subscribed).toBe(true);
    expect(await getArticleEmailSubscription(d1, complainer)).toMatchObject({ subscribed: false, reason: 'complaint' });
    expect(suppressionReason({ type: 'email.delivered' })).toBeNull();
  });
});

describe('dispatch endpoint auth', () => {
  it('accepts the cron secret and rejects anonymous calls', async () => {
    const d1 = createTestD1();
    const env = baseEnv(d1, { CRON_SECRET: 'cron-secret-value' });
    const call = (auth?: string) => dispatchApi(ctx(new Request('https://zuey.me/api/v1/articles/notifications/dispatch', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: auth } : {}) }, body: '{}',
    }), env));
    expect((await call('Bearer cron-secret-value')).status).toBe(200);
    expect((await call('Bearer wrong')).status).toBe(401);
    expect((await call()).status).toBe(401);
  });
});
