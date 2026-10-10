/** Shared fixtures for course tests: a real SQLite D1, members with browser sessions, and a published course. */
import type { APIContext } from 'astro';
import { createTestD1 } from './d1';
import type { RuntimeEnv } from '../../src/env';
import { createCourse } from '../../src/lib/courses/course-store';
import { createLesson, createSection, publishLesson } from '../../src/lib/courses/course-structure-store';
import type { CourseRecord, LessonRecord } from '../../src/lib/courses/course-types';
import { membersRuntime } from '../../src/lib/members/runtime';
import { createMemberSession } from '../../src/lib/members/session';
import { findOrCreateVerifiedUser } from '../../src/lib/members/users';

export const T0 = Date.parse('2026-10-09T03:00:00.000Z');
export const ORIGIN = 'https://zuey.test';

export type TestDb = ReturnType<typeof createTestD1>;

export const state: { d1: TestDb; now: number; emails: string[]; fetches: Array<{ url: string; body: unknown }> } = {
  d1: createTestD1(), now: T0, emails: [], fetches: [],
};

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function field(v: unknown, ...path: string[]): unknown {
  let cur = v;
  for (const k of path) cur = isRecord(cur) ? cur[k] : undefined;
  return cur;
}

export const env = (): RuntimeEnv => ({
  DB: state.d1,
  PUBLIC_SITE_URL: ORIGIN,
  RESEND_API_KEY: 're_test',
  ADMIN_EMAILS: 'boss@example.com',
  USD_VND_RATE: '26000',
  SEPAY_WEBHOOK_API_KEY: 'sepay-key',
  SEPAY_BANK_ACCOUNT: '0123456789',
  SEPAY_BANK_CODE: 'MBBank',
  DODO_API_KEY: 'dodo_test',
  DODO_WEBHOOK_SECRET: 'whsec_dGVzdA==',
  DODO_PRODUCT_COURSE: 'pdt_course',
  COURSE_MEDIA_SECRET: 'media-secret-for-tests',
});

export interface CtxOpts { method?: string; body?: unknown; rawBody?: string; headers?: Record<string, string>; params?: Record<string, string>; path?: string; env?: RuntimeEnv }

export function ctx(opts: CtxOpts = {}): APIContext {
  const headers = new Headers(opts.headers ?? {});
  const body = opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  const request = new Request(`${ORIGIN}${opts.path ?? '/api/test'}`, { method: opts.method ?? 'GET', headers, body });
  // Handlers only read request/params/locals; a full APIContext is not constructible in tests.
  const partial = { request, params: opts.params ?? {}, url: new URL(request.url), locals: { runtime: { env: opts.env ?? env() } } };
  return partial as unknown as APIContext;
}

export async function read(res: Response): Promise<{ status: number; data: unknown; code: string | null }> {
  const body: unknown = await res.json();
  return { status: res.status, data: field(body, 'data'), code: typeof field(body, 'error', 'code') === 'string' ? String(field(body, 'error', 'code')) : null };
}

export interface Member { userId: string; cookie: string; browser: Record<string, string> }

export async function member(email: string): Promise<Member> {
  const { user } = await findOrCreateVerifiedUser(state.d1, { email });
  const { token } = await createMemberSession(state.d1, user.id);
  const cookie = `zuey_member=${token}`;
  return { userId: user.id, cookie, browser: { cookie, Origin: ORIGIN } };
}

/** A paragraph-only lesson body plus one quiz. */
export function lessonDoc(text: string) {
  return {
    version: 1,
    blocks: [
      { id: 'p1', type: 'paragraph', text },
      {
        id: 'q1', type: 'quiz', title: 'Kiểm tra nhanh', passPercent: 50,
        questions: [
          { id: 'a', kind: 'single', prompt: '2 + 2?', options: [{ id: 'x', label: '3' }, { id: 'y', label: '4' }], correct: ['y'], explanation: 'Bốn.' },
          { id: 'b', kind: 'true_false', prompt: 'Trời xanh?', options: [], correct: ['true'] },
        ],
      },
    ],
  };
}

export interface Fixture { course: CourseRecord; trial: LessonRecord; paid: LessonRecord }

/** Published $49 course with one trial lesson and one paid lesson. */
export async function publishedCourse(overrides: Record<string, unknown> = {}): Promise<Fixture> {
  const d1 = state.d1;
  const course = await createCourse(d1, { title: 'Xây sản phẩm với AI', slug: 'ai-product', price_usd_cents: 4900, status: 'published', ...overrides });
  const section = await createSection(d1, course, { title: 'Bắt đầu' });
  const trial = await createLesson(d1, course, { section_id: section.id, title: 'Giới thiệu', slug: 'gioi-thieu', is_trial: true, doc: lessonDoc('TRIAL BODY') });
  const paid = await createLesson(d1, course, { section_id: section.id, title: 'Bài chính', slug: 'bai-chinh', doc: lessonDoc('PAID SECRET BODY') });
  return { course, trial: await publishLesson(d1, course, trial.id), paid: await publishLesson(d1, course, paid.id) };
}

/** Fresh database, clock and network stubs (Resend and Dodo checkout succeed). */
export function resetCourseState(): void {
  state.d1 = createTestD1();
  state.now = T0;
  state.emails = [];
  state.fetches = [];
  membersRuntime.now = () => state.now;
  membersRuntime.fetch = async (input: string, init?: RequestInit) => {
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
    state.fetches.push({ url: input, body });
    if (input === 'https://api.resend.com/emails') {
      state.emails.push(String(field(body, 'subject')));
      return Response.json({ id: `email_${state.emails.length}` });
    }
    if (input.endsWith('/checkouts')) return Response.json({ session_id: 'cks_1', checkout_url: 'https://checkout.dodo.test/cks_1' });
    return new Response('unexpected', { status: 500 });
  };
}

/** SePay bank time (`YYYY-MM-DD HH:mm:ss`, Vietnam time) for an epoch-ms instant. */
export function sepayTime(ms: number): string {
  return new Date(ms + 7 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}
