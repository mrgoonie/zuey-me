/** OpenAPI for course authoring, ownership, orders, pricing and the anti-abuse review queue (admin only). */
import type { OpenApiFragment } from '../openapi/types';
import { courseParam, lessonParam, op, pathParam } from './course-openapi-helpers';

const TAG = 'Courses admin';
const C = '/api/v1/admin/courses/{course}';
const admin = (summary: string, extra: Partial<Parameters<typeof op>[1]> = {}) => op(TAG, { summary, admin: true, ...extra });
// Admin bodies are the fields to set, listed in each summary; unknown fields are rejected by the store.
const anyBody = {};

export const coursesAdminOpenApi: OpenApiFragment = {
  tag: { name: TAG, description: 'Authoring courses, sections and lessons; media assets; grants; order resolution; plan discounts; account flags.' },
  paths: {
    '/api/v1/admin/courses': {
      get: admin('All courses including drafts'),
      post: admin('Create a course (title, slug, price_usd_cents, plan_discounts, outcomes, github_repos, status …)', { status: '201', body: anyBody }),
    },
    [C]: {
      get: admin('Course with outline, assets and owner count', { params: [courseParam] }),
      patch: admin('Update a course', { params: [courseParam], body: anyBody }),
      delete: admin('Delete a draft course with no owners', { params: [courseParam] }),
    },
    [`${C}/sections`]: { post: admin('Create a section', { params: [courseParam], status: '201', body: { title: { type: 'string' }, summary: { type: 'string' } } }) },
    [`${C}/sections/{section}`]: {
      patch: admin('Update a section', { params: [courseParam, pathParam('section', 'Section id')], body: anyBody }),
      delete: admin('Delete an empty section', { params: [courseParam, pathParam('section', 'Section id')] }),
    },
    [`${C}/lessons`]: { post: admin('Create a lesson draft (section_id, title, is_trial, doc …)', { params: [courseParam], status: '201', body: anyBody }) },
    [`${C}/lessons/{lesson}`]: {
      get: admin('Lesson with draft and published documents', { params: [courseParam, lessonParam] }),
      patch: admin('Update a lesson draft (expected_revision guards concurrent edits)', { params: [courseParam, lessonParam], body: anyBody }),
      delete: admin('Delete a lesson', { params: [courseParam, lessonParam] }),
    },
    [`${C}/lessons/{lesson}/publish`]: {
      post: admin('Publish the lesson draft', { params: [courseParam, lessonParam] }),
      delete: admin('Unpublish the lesson', { params: [courseParam, lessonParam] }),
    },
    [`${C}/assets`]: {
      get: admin('Media assets of a course', { params: [courseParam] }),
      post: admin('Register a Cloudflare Stream video (JSON) or upload a private R2 file (multipart)', { params: [courseParam], status: '201' }),
    },
    [`${C}/assets/{asset}`]: {
      patch: admin('Rename an asset', { params: [courseParam, pathParam('asset', 'Asset id')], body: anyBody }),
      delete: admin('Delete an asset no lesson references', { params: [courseParam, pathParam('asset', 'Asset id')] }),
    },
    [`${C}/owners`]: {
      get: admin('Owners of a course', { params: [courseParam] }),
      post: admin('Grant a complimentary copy by email', { params: [courseParam], body: { email: { type: 'string' } }, required: ['email'] }),
      delete: admin('Revoke a user\'s access', { params: [courseParam], body: { user_id: { type: 'string' }, reason: { type: 'string' } }, required: ['user_id'] }),
    },
    '/api/v1/admin/course-settings': {
      get: admin('Default subscriber discount % per plan'),
      put: admin('Set default subscriber discount % per plan', { body: { plan_discounts: { type: 'object' } }, required: ['plan_discounts'] }),
    },
    '/api/v1/admin/course-orders': { get: admin('Course orders (filter by status)', { params: [{ name: 'status', in: 'query', schema: { type: 'string' } }] }) },
    '/api/v1/admin/course-orders/{code}/resolve': {
      post: admin('Resolve a flagged order: grant, dismiss or refund', {
        params: [pathParam('code', 'Order code')], body: { action: { type: 'string', enum: ['grant', 'dismiss', 'refund'] }, reason: { type: 'string' } }, required: ['action'],
      }),
    },
    '/api/v1/admin/account-flags': { get: admin('Anti-abuse review queue', { params: [{ name: 'status', in: 'query', schema: { type: 'string', enum: ['open', 'dismissed', 'locked', 'all'] } }] }) },
    '/api/v1/admin/account-flags/{id}': {
      post: admin('Dismiss a flag or lock the account\'s course access', { params: [pathParam('id', 'Flag id')], body: { action: { type: 'string', enum: ['dismiss', 'lock'] } }, required: ['action'] }),
    },
    '/api/v1/admin/course-locks': {
      get: admin('Accounts with locked course access'),
      post: admin('Lock an account\'s course access', { body: { user_id: { type: 'string' }, reason: { type: 'string' } }, required: ['user_id'] }),
      delete: admin('Unlock an account', { body: { user_id: { type: 'string' } }, required: ['user_id'] }),
    },
  },
  schemas: {},
};
