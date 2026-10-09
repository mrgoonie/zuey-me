/**
 * Course tools for /mcp and /api/mcp. Agents see the catalog, outlines and trial lessons; paid lesson
 * bodies stay browser-only (a lesson read returns the denial instead). Admin tools author courses.
 */
import { AppError, getString } from '../http';
import type { McpContext, McpTool, McpToolModule } from '../mcp/types';
import type { Principal } from '../members/policy';
import { requireCan, requireUserId, resolvePrincipal } from '../members/policy';
import { resolveAccountFlag, listAccountFlags } from '../members/account-flags';
import { adminCourseView, adminLessonView } from './course-admin-views';
import { myLearning } from './course-my-learning';
import { courseOrderView, createCourseCheckout, getCourseOrderFor } from './course-orders';
import { resolveCourseOrder } from './course-order-payments';
import { setPlanDiscountTable } from './course-pricing';
import { grantCourseByEmail, revokeCourse } from './course-purchases';
import { createCourse, requireCourse, updateCourse } from './course-store';
import { createLesson, createSection, publishLesson, requireLesson, updateLesson, updateSection } from './course-structure-store';
import { courseCatalog, courseDetail, lessonView } from './course-views';

async function principalOf(ctx: McpContext): Promise<Principal> {
  return ctx.principal ? ctx.principal() : resolvePrincipal(ctx.request, { ...ctx.env, DB: ctx.d1 ?? ctx.env.DB });
}

function requireDb(ctx: McpContext): NonNullable<McpContext['d1']> {
  const d1 = ctx.d1 ?? ctx.env.DB;
  if (!d1) throw new AppError(503, 'database_unavailable', 'Courses require the D1 database binding (DB)');
  return d1;
}

function req(args: Record<string, unknown>, key: string): string {
  const v = getString(args, key);
  if (!v) throw new AppError(400, 'invalid_field', `${key} is required`, { field: key });
  return v;
}

const ref = { type: 'string', description: 'Slug or id' };
const ADMIN = 'Admin only.';

const tools: McpTool[] = [
  { name: 'course_list', description: "Zuey's published courses with the caller's price (subscriber discount applied) and ownership.", inputSchema: { type: 'object', properties: {} } },
  { name: 'course_get', description: 'One course: summary, outcomes, price and the outline of sections and lessons (lesson bodies excluded).', inputSchema: { type: 'object', properties: { course: ref }, required: ['course'] } },
  {
    name: 'course_lesson_get',
    description: 'Read a lesson. Trial lessons are open to everyone; paid lessons are only readable in a signed-in browser at zuey.me, so this returns `denial` instead of the body for them.',
    inputSchema: { type: 'object', properties: { course: ref, lesson: ref }, required: ['course', 'lesson'] },
  },
  {
    name: 'course_checkout_create',
    description: 'Start buying a course. Requires accept_terms: true (Terms of Use and no-refund policy at /terms and /policy). provider sepay (VietQR, VND) or dodo (card, USD).',
    inputSchema: { type: 'object', properties: { course: ref, provider: { type: 'string', enum: ['sepay', 'dodo'] }, accept_terms: { type: 'boolean', const: true }, discount_code: { type: 'string', description: 'Promo or referral code; the largest discount applies, never stacked' }, referral_code: { type: 'string' }, invoice: { type: 'object', properties: { tax_id: { type: 'string', pattern: '^\\d{10}(-\\d{3})?$' }, email: { type: 'string', format: 'email' } }, required: ['tax_id', 'email'], description: 'Business (VAT) invoice request; SePay only' } }, required: ['course', 'accept_terms'] },
  },
  { name: 'course_order_get', description: 'Status of one of your course orders (code ZSC…).', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'my_learning_get', description: 'Your courses with progress, XP, streak, badges and certificates.', inputSchema: { type: 'object', properties: {} } },
  { name: 'course_admin_get', description: `Course with drafts, full outline, assets and owner count. ${ADMIN}`, inputSchema: { type: 'object', properties: { course: ref }, required: ['course'] } },
  {
    name: 'course_upsert',
    description: `Create a course (no course arg) or update one. Fields: title, slug, subtitle, summary, cover_url, level, locale, price_usd_cents, plan_discounts, outcomes, github_repos, release_note, status (draft|published|archived), position. ${ADMIN}`,
    inputSchema: { type: 'object', properties: { course: ref, fields: { type: 'object' } }, required: ['fields'] },
  },
  {
    name: 'course_section_upsert',
    description: `Create (no section arg) or update a section: title, summary, position. ${ADMIN}`,
    inputSchema: { type: 'object', properties: { course: ref, section: { type: 'string' }, fields: { type: 'object' } }, required: ['course', 'fields'] },
  },
  { name: 'course_lesson_admin_get', description: `Lesson with draft and published documents (quiz answers included). ${ADMIN}`, inputSchema: { type: 'object', properties: { course: ref, lesson: ref }, required: ['course', 'lesson'] } },
  {
    name: 'course_lesson_upsert',
    description: `Create (no lesson arg; needs section_id, title) or update a lesson draft: title, slug, summary, duration_minutes, is_trial, position, section_id, doc (article blocks plus quiz/course_media/github_repo widgets; see block_schema), expected_revision. ${ADMIN}`,
    inputSchema: { type: 'object', properties: { course: ref, lesson: ref, fields: { type: 'object' } }, required: ['course', 'fields'] },
  },
  { name: 'course_lesson_publish', description: `Publish a lesson draft. ${ADMIN}`, inputSchema: { type: 'object', properties: { course: ref, lesson: ref, confirm: { type: 'boolean', const: true } }, required: ['course', 'lesson', 'confirm'] } },
  {
    name: 'course_access_set',
    description: `Grant a complimentary copy by email, or revoke a user's access. ${ADMIN}`,
    inputSchema: { type: 'object', properties: { course: ref, action: { type: 'string', enum: ['grant', 'revoke'] }, email: { type: 'string' }, user_id: { type: 'string' }, reason: { type: 'string' } }, required: ['course', 'action'] },
  },
  {
    name: 'course_order_resolve',
    description: `Resolve a flagged course order: grant, dismiss, or refund (records a manual refund and revokes access). ${ADMIN}`,
    inputSchema: { type: 'object', properties: { code: { type: 'string' }, action: { type: 'string', enum: ['grant', 'dismiss', 'refund'] }, reason: { type: 'string' } }, required: ['code', 'action'] },
  },
  { name: 'course_discounts_set', description: `Set subscriber discount % per plan for all courses: { knowledges, ai, combo, community } integers 0–90. ${ADMIN}`, inputSchema: { type: 'object', properties: { plan_discounts: { type: 'object' } }, required: ['plan_discounts'] } },
  { name: 'account_flag_list', description: `Anti-abuse review queue (account sharing, session churn). ${ADMIN}`, inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'dismissed', 'locked', 'all'] } } } },
  { name: 'account_flag_resolve', description: `Dismiss a flag, or lock the account's course access (signs it out everywhere). ${ADMIN}`, inputSchema: { type: 'object', properties: { id: { type: 'string' }, action: { type: 'string', enum: ['dismiss', 'lock'] } }, required: ['id', 'action'] } },
];

