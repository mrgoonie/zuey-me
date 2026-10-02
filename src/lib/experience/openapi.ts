import type { OpenApiFragment } from '../openapi/types';
import { errorResponses } from '../openapi/types';
import { LOCALES } from '../i18n/locales';
import { PLAN_IDS } from '../members/plans';
import { COMMUNITY_CHATS } from './community';
import { NOTICE_EXPRESSIONS, NOTICE_MAX_WINDOW_DAYS, NOTICE_TARGETS } from './notices';

const TAG = 'Homepage experience';

const errorRef = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const ok = (description: string, schema: Record<string, unknown>) => ({
  description,
  content: json({ type: 'object', properties: { success: { type: 'boolean', enum: [true] }, data: schema } }),
});
const err = (description: string) => ({ description, ...errorRef });

/** Admin = Studio session, admin API key, or admin member session (same-origin). */
const adminAuth = [{ BearerAuth: [] }, { ApiKeyHeader: [] }, { MemberSession: [] }];
const sessionAuth = [{ MemberSession: [] }];
const denied = { '401': errorResponses['401'], '403': errorResponses['403'] };
const dbMissing = { '503': err('`database_unavailable`') };
const communityMissing = err('`community_unconfigured` (missing lists the env names, never values)');

export const experienceOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: [
      'Visitor notices from Duy (shown in the mascot bubble), Telegram community access for the $29 plan,',
      'public GitHub activity of mrgoonie and an Open-Meteo weather proxy. Weather uses coarse coordinates (1 decimal) or a city name;',
      'nothing about the caller is stored server-side.',
    ].join(' '),
  },
  paths: {
    '/api/v1/notices/active': {
      get: {
        tags: [TAG], summary: 'Notices live now for this visitor',
        description: 'Audience is resolved from the member session (all, signed-in members, or one plan). Text falls back to English, then Vietnamese, when the requested locale has no edition.',
        parameters: [{ name: 'lang', in: 'query', schema: { type: 'string', enum: [...LOCALES] } }],
        responses: {
          '200': ok('Active notices', { type: 'object', properties: { locale: { type: 'string' }, notices: { type: 'array', items: ref('PublicNotice') } } }),
          ...dbMissing,
        },
      },
    },
    '/api/v1/notices': {
      get: {
        tags: [TAG], summary: 'Admin: list notices', security: adminAuth,
        parameters: [
          { name: 'include_expired', in: 'query', schema: { type: 'string', enum: ['1'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200 } },
        ],
        responses: { '200': ok('Notices', { type: 'object', properties: { notices: { type: 'array', items: ref('Notice') } } }), ...denied, ...dbMissing },
      },
      post: {
        tags: [TAG], summary: 'Admin: send a visitor notice', security: adminAuth,
        requestBody: { required: true, content: json(ref('NoticeInput')) },
        responses: { '201': ok('Created', ref('Notice')), '400': errorResponses['400'], ...denied, ...dbMissing },
      },
    },
    '/api/v1/notices/{id}/expire': {
      post: {
        tags: [TAG], summary: 'Admin: end a notice now (idempotent)', security: adminAuth,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok('Expired', ref('Notice')), ...denied, '404': err('`notice_not_found`'), ...dbMissing },
      },
    },
    '/api/v1/github/activity': {
      get: {
        tags: [TAG], summary: 'Public GitHub events of mrgoonie',
        description: 'Up to 300 public events (GitHub keeps about 90 days). This is NOT a contribution calendar. Cached 15 minutes and ETag-revalidated; when GitHub is rate limited or down the last good snapshot is returned with `source: "stale"` and an `error`.',
        responses: {
          '200': ok('Activity', ref('GithubActivity')),
          '429': err('`github_rate_limited` with retry_after_seconds (no cached snapshot yet)'),
          '503': err('`github_unavailable` (no cached snapshot yet)'),
        },
      },
    },
    '/api/v1/weather': {
      get: {
        tags: [TAG], summary: 'Current weather (Open-Meteo proxy)',
        description: 'Send `lat` and `lon` (rounded server-side to 1 decimal, ~11 km) or `city`. Data by Open-Meteo.com (CC BY 4.0).',
        parameters: [
          { name: 'lat', in: 'query', schema: { type: 'number', minimum: -90, maximum: 90 } },
          { name: 'lon', in: 'query', schema: { type: 'number', minimum: -180, maximum: 180 } },
          { name: 'city', in: 'query', schema: { type: 'string', minLength: 2, maxLength: 80 } },
          { name: 'lang', in: 'query', schema: { type: 'string', enum: [...LOCALES] }, description: 'City-name language' },
        ],
        responses: {
          '200': ok('Weather', ref('Weather')),
          '400': err('`invalid_query`, `invalid_coordinates` or `invalid_city`'),
          '404': err('`city_not_found`'),
          '502': err('`weather_unavailable`'),
        },
      },
    },
    '/api/v1/community': {
      get: {
        tags: [TAG], summary: 'Your Telegram community status', security: sessionAuth,
        responses: { '200': ok('Status', ref('CommunityStatus')), ...dbMissing },
      },
    },
    '/api/v1/community/invite': {
      post: {
        tags: [TAG], summary: 'Get a one-hour, single-use invite link ($29 plan)', security: sessionAuth,
        requestBody: { required: true, content: json({ type: 'object', properties: { chat: { type: 'string', enum: [...COMMUNITY_CHATS] } }, required: ['chat'] }) },
        responses: {
          '201': ok('Invite (an unexpired unused invite is returned again instead of creating a new one)', ref('CommunityMembership')),
          '400': errorResponses['400'],
          '401': errorResponses['401'],
          '403': err('`entitlement_required` (community) or `csrf_rejected`'),
          '409': err('`already_joined`'),
          '429': err('`rate_limited` or `telegram_rate_limited`'),
          '502': err('`telegram_error` or `telegram_unreachable`'),
          '503': communityMissing,
        },
      },
    },
    '/api/v1/community/sweep': {
      post: {
        tags: [TAG], summary: 'Admin/cron: remove lapsed members, retire stale invites', security: adminAuth,
        responses: { '200': ok('Sweep result', ref('CommunitySweep')), ...denied, '503': communityMissing },
      },
    },
    '/api/v1/community/telegram-webhook': {
      post: {
        tags: [TAG], summary: 'Telegram Bot API webhook (chat_member updates)',
        description: 'Register with setWebhook secret_token=TELEGRAM_WEBHOOK_SECRET and allowed_updates ["chat_member"]. Authenticated by the X-Telegram-Bot-Api-Secret-Token header.',
        parameters: [{ name: 'X-Telegram-Bot-Api-Secret-Token', in: 'header', required: true, schema: { type: 'string' } }],
        responses: {
          '200': ok('Processed', { type: 'object', properties: { outcome: { type: 'string', enum: ['joined', 'joined_then_removed', 'left', 'ignored'] } } }),
          '401': err('`invalid_webhook_secret`'),
          '503': communityMissing,
        },
      },
    },
  },
  schemas: {
    NoticeInput: {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'object', description: `Keyed by locale (${LOCALES.join(', ')}), each 1–500 characters; or a string together with \`locale\``, additionalProperties: { type: 'string' } },
        locale: { type: 'string', enum: [...LOCALES] },
        expression: { type: 'string', enum: [...NOTICE_EXPRESSIONS], nullable: true },
        target: { type: 'string', enum: [...NOTICE_TARGETS], default: 'all' },
        plan: { type: 'string', enum: PLAN_IDS, description: 'Required when target = plan' },
        starts_at: { type: 'string', format: 'date-time' },
        expires_at: { type: 'string', format: 'date-time', description: `Within ${NOTICE_MAX_WINDOW_DAYS} days of starts_at` },
        ttl_hours: { type: 'number', description: 'Alternative to expires_at' },
      },
    },
    Notice: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'object', additionalProperties: { type: 'string' } },
        expression: { type: 'string', nullable: true },
        target: { type: 'string', enum: [...NOTICE_TARGETS] },
        target_plan: { type: 'string', nullable: true },
        starts_at: { type: 'string', format: 'date-time' },
        expires_at: { type: 'string', format: 'date-time' },
        status: { type: 'string', enum: ['scheduled', 'active', 'expired'] },
        created_by: { type: 'string' },
        created_at: { type: 'string', format: 'date-time' },
        updated_at: { type: 'string', format: 'date-time' },
      },
    },
    PublicNotice: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        text: { type: 'string' },
        locale: { type: 'string', enum: [...LOCALES] },
        expression: { type: 'string', nullable: true },
        starts_at: { type: 'string', format: 'date-time' },
        expires_at: { type: 'string', format: 'date-time' },
      },
    },
    GithubActivity: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: ['cache', 'live', 'revalidated', 'stale'] },
        error: { nullable: true, type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, retry_after_seconds: { type: 'integer', nullable: true } } },
        snapshot: {
          type: 'object',
          properties: {
            user: { type: 'string' },
            fetched_at: { type: 'string', format: 'date-time' },
            pages_fetched: { type: 'integer' },
            partial: { type: 'boolean' },
            events: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' }, type: { type: 'string' }, action: { type: 'string', nullable: true },
                  repo: { type: 'string' }, repo_url: { type: 'string' }, url: { type: 'string' },
                  created_at: { type: 'string', format: 'date-time' }, ref: { type: 'string', nullable: true },
                  ref_type: { type: 'string', nullable: true }, title: { type: 'string', nullable: true },
                  number: { type: 'integer', nullable: true }, commits: { type: 'integer', nullable: true },
                },
              },
            },
          },
        },
      },
    },
    Weather: {
      type: 'object',
      properties: {
        place: { nullable: true, type: 'object', properties: { name: { type: 'string' }, country: { type: 'string', nullable: true }, admin1: { type: 'string', nullable: true } } },
        latitude: { type: 'number' }, longitude: { type: 'number' },
        condition: { type: 'string', enum: ['clear', 'clouds', 'fog', 'rain', 'snow', 'storm'] },
        is_day: { type: 'boolean' }, weather_code: { type: 'integer' },
        temperature_c: { type: 'number', nullable: true }, wind_kmh: { type: 'number', nullable: true },
        observed_at: { type: 'string', nullable: true }, source: { type: 'string', enum: ['open-meteo'] }, attribution: { type: 'string' },
      },
    },
    CommunityMembership: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        chat: { type: 'string', enum: [...COMMUNITY_CHATS] },
        status: { type: 'string', enum: ['invited', 'joined', 'left', 'removed', 'revoked'] },
        invite_link: { type: 'string', nullable: true, description: 'Only while the invite is unused and unexpired' },
        invite_expires_at: { type: 'string', format: 'date-time' },
        joined_at: { type: 'string', format: 'date-time', nullable: true },
        created_at: { type: 'string', format: 'date-time' },
      },
    },
    CommunityStatus: {
      type: 'object',
      properties: {
        signed_in: { type: 'boolean' },
        configured: { type: 'boolean' },
        entitled: { type: 'boolean' },
        chats: { type: 'array', items: { type: 'object', properties: { chat: { type: 'string' }, available: { type: 'boolean' } } } },
        memberships: { type: 'array', items: ref('CommunityMembership') },
      },
    },
    CommunitySweep: {
      type: 'object',
      properties: {
        checked: { type: 'integer' }, removed: { type: 'integer' }, revoked: { type: 'integer' },
        errors: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, code: { type: 'string' }, message: { type: 'string' } } } },
      },
    },
  },
};
