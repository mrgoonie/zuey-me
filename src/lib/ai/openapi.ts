import type { OpenApiFragment } from '../openapi/types';
import { adminSecurity, errorResponses } from '../openapi/types';
import { MAX_QUESTION_CHARS } from './chat-service';
import { TITLE_MAX } from './chat-store';
import { SANDBOX_FETCH_MAX_BYTES, SANDBOX_FETCH_TIMEOUT_MS, SANDBOX_RATE_LIMIT_ANON, SANDBOX_RATE_LIMIT_MEMBER } from './sandbox-proxy';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown) => ({ 'application/json': { schema } });
const ok = (description: string, data: unknown) => ({
  description,
  content: json({ type: 'object', properties: { success: { type: 'boolean' }, data } }),
});
const err = (description: string) => ({ description, content: json(ref('Error')) });
const tags = ['Zuey AI'];
/** Member session (same-origin) or a personal `zk_` key with the chat:write scope. */
const memberSecurity = [{ MemberSession: [] }, { BearerAuth: [] }];
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const reasonParam = { name: 'reason', in: 'query', required: true, schema: { type: 'string', minLength: 5, maxLength: 500 }, description: 'Why access is needed; written to admin_access_audit (X-Admin-Reason header also accepted)' };
const chatErrors = {
  ...errorResponses,
  '403': err('`entitlement_required` (plan without ai_chat), `insufficient_scope` (key lacks chat:write), `member_account_required`'),
  '404': err('Session not found (or not yours)'),
};

