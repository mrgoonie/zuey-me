/** OpenAPI for learner-facing course endpoints. Paid lesson bodies are served to browser sessions only. */
import type { OpenApiFragment } from '../openapi/types';
import { courseParam, lessonParam, op, pathParam } from './course-openapi-helpers';

const TAG = 'Courses';
const L = '/api/v1/courses/{course}/lessons/{lesson}';
const both = [courseParam, lessonParam];

export const coursesOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: 'Self-paced courses on building products with AI. Buy once, own forever; paid subscribers get a plan discount. '
      + 'Trial lessons are public. Paid lessons are readable only in a signed-in browser session (never via API keys or MCP).',
  },
  paths: {
    '/api/v1/courses': { get: op(TAG, { summary: 'Catalog with your personal price and ownership' }) },
    '/api/v1/courses/{course}': { get: op(TAG, { summary: 'Course page: outline, outcomes, price, progress', params: [courseParam], extra: { '404': 'Course not found' } }) },
    '/api/v1/courses/{course}/checkout': {
      post: op(TAG, {
        summary: 'Buy a course (one-time, no refunds)', member: true, params: [courseParam], status: '201',
        description: 'SePay returns a VietQR transfer; Dodo returns a card `checkout_url`. `accept_terms: true` is required.',
        body: { provider: { type: 'string', enum: ['sepay', 'dodo'] }, accept_terms: { type: 'boolean' }, referral_code: { type: 'string' } },
        required: ['accept_terms'], extra: { '409': 'Already owned', '429': 'Too many checkouts' },
      }),
    },
    [L]: { get: op(TAG, { summary: 'Read a lesson (body only when readable; `denial` otherwise)', params: both }) },
    [`${L}/complete`]: { post: op(TAG, { summary: 'Mark a lesson completed (XP, streak, certificate)', member: true, params: both }) },
    [`${L}/quiz`]: {
      post: op(TAG, {
        summary: 'Submit a quiz; returns score, correct answers and explanations', member: true, params: both,
        body: { block_id: { type: 'string' }, answers: { type: 'object', description: '{ questionId: optionId | optionId[] }' } }, required: ['block_id', 'answers'],
      }),
    },
    [`${L}/media`]: {
      post: op(TAG, { summary: 'Short-lived signed URL for a lesson video/audio/file', member: true, params: both, body: { asset_id: { type: 'string' } }, required: ['asset_id'] }),
    },
    '/api/v1/courses/media/{token}': { get: op(TAG, { summary: 'Stream a signed course file (supports Range)', params: [pathParam('token', 'Signed token')], extra: { '403': 'Expired or not yours' } }) },
    '/api/v1/courses/{course}/github-resync': {
      get: op(TAG, { summary: 'Status of your GitHub repo invitations', member: true, params: [courseParam] }),
      post: op(TAG, { summary: 'Re-send GitHub repo invitations to your linked username', member: true, params: [courseParam] }),
    },
    '/api/v1/courses/orders': { get: op(TAG, { summary: 'Your course orders', member: true }) },
    '/api/v1/courses/orders/{code}': { get: op(TAG, { summary: 'One course order (ZSC…)', member: true, params: [pathParam('code', 'Order code')] }) },
    '/api/v1/courses/leaderboard': {
      get: op(TAG, { summary: 'XP leaderboard (names masked)', params: [{ name: 'period', in: 'query', schema: { type: 'string', enum: ['month', 'all'], default: 'month' } }] }),
    },
    '/api/v1/me/learning': {
      get: op(TAG, { summary: 'Your courses, progress, XP, badges, streak and certificates', member: true }),
      patch: op(TAG, { summary: 'Leaderboard opt-out', member: true, body: { leaderboard_opt_out: { type: 'boolean' } } }),
    },
    '/api/v1/certificates/{code}': { get: op(TAG, { summary: 'Verify a completion certificate', params: [pathParam('code', 'Certificate code (ZC-…)')], extra: { '404': 'Unknown certificate' } }) },
  },
  schemas: {},
};
