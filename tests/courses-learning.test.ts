import { beforeEach, describe, expect, it } from 'bun:test';
import { createStreamAsset, deleteAsset } from '../src/lib/courses/course-asset-store';
import { updateLesson } from '../src/lib/courses/course-structure-store';
import { coursesMcpModule } from '../src/lib/courses/course-mcp';
import { renderCourseMarkdown } from '../src/lib/courses/course-markdown';
import { signFileToken, verifyFileToken } from '../src/lib/courses/course-media-signing';
import { grantCourse } from '../src/lib/courses/course-purchases';
import { gradeQuiz } from '../src/lib/courses/course-learning';
import { reverseCourseOrder } from '../src/lib/courses/course-order-payments';
import type { QuizBlock } from '../src/lib/courses/lesson-blocks';
import { validateLessonDocument } from '../src/lib/courses/lesson-blocks';
import { AppError } from '../src/lib/http';
import type { McpContext } from '../src/lib/mcp/types';
import { createUserKey } from '../src/lib/members/api-keys';
import { resolvePrincipal } from '../src/lib/members/policy';
import { createMemberSession } from '../src/lib/members/session';
import { GET as certificateApi } from '../src/pages/api/v1/certificates/[code]';
import { POST as completeApi } from '../src/pages/api/v1/courses/[course]/lessons/[lesson]/complete';
import { GET as lessonApi } from '../src/pages/api/v1/courses/[course]/lessons/[lesson]/index';
import { POST as quizApi } from '../src/pages/api/v1/courses/[course]/lessons/[lesson]/quiz';
import { GET as learningApi } from '../src/pages/api/v1/me/learning';
import type { Fixture, Member } from './helpers/courses';
import { ORIGIN, ctx, env, field, member, publishedCourse, read, resetCourseState, state } from './helpers/courses';

let fx: Fixture;

const lesson = (lessonSlug: string, headers: Record<string, string> = {}) =>
  lessonApi(ctx({ headers, params: { course: 'ai-product', lesson: lessonSlug } }));
const quiz = (m: Member, answers: unknown, lessonSlug = 'bai-chinh') =>
  quizApi(ctx({ method: 'POST', body: { block_id: 'q1', answers }, headers: m.browser, params: { course: 'ai-product', lesson: lessonSlug } }));
const complete = (m: Member, lessonSlug: string) =>
  completeApi(ctx({ method: 'POST', headers: m.browser, params: { course: 'ai-product', lesson: lessonSlug } }));

async function owner(email: string): Promise<Member> {
  const m = await member(email);
  await grantCourse(state.d1, { userId: m.userId, courseId: fx.course.id, orderId: null, source: 'grant' });
  return m;
}

beforeEach(async () => {
  resetCourseState();
  fx = await publishedCourse();
});

describe('lesson access', () => {
  it('serves trial lessons to everyone and never leaks quiz answers', async () => {
    const res = await lesson('gioi-thieu');
    const text = JSON.stringify((await read(res)).data);
    expect(res.status).toBe(200);
    expect(text).toContain('TRIAL BODY');
    expect(text).not.toContain('"correct"');
    expect(text).not.toContain('Bốn.');
  });

  it('withholds paid lessons from visitors, non-owners and API keys', async () => {
    const anon = await read(await lesson('bai-chinh'));
    expect([field(anon.data, 'denial'), field(anon.data, 'document')]).toEqual(['sign_in', null]);

    const lan = await member('lan@example.com');
    expect(field((await read(await lesson('bai-chinh', { cookie: lan.cookie }))).data, 'denial')).toBe('purchase');

    const mai = await owner('mai@example.com');
    const ok = await read(await lesson('bai-chinh', { cookie: mai.cookie }));
    expect(JSON.stringify(ok.data)).toContain('PAID SECRET BODY');

    const { secret } = await createUserKey(state.d1, mai.userId, { name: 'cli', scopes: ['articles:read', 'account:read'], expires_in_days: 30 });
    const viaKey = await read(await lesson('bai-chinh', { Authorization: `Bearer ${secret}` }));
    expect(field(viaKey.data, 'denial')).toBe('browser_only');
    expect(JSON.stringify(viaKey.data)).not.toContain('PAID SECRET BODY');

    const request = new Request(`${ORIGIN}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${secret}` } });
    const mcp: McpContext = {
      request, env: env(), d1: state.d1,
      async requireAdmin() { throw new AppError(401, 'unauthorized', 'Unauthorized'); },
      async isAdmin() { return false; },
      principal: () => resolvePrincipal(request, env()),
    };
    const viaMcp = await coursesMcpModule.call('course_lesson_get', { course: 'ai-product', lesson: 'bai-chinh' }, mcp);
    expect(field(viaMcp, 'denial')).toBe('browser_only');
    expect(JSON.stringify(viaMcp)).not.toContain('PAID SECRET BODY');
  });

  it('keeps paid text out of the Markdown edition', async () => {
    const md = await renderCourseMarkdown(state.d1, env(), ORIGIN, 'ai-product');
    expect(md).toContain('TRIAL BODY');
    expect(md).toContain('Bài chính');
    expect(md).not.toContain('PAID SECRET BODY');
  });

  it('signs out the least recently used device beyond two', async () => {
    const lan = await owner('lan@example.com');
    await createMemberSession(state.d1, lan.userId);
    await createMemberSession(state.d1, lan.userId);
    expect(field((await read(await lesson('bai-chinh', { cookie: lan.cookie }))).data, 'denial')).toBe('sign_in');
  });
});