export const chatOpenApi: OpenApiFragment = {
  tag: { name: 'Zuey AI', description: 'Grounded chat with Zuey AI (Dewee gateway), private per-member sessions, interactive artifacts and the sandbox fetch proxy. Requires the ai_chat entitlement (Zuey AI, Kết hợp, Cộng đồng plans).' },
  schemas: {
    ChatSource: {
      type: 'object',
      properties: {
        id: { type: 'string' }, slug: { type: 'string' }, title: { type: 'string' }, url: { type: 'string', format: 'uri' },
        access: { type: 'string', enum: ['free', 'paid'] },
        scope: { type: 'string', enum: ['full', 'preview'], description: 'preview = only the public part of a paid article was used (caller lacks read_full)' },
      },
    },
    ChatSession: {
      type: 'object',
      properties: { id: { type: 'string' }, title: { type: 'string' }, created_at: { type: 'string' }, updated_at: { type: 'string' }, running: { type: 'boolean' } },
    },
    ChatMessage: {
      type: 'object',
      properties: {
        id: { type: 'string' }, role: { type: 'string', enum: ['user', 'assistant'] }, content: { type: 'string' },
        sources: { type: 'array', items: ref('ChatSource') },
        status: { type: 'string', enum: ['complete', 'streaming', 'cancelled', 'error'] }, error_code: { type: ['string', 'null'] },
        prompt_tokens: { type: 'integer' }, completion_tokens: { type: 'integer' }, est_cost_cents: { type: 'number' }, created_at: { type: 'string' },
      },
    },
    ChatArtifact: {
      type: 'object',
      properties: {
        id: { type: 'string' }, session_id: { type: 'string' }, message_id: { type: ['string', 'null'] },
        status: { type: 'string', enum: ['private', 'attached'] }, article_id: { type: ['string', 'null'] },
        attached_at: { type: ['string', 'null'] }, created_at: { type: 'string' }, block: ref('BlockInteractive'),
      },
    },
    ChatSessionDetail: {
      type: 'object',
      properties: { session: ref('ChatSession'), messages: { type: 'array', items: ref('ChatMessage') }, artifacts: { type: 'array', items: ref('ChatArtifact') } },
    },
    ChatQuota: {
      type: 'object',
      properties: {
        month: { type: 'string', description: 'YYYY-MM in Asia/Saigon' }, used: { type: 'integer' },
        limit: { type: ['integer', 'null'], description: 'AI_MONTHLY_REQUEST_LIMIT (default 300); null for admins' },
        remaining: { type: ['integer', 'null'] },
      },
    },
  },
  paths: {
    '/api/v1/chat/status': {
      get: {
        tags, summary: 'What the chat UI should show for the caller (never 401/403)',
        responses: {
          '200': ok('Status', {
            type: 'object',
            properties: {
              signed_in: { type: 'boolean' }, entitled: { type: 'boolean' }, is_admin: { type: 'boolean' }, configured: { type: 'boolean' },
              quota: { oneOf: [ref('ChatQuota'), { type: 'null' }] }, login_url: { type: 'string' }, upgrade_url: { type: 'string' },
            },
          }),
        },
      },
    },
    '/api/v1/chat/sessions': {
      get: {
        tags, summary: 'List your chat sessions and this month\'s quota', security: memberSecurity,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }, { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } }],
        responses: { '200': ok('Sessions', { type: 'object', properties: { sessions: { type: 'array', items: ref('ChatSession') }, quota: ref('ChatQuota') } }), ...chatErrors },
      },
      post: {
        tags, summary: 'Start a chat session', security: memberSecurity,
        requestBody: { required: false, content: json({ type: 'object', properties: { title: { type: 'string', maxLength: TITLE_MAX } } }) },
        responses: { '201': ok('Created', ref('ChatSession')), ...chatErrors },
      },
    },
    '/api/v1/chat/sessions/{id}': {
      get: { tags, summary: 'One of your sessions with messages, sources and artifacts', security: memberSecurity, parameters: [idParam], responses: { '200': ok('Session', ref('ChatSessionDetail')), ...chatErrors } },
      patch: {
        tags, summary: 'Rename a session', security: memberSecurity, parameters: [idParam],
        requestBody: { required: true, content: json({ type: 'object', required: ['title'], properties: { title: { type: 'string', minLength: 1, maxLength: TITLE_MAX } } }) },
        responses: { '200': ok('Renamed', ref('ChatSession')), ...chatErrors },
      },
      delete: {
        tags, summary: 'Delete a session (messages and artifacts are removed)', security: memberSecurity, parameters: [idParam],
        responses: { '200': ok('Deleted', { type: 'object', properties: { deleted: { type: 'boolean' } } }), '409': err('`chat_run_in_progress`'), ...chatErrors },
      },
    },
    '/api/v1/chat/sessions/{id}/messages': {
      post: {
        tags, summary: 'Ask Zuey AI (Server-Sent Events stream)', security: memberSecurity, parameters: [idParam],
        description: 'Streams `event: sources` ({sources}), `event: delta` ({text}) and finally `event: done` ({message_id, content, cancelled, artifacts, artifact_errors, usage}) or `event: error` ({message_id, code, message, retryable}). The first token typically takes 8–11 s; comment keep-alives are sent meanwhile. Closing the connection aborts the gateway run. Grounding only uses what the caller may read: without read_full, paid articles contribute their public preview only.',
        requestBody: {
          required: true,
          content: json({ type: 'object', required: ['message'], properties: { message: { type: 'string', minLength: 1, maxLength: MAX_QUESTION_CHARS }, locale: { type: 'string', enum: ['en', 'vi', 'zh', 'ko', 'ja'] } } }),
        },
        responses: {
          '200': { description: 'SSE stream', content: { 'text/event-stream': { schema: { type: 'string' } } } },
          '409': err('`chat_run_in_progress`: one reply at a time per session'),
          '429': err('`ai_quota_exceeded` with `limit`, `month`, `upgrade_url`'),
          '503': err('`ai_unconfigured` (Dewee gateway env missing) or `database_unavailable`'),
          ...chatErrors,
        },
      },
    },
    '/api/v1/chat/sessions/{id}/stop': {
      post: {
        tags, summary: 'Stop the reply streaming in this session (any tab or device)', security: memberSecurity, parameters: [idParam],
        responses: { '200': ok('Stop requested', { type: 'object', properties: { stopping: { type: 'boolean' } } }), ...chatErrors },
      },
    },
    '/api/v1/chat/export': {
      get: {
        tags, summary: 'Download all your chats (sessions, messages, sources, artifacts, usage) as JSON', security: memberSecurity,
        responses: { '200': ok('Export', { type: 'object', properties: { exported_at: { type: 'string' }, sessions: { type: 'array', items: ref('ChatSessionDetail') }, usage: { type: 'array', items: { type: 'object' } } } }), ...chatErrors },
      },
    },
    '/api/v1/chat/artifacts/{id}/attach': {
      post: {
        tags, summary: 'Admin: append a chat artifact to an article draft (publish separately)', security: adminSecurity, parameters: [idParam],
        requestBody: {
          required: true,
          content: json({ type: 'object', required: ['article_slug', 'expected_revision'], properties: { article_slug: { type: 'string' }, expected_revision: { type: 'integer' }, reason: { type: 'string', description: 'Required (and audited) for another member\'s artifact' } } }),
        },
        responses: {
          '200': ok('Attached', { type: 'object', properties: { artifact_id: { type: 'string' }, block_id: { type: 'string' }, article: ref('ArticleSummary') } }),
          '404': err('Artifact or article not found'), '409': err('`revision_conflict`'), '422': err('`invalid_document`'), ...errorResponses,
        },
      },
    },
    '/api/v1/sandbox/fetch': {
      post: {
        tags, summary: 'Fetch broker for sandboxed interactive blocks',
        description: `HTTPS GET only, to hosts in SANDBOX_FETCH_ALLOWLIST; private/loopback addresses refused; redirects re-validated; no cookies or credentials forwarded; text/JSON only; ${SANDBOX_FETCH_MAX_BYTES} bytes and ${SANDBOX_FETCH_TIMEOUT_MS} ms caps; ${SANDBOX_RATE_LIMIT_MEMBER}/min per member, ${SANDBOX_RATE_LIMIT_ANON}/min per anonymous IP.`,
        requestBody: { required: true, content: json({ type: 'object', required: ['url'], properties: { url: { type: 'string', format: 'uri' }, method: { type: 'string', enum: ['GET'] } } }) },
        responses: {
          '200': ok('Upstream response', { type: 'object', properties: { url: { type: 'string' }, status: { type: 'integer' }, content_type: { type: 'string' }, body: { type: 'string' } } }),
          '400': err('`invalid_url`'), '403': err('`host_not_allowed`, `private_address_blocked`'), '405': err('`method_not_allowed`'),
          '415': err('`unsupported_content_type`'), '429': err('`rate_limited`'),
          '502': err('`upstream_failed`, `upstream_too_large`, `upstream_redirect_blocked`'), '503': err('`sandbox_fetch_unconfigured`'), '504': err('`upstream_timeout`'),
        },
      },
    },
    '/api/v1/admin/chat/sessions': {
      get: {
        tags, summary: 'Admin: list/search all stored chat sessions with stats (audited)', security: adminSecurity,
        parameters: [reasonParam, { name: 'q', in: 'query', schema: { type: 'string' } }, { name: 'user_id', in: 'query', schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }, { name: 'offset', in: 'query', schema: { type: 'integer' } }],
        responses: {
          '200': ok('Sessions and stats', {
            type: 'object',
            properties: {
              sessions: { type: 'array', items: { allOf: [ref('ChatSession'), { type: 'object', properties: { user_id: { type: 'string' }, user_email: { type: ['string', 'null'] }, message_count: { type: 'integer' }, last_message_at: { type: ['string', 'null'] } } }] } },
              stats: { type: 'object', properties: { sessions: { type: 'integer' }, messages: { type: 'integer' }, month: { type: 'string' }, active_users_month: { type: 'integer' }, requests_month: { type: 'integer' }, est_cost_cents_month: { type: 'number' } } },
            },
          }),
          ...errorResponses, '400': err('`reason_required`'),
        },
      },
    },
    '/api/v1/admin/chat/sessions/{id}': {
      get: {
        tags, summary: 'Admin: read one member\'s chat session (audited)', security: adminSecurity, parameters: [idParam, reasonParam],
        responses: { ...errorResponses, '200': ok('Session', { allOf: [ref('ChatSessionDetail'), { type: 'object', properties: { user_id: { type: 'string' } } }] }), '400': err('`reason_required`'), '404': err('Not found') },
      },
    },
  },
};
