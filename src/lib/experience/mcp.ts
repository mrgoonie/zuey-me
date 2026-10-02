import type { McpContext, McpToolModule } from '../mcp/types';
import { AppError, getString } from '../http';
import { PLAN_IDS } from '../members/plans';
import type { Principal } from '../members/policy';
import { requireCan, resolvePrincipal } from '../members/policy';
import { LOCALES } from '../i18n/locales';
import { sweepCommunity } from './community';
import { getGithubActivity } from './github-activity';
import { NOTICE_EXPRESSIONS, NOTICE_MAX_WINDOW_DAYS, NOTICE_TARGETS, createNotice, expireNotice, listNotices, parseNoticeInput, principalLabel } from './notices';
import { getWeather, parseWeatherQuery } from './weather';

async function principalOf(ctx: McpContext): Promise<Principal> {
  return ctx.principal ? ctx.principal() : resolvePrincipal(ctx.request, { ...ctx.env, DB: ctx.d1 ?? ctx.env.DB });
}

function requireDb(ctx: McpContext): NonNullable<McpContext['d1']> {
  const d1 = ctx.d1 ?? ctx.env.DB;
  if (!d1) throw new AppError(503, 'database_unavailable', 'This tool requires the D1 database binding (DB)');
  return d1;
}

async function requireAdminPrincipal(ctx: McpContext): Promise<Principal> {
  const p = await principalOf(ctx);
  requireCan(p, 'admin');
  return p;
}

const localeText = Object.fromEntries(LOCALES.map(l => [l, { type: 'string', maxLength: 500 }]));

/** Visitor notices (admin), community maintenance (admin) and public activity/weather lookups. */
export const experienceMcpModule: McpToolModule = {
  tools: [
    {
      name: 'notice_send',
      description: `Admin: show a visitor notice in the homepage mascot bubble, labelled "Duy". Text per locale (${LOCALES.join('/')}), optional mascot expression, audience (all | members | plan) and a window of at most ${NOTICE_MAX_WINDOW_DAYS} days. Visitors can dismiss it; it never reappears after dismissal or expiry.`,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'object', properties: localeText, description: 'Text keyed by locale, e.g. {"vi":"…","en":"…"}' },
          expression: { type: 'string', enum: [...NOTICE_EXPRESSIONS] },
          target: { type: 'string', enum: [...NOTICE_TARGETS], description: 'Default all' },
          plan: { type: 'string', enum: PLAN_IDS, description: 'Required when target is plan' },
          starts_at: { type: 'string', format: 'date-time', description: 'Default now' },
          expires_at: { type: 'string', format: 'date-time' },
          ttl_hours: { type: 'number', description: 'Alternative to expires_at' },
        },
        required: ['text'],
      },
    },
    {
      name: 'notice_list',
      description: 'Admin: list visitor notices with status (scheduled/active/expired), targeting and author.',
      inputSchema: { type: 'object', properties: { include_expired: { type: 'boolean' }, limit: { type: 'integer' } } },
    },
    {
      name: 'notice_expire',
      description: 'Admin: end a visitor notice immediately (idempotent).',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    {
      name: 'community_sweep',
      description: 'Admin: remove Telegram community members whose $29 plan lapsed and retire stale invite links.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'github_activity_get',
      description: 'Public GitHub events of mrgoonie (Duy /zuey/): up to 300 recent public events (about 90 days), not a full contribution history.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'weather_get',
      description: 'Current weather from Open-Meteo by city name or coarse coordinates (rounded to 1 decimal).',
      inputSchema: {
        type: 'object',
        properties: { city: { type: 'string' }, lat: { type: 'number' }, lon: { type: 'number' }, lang: { type: 'string', enum: [...LOCALES] } },
      },
    },
  ],

  async call(name, args, ctx) {
    switch (name) {
      case 'notice_send': {
        const p = await requireAdminPrincipal(ctx);
        return createNotice(requireDb(ctx), parseNoticeInput(args), principalLabel(p));
      }
      case 'notice_list': {
        await requireAdminPrincipal(ctx);
        return { notices: await listNotices(requireDb(ctx), { includeExpired: args.include_expired === true, limit: typeof args.limit === 'number' ? args.limit : 50 }) };
      }
      case 'notice_expire': {
        await requireAdminPrincipal(ctx);
        const id = getString(args, 'id');
        if (!id) throw new AppError(400, 'invalid_field', 'id is required', { field: 'id' });
        return expireNotice(requireDb(ctx), id);
      }
      case 'community_sweep': {
        await requireAdminPrincipal(ctx);
        return sweepCommunity(requireDb(ctx), ctx.env);
      }
      case 'github_activity_get':
        return getGithubActivity();
      case 'weather_get': {
        const params = new URLSearchParams();
        for (const key of ['city', 'lat', 'lon', 'lang']) {
          const v = args[key];
          if (typeof v === 'string' || typeof v === 'number') params.set(key, String(v));
        }
        return getWeather(parseWeatherQuery(params));
      }
      default:
        throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
    }
  },
};