describe('quizzes, XP and certificates', () => {
  it('grades on the server and awards quiz XP only once', async () => {
    const lan = await owner('lan@example.com');
    const fail = await read(await quiz(lan, { a: 'x', b: 'false' }));
    expect(field(fail.data, 'passed')).toBe(false);
    expect(field(fail.data, 'xp_awarded')).toBe(0);

    const pass = await read(await quiz(lan, { a: 'y', b: true }));
    expect([field(pass.data, 'score'), field(pass.data, 'passed'), field(pass.data, 'xp_awarded')]).toEqual([2, true, 30]);
    expect(field((await read(await quiz(lan, { a: 'y', b: 'true' }))).data, 'xp_awarded')).toBe(0);
  });

  it('grades a trial quiz for a visitor without storing anything', async () => {
    const anon = await read(await quizApi(ctx({ method: 'POST', body: { block_id: 'q1', answers: { a: 'y', b: 'true' } }, params: { course: 'ai-product', lesson: 'gioi-thieu' } })));
    expect([field(anon.data, 'passed'), field(anon.data, 'preview')]).toEqual([true, true]);
    const stored = await state.d1.prepare('SELECT COUNT(*) AS n FROM quiz_attempts').first<{ n: number }>();
    expect(Number(stored?.n)).toBe(0);
  });

  it('issues a verifiable certificate after the last lesson and revokes it on refund', async () => {
    const lan = await owner('lan@example.com');
    const first = await read(await complete(lan, 'gioi-thieu'));
    expect(field(first.data, 'certificate')).toBeNull();
    const last = await read(await complete(lan, 'bai-chinh'));
    const code = String(field(last.data, 'certificate', 'code'));
    expect(code.startsWith('ZC-')).toBe(true);
    expect(field(last.data, 'xp_awarded')).toBe(110);
    expect(field((await read(await complete(lan, 'bai-chinh'))).data, 'xp_awarded')).toBe(0);

    const learning = await read(await learningApi(ctx({ headers: { cookie: lan.cookie } })));
    expect(field(learning.data, 'learner', 'xp')).toBe(120);

    const cert = await read(await certificateApi(ctx({ params: { code } })));
    expect([cert.status, field(cert.data, 'revoked')]).toEqual([200, false]);

    await state.d1.prepare(
      `INSERT INTO course_orders (id, code, provider, user_id, course_id, list_usd_cents, subscriber_pct, referral_pct, applied_pct, discount_source,
         amount_usd_cents, status, terms_version, terms_accepted_at, expires_at, created_at, updated_at)
       VALUES ('cor_x', 'ZSCREFUND1', 'sepay', ?, ?, 4900, 0, 0, 0, 'none', 4900, 'paid', 'v', 'now', 'later', 'now', 'now')`
    ).bind(lan.userId, fx.course.id).run();
    await state.d1.prepare("UPDATE course_purchases SET order_id = 'cor_x' WHERE user_id = ?").bind(lan.userId).run();
    const order = { id: 'cor_x', code: 'ZSCREFUND1', user_id: lan.userId, course_id: fx.course.id, status: 'paid' };
    expect(await reverseCourseOrder(state.d1, order as never, 'refunded', 'manual')).toBe(true);
    expect(field((await read(await certificateApi(ctx({ params: { code } })))).data, 'revoked')).toBe(true);
  });
});

describe('lesson documents and media links', () => {
  it('validates quiz widgets', () => {
    const bad = validateLessonDocument({ version: 1, blocks: [{ id: 'q', type: 'quiz', questions: [{ id: 'a', kind: 'single', prompt: '?', options: [{ id: 'x', label: 'X' }], correct: ['nope'] }] }] });
    expect(bad.ok).toBe(false);
  });

  it('grades multiple-choice exactly', () => {
    const q: QuizBlock = { id: 'q', type: 'quiz', passPercent: 100, questions: [{ id: 'm', kind: 'multiple', prompt: '?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], correct: ['a', 'b'] }] };
    expect(gradeQuiz(q, { m: ['a'] }).passed).toBe(false);
    expect(gradeQuiz(q, { m: ['b', 'a'] }).passed).toBe(true);
    expect(gradeQuiz(q, { m: ['a', 'b', 'c'] }).passed).toBe(false);
  });

  it('binds file tokens to the viewer and rejects tampering and expiry', async () => {
    const { token } = await signFileToken(env(), 'cas_1', 'usr_1', 600);
    expect(await verifyFileToken(env(), token)).toEqual({ assetId: 'cas_1', viewer: 'usr_1' });
    expect(await verifyFileToken(env(), `${token.slice(0, -2)}xx`)).toBeNull();
    state.now += 601_000;
    expect(await verifyFileToken(env(), token)).toBeNull();
  });

  it('refuses to delete media a lesson still uses', async () => {
    const asset = await createStreamAsset(state.d1, fx.course, { stream_uid: 'a'.repeat(32), name: 'Demo' });
    const withMedia = { version: 1, blocks: [{ id: 'm1', type: 'course_media', assetId: asset.id }] };
    await updateLesson(state.d1, fx.course, fx.paid.id, { doc: withMedia });
    const err = await deleteAsset(state.d1, env(), fx.course, asset.id).catch((e: unknown) => e);
    expect(err instanceof AppError && err.code).toBe('asset_in_use');
    await updateLesson(state.d1, fx.course, fx.paid.id, { doc: { version: 1, blocks: [] } });
    expect(await deleteAsset(state.d1, env(), fx.course, asset.id)).toEqual({ deleted: true });
  });
});