function fields(args: Record<string, unknown>): Record<string, unknown> {
  const f = args.fields;
  if (typeof f !== 'object' || f === null || Array.isArray(f)) throw new AppError(400, 'invalid_field', 'fields must be an object', { field: 'fields' });
  return f as Record<string, unknown>;
}

export const coursesMcpModule: McpToolModule = {
  tools,
  async call(name, args, ctx) {
    const d1 = requireDb(ctx);
    const p = await principalOf(ctx);
    switch (name) {
      case 'course_list': return courseCatalog(d1, ctx.env, p);
      case 'course_get': return courseDetail(d1, ctx.env, p, req(args, 'course'));
      case 'course_lesson_get': return lessonView(d1, ctx.env, p, req(args, 'course'), req(args, 'lesson'));
      case 'course_checkout_create': {
        const userId = requireUserId(p, 'checkout:write');
        return createCourseCheckout(d1, ctx.env, userId, { ...args, course: req(args, 'course') }, ctx.request);
      }
      case 'course_order_get': {
        if (p.kind !== 'admin') requireCan(p, 'billing:read');
        return courseOrderView(d1, ctx.env, await getCourseOrderFor(d1, req(args, 'code'), { userId: p.userId, isAdmin: p.kind === 'admin' }));
      }
      case 'my_learning_get': return myLearning(d1, ctx.env, requireUserId(p, 'account:read'));
      default: break;
    }
    requireCan(p, 'admin');
    switch (name) {
      case 'course_admin_get': return adminCourseView(d1, await requireCourse(d1, req(args, 'course')));
      case 'course_upsert': {
        const course = getString(args, 'course');
        return course ? updateCourse(d1, course, fields(args)) : createCourse(d1, fields(args));
      }
      case 'course_section_upsert': {
        const course = await requireCourse(d1, req(args, 'course'));
        const section = getString(args, 'section');
        return section ? updateSection(d1, course, section, fields(args)) : createSection(d1, course, fields(args));
      }
      case 'course_lesson_admin_get': {
        const course = await requireCourse(d1, req(args, 'course'));
        return adminLessonView(await requireLesson(d1, course.id, req(args, 'lesson')));
      }
      case 'course_lesson_upsert': {
        const course = await requireCourse(d1, req(args, 'course'));
        const lesson = getString(args, 'lesson');
        return adminLessonView(lesson ? await updateLesson(d1, course, lesson, fields(args)) : await createLesson(d1, course, fields(args)));
      }
      case 'course_lesson_publish': {
        if (args.confirm !== true) throw new AppError(400, 'confirmation_required', 'Pass confirm: true to publish');
        const course = await requireCourse(d1, req(args, 'course'));
        return adminLessonView(await publishLesson(d1, course, req(args, 'lesson')));
      }
      case 'course_access_set': {
        const course = await requireCourse(d1, req(args, 'course'));
        if (args.action === 'grant') return grantCourseByEmail(d1, course.id, args.email);
        if (args.action === 'revoke') {
          return { revoked: await revokeCourse(d1, { userId: req(args, 'user_id'), courseId: course.id, reason: getString(args, 'reason') || 'admin', actor: 'admin' }) };
        }
        throw new AppError(400, 'invalid_field', "action must be 'grant' or 'revoke'", { field: 'action' });
      }
      case 'course_order_resolve': {
        const order = await resolveCourseOrder(d1, ctx.env, req(args, 'code'), args.action, args.reason);
        return courseOrderView(d1, ctx.env, order);
      }
      case 'course_discounts_set': {
        const table = args.plan_discounts;
        if (typeof table !== 'object' || table === null) throw new AppError(400, 'invalid_field', 'plan_discounts must be an object', { field: 'plan_discounts' });
        return { plan_discounts: await setPlanDiscountTable(d1, table as Record<string, unknown>) };
      }
      case 'account_flag_list': {
        const status = args.status === 'dismissed' || args.status === 'locked' || args.status === 'all' ? args.status : 'open';
        return listAccountFlags(d1, status);
      }
      case 'account_flag_resolve': return resolveAccountFlag(d1, req(args, 'id'), args.action);
      default: throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    }
  },
};
