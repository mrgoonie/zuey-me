import type { OpenApiFragment } from '../openapi/types';
import { adminSecurity, errorResponses } from '../openapi/types';
import { COMMISSION_DECISIONS } from './admin-api';
import { MAX_REFERRAL_RATE } from './config';
import { ID_IMAGE_TYPES, PAYOUT_PROFILE_STATUSES } from './payout-profiles';
import { PAYOUT_STATUSES } from './payouts';

const TAG = 'Referrals';

const errorRef = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const ok = (description: string, schema: Record<string, unknown>) => ({
  description, content: json({ type: 'object', properties: { success: { type: 'boolean', enum: [true] }, data: schema } }),
});
const body = (schema: Record<string, unknown>, required = true) => ({ required, content: json(schema) });
const err = (description: string) => ({ description, ...errorRef });

const memberSecurity = [{ MemberSession: [] }, { BearerAuth: [] }];
const sessionOnly = [{ MemberSession: [] }];
const memberDenied = { '401': errorResponses['401'], '403': err('`insufficient_scope`, `session_required`, `csrf_rejected` or `referrer_not_eligible`') };
const adminDenied = { '401': errorResponses['401'], '403': errorResponses['403'] };
const notFound = err('`not_found`');
const conflict = err('`invalid_state` and similar: the resource is not in a state that allows this action');
const month = { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$', example: '2026-10' };
const pathParam = (name: string, schema: Record<string, unknown> = { type: 'string' }) => ({ name, in: 'path', required: true, schema });
const split = { type: 'object', properties: { discount_percent: { type: 'integer' }, commission_percent: { type: 'integer' } } };
const cents = { type: 'integer', description: 'USD cents' };

export const referralsOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: [
      'Referral program: one link and one referee discount d per referrer; commission = R − d where R = max(admin override, tier rate).',
      'Commission is earned on the referee\'s first paid order, held 30 days, then approved into a USD-cent ledger; day-1 close (Asia/Saigon) creates payouts.',
      'Admin endpoints accept an admin session (same-origin), Studio session or admin API key.',
    ].join(' '),
  },
  paths: {
    '/api/v1/referrals/quote': {
      get: {
        tags: [TAG], summary: 'Public price quote with the visitor\'s referral discount (code, account binding or zr_ref cookie)',
        parameters: [{ name: 'code', in: 'query', required: false, schema: { type: 'string' } }],
        responses: { '200': ok('Quote (display only; checkout recomputes)', { type: 'object' }) },
      },
    },
    '/api/v1/referrals/me': {
      get: {
        tags: [TAG], summary: 'Your referral link, rate, tier progress, split, balances, recent commissions and payouts', security: memberSecurity,
        responses: { '200': ok('Referral dashboard', ref('ReferralMe')), ...memberDenied },
      },
      patch: {
        tags: [TAG], summary: 'Set your referee discount (0 ≤ d ≤ R) and/or leaderboard opt-out (scope account:write)', security: memberSecurity,
        requestBody: body({ type: 'object', properties: { discount_percent: { type: 'integer', minimum: 0, maximum: MAX_REFERRAL_RATE }, leaderboard_opt_out: { type: 'boolean' } } }),
        responses: { '200': ok('Updated dashboard', ref('ReferralMe')), '400': err('`invalid_field` (e.g. discount above your rate; `max` = R)'), ...memberDenied },
      },
    },
    '/api/v1/referrals/bind': {
      post: {
        tags: [TAG], summary: 'Bind a referrer by code (accounts without a referrer that never paid; permanent)', security: memberSecurity,
        requestBody: body({ type: 'object', properties: { code: { type: 'string' } }, required: ['code'] }),
        responses: {
          '200': ok('Bound', { type: 'object', properties: { bound: { type: 'boolean' }, code: { type: 'string' } } }),
          '400': err('`referral_code_invalid` (reason: invalid_code, self_referral, not_eligible)'), '409': err('`referral_already_bound`'), ...memberDenied,
        },
      },
    },
    '/api/v1/referrals/payout-profile': {
      get: {
        tags: [TAG], summary: 'Your payout details and review status', security: memberSecurity,
        responses: { '200': ok('Profile (null when none)', { type: 'object', properties: { profile: { oneOf: [ref('ReferralPayoutProfile'), { type: 'null' }] } } }), ...memberDenied },
      },
      put: {
        tags: [TAG], summary: 'Save VN bank (full_name, bank_name, bank_account, national_id, address) or PayPal (paypal_email) details; needs a new admin review', security: sessionOnly,
        requestBody: body({
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['vn_bank', 'paypal'] }, full_name: { type: 'string' }, bank_name: { type: 'string' },
            bank_account: { type: 'string', description: '6–20 digits' }, national_id: { type: 'string', description: '12-digit CCCD or 9-digit CMND' },
            address: { type: 'string' }, paypal_email: { type: 'string', format: 'email' },
          },
          required: ['method'],
        }),
        responses: { '200': ok('Saved', { type: 'object', properties: { profile: ref('ReferralPayoutProfile') } }), '400': errorResponses['400'], ...memberDenied, '503': err('`storage_unavailable` (REFERRAL_KYC) when switching away from stored images') },
      },
    },
    '/api/v1/referrals/payout-profile/id-images/{side}': {
      put: {
        tags: [TAG], summary: 'Upload the front or back of your national ID (raw image body ≤ 5 MB) to private storage', security: sessionOnly,
        parameters: [pathParam('side', { type: 'string', enum: ['front', 'back'] })],
        requestBody: { required: true, content: Object.fromEntries(ID_IMAGE_TYPES.map(t => [t, { schema: { type: 'string', format: 'binary' } }])) },
        responses: {
          '200': ok('Stored; the profile becomes submitted once both sides and the details are present', { type: 'object', properties: { profile: ref('ReferralPayoutProfile') } }),
          '409': err('`payout_profile_required` (save VN bank details first)'), '413': err('`image_too_large`'), '415': err('`unsupported_media_type`'),
          ...memberDenied, '503': err('`storage_unavailable`: the REFERRAL_KYC R2 binding is missing'),
        },
      },
    },
    '/api/v1/referrals/leaderboard': {
      get: {
        tags: [TAG], summary: 'Public monthly top 10 referrers (masked names, counts only; Asia/Saigon month)',
        parameters: [{ name: 'month', in: 'query', required: false, schema: month }],
        responses: { '200': ok('Leaderboard', ref('ReferralLeaderboard')), '400': err('`invalid_month`') },
      },
    },
    '/api/v1/referrals/jobs/run': {
      post: {
        tags: [TAG], summary: 'Cron (Bearer CRON_SECRET) or admin: recapture commissions whose capture failed, mature commissions, refresh tiers, day-1 payout close. Idempotent', security: adminSecurity,
        responses: { '200': ok('Per-job results; a failed job reports status "error"', { type: 'object' }), ...adminDenied },
      },
    },
    '/api/v1/admin/referrals/settings': {
      get: { tags: [TAG], summary: 'Admin: program settings', security: adminSecurity, responses: { '200': ok('Settings', ref('ReferralSettings')), ...adminDenied } },
      patch: {
        tags: [TAG], summary: 'Admin: change settings (partial; unknown keys rejected)', security: adminSecurity,
        requestBody: body(ref('ReferralSettings')),
        responses: { '200': ok('Settings', ref('ReferralSettings')), '400': errorResponses['400'], ...adminDenied },
      },
    },
    '/api/v1/admin/referrals/referrers': {
      get: {
        tags: [TAG], summary: 'Admin: referrers by email, name or code', security: adminSecurity,
        parameters: [{ name: 'q', in: 'query', required: false, schema: { type: 'string' } }, { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 200 } }],
        responses: { '200': ok('Referrers', { type: 'object', properties: { referrers: { type: 'array', items: ref('ReferralAdminReferrer') } } }), ...adminDenied },
      },
    },
    '/api/v1/admin/referrals/referrers/{email}': {
      patch: {
        tags: [TAG], summary: 'Admin: rate override, admin enablement, lock (with reason) or unlock', security: adminSecurity,
        parameters: [pathParam('email')],
        requestBody: body({
          type: 'object',
          properties: {
            admin_rate_override: { type: ['integer', 'null'], minimum: 0, maximum: MAX_REFERRAL_RATE }, admin_enabled: { type: 'boolean' },
            locked: { type: 'boolean' }, lock_reason: { type: 'string', description: 'Required with locked: true' },
          },
        }),
        responses: { '200': ok('Referrer', ref('ReferralAdminReferrer')), '400': errorResponses['400'], '404': notFound, ...adminDenied },
      },
    },
    '/api/v1/admin/referrals/commissions': {
      get: {
        tags: [TAG], summary: 'Admin: commissions by status (review = fraud review queue)', security: adminSecurity,
        parameters: [
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['pending', 'review', 'approved', 'reversed', 'blocked'] } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500 } },
        ],
        responses: { '200': ok('Commissions', { type: 'object', properties: { commissions: { type: 'array', items: ref('ReferralCommission') } } }), ...adminDenied },
      },
    },
    '/api/v1/admin/referrals/commissions/{id}/{action}': {
      post: {
        tags: [TAG], summary: 'Admin: approve (review → approved or back to its hold), reject (→ blocked) or reverse a commission', security: adminSecurity,
        parameters: [pathParam('id'), pathParam('action', { type: 'string', enum: COMMISSION_DECISIONS })],
        requestBody: body({ type: 'object', properties: { note: { type: 'string', maxLength: 500 } } }, false),
        responses: {
          '200': ok('Decision', { type: 'object', properties: { outcome: { type: 'string', enum: ['approved', 'released_to_hold', 'rejected', 'reversed', 'already_reversed'] }, commission: ref('ReferralCommission') } }),
          '404': notFound, '409': conflict, ...adminDenied,
        },
      },
    },
    '/api/v1/admin/referrals/payout-profiles': {
      get: {
        tags: [TAG], summary: 'Admin: payout profiles by status (default submitted; `all` for every status). Images are not included', security: adminSecurity,
        parameters: [{ name: 'status', in: 'query', required: false, schema: { type: 'string', enum: [...PAYOUT_PROFILE_STATUSES, 'all'] } }],
        responses: { '200': ok('Profiles', { type: 'object', properties: { profiles: { type: 'array', items: ref('ReferralPayoutProfile') } } }), ...adminDenied },
      },
    },
    '/api/v1/admin/referrals/payout-profiles/{userId}/id-images/{side}': {
      get: {
        tags: [TAG], summary: 'Admin: view a national-ID image (no-store; every view is audited)', security: adminSecurity,
        parameters: [pathParam('userId'), pathParam('side', { type: 'string', enum: ['front', 'back'] })],
        responses: {
          '200': { description: 'The image', content: Object.fromEntries(ID_IMAGE_TYPES.map(t => [t, { schema: { type: 'string', format: 'binary' } }])) },
          '404': notFound, ...adminDenied, '503': err('`storage_unavailable`: the REFERRAL_KYC R2 binding is missing'),
        },
      },
    },
    '/api/v1/admin/referrals/payout-profiles/{userId}/{action}': {
      post: {
        tags: [TAG], summary: 'Admin: approve (→ verified) or reject (reason required) a payout profile; both ID images are deleted in the same request', security: adminSecurity,
        parameters: [pathParam('userId'), pathParam('action', { type: 'string', enum: ['approve', 'reject'] })],
        requestBody: body({
          type: 'object', required: ['updated_at'],
          properties: {
            reason: { type: 'string', maxLength: 500 },
            updated_at: { type: 'string', description: 'updated_at of the profile as reviewed; a profile changed since is refused with 409 `profile_changed`' },
          },
        }),
        responses: { '200': ok('Decided', ref('ReferralPayoutProfile')), '400': errorResponses['400'], '404': notFound, '409': conflict, ...adminDenied, '503': err('`storage_unavailable` (REFERRAL_KYC)') },
      },
    },
    '/api/v1/admin/referrals/payouts': {
      get: {
        tags: [TAG], summary: 'Admin: payouts of a period and/or status, with the payee snapshotted at close', security: adminSecurity,
        parameters: [{ name: 'period', in: 'query', required: false, schema: month }, { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: PAYOUT_STATUSES } }],
        responses: { '200': ok('Payouts', { type: 'object', properties: { payouts: { type: 'array', items: ref('ReferralPayout') } } }), '400': errorResponses['400'], ...adminDenied },
      },
    },
    '/api/v1/admin/referrals/payouts.csv': {
      get: {
        tags: [TAG], summary: 'Admin: CSV export of one period', security: adminSecurity,
        parameters: [{ name: 'period', in: 'query', required: true, schema: month }],
        responses: { '200': { description: 'CSV', content: { 'text/csv': { schema: { type: 'string' } } } }, '400': errorResponses['400'], ...adminDenied },
      },
    },
    '/api/v1/admin/referrals/payouts/{id}/{action}': {
      post: {
        tags: [TAG], summary: 'Admin: mark paid (transaction_ref; emails the referrer) or cancel (gross returns to the balance)', security: adminSecurity,
        parameters: [pathParam('id'), pathParam('action', { type: 'string', enum: ['paid', 'cancel'] })],
        requestBody: body({ type: 'object', properties: { transaction_ref: { type: 'string', maxLength: 200 }, reason: { type: 'string' } } }, false),
        responses: {
          '200': ok('Result', { type: 'object', properties: { outcome: { type: 'string', enum: ['paid', 'already_paid', 'cancelled', 'already_cancelled'] }, payout: ref('ReferralPayout'), email: { type: ['string', 'null'] } } }),
          '400': errorResponses['400'], '404': notFound, '409': err('`payout_cancelled`, `payout_paid` or `payee_unverified` (no payee snapshot from a verified profile)'), ...adminDenied,
        },
      },
    },
  },
  schemas: {
    ReferralSettings: {
      type: 'object',
      properties: {
        tiers: { type: 'array', items: { type: 'object', properties: { min: { type: 'integer' }, rate: { type: 'integer' } } } },
        hold_days: { type: 'integer' }, booking_rate: { type: 'integer' }, payout_threshold_cents: cents,
        vn_deduction_bp: { type: 'integer' }, paypal_deduction_bp: { type: 'integer' }, cookie_days: { type: 'integer' }, updated_at: { type: 'string', readOnly: true },
      },
    },
    ReferralMe: {
      type: 'object',
      properties: {
        eligible: { type: 'boolean' }, locked: { type: 'boolean' }, code: { type: ['string', 'null'] }, link: { type: ['string', 'null'] },
        rate: { type: 'integer' }, admin_rate_override: { type: ['integer', 'null'] },
        tier: {
          type: 'object',
          properties: {
            count_90d: { type: 'integer' }, rate: { type: 'integer' }, window_days: { type: 'integer' },
            next: { type: ['object', 'null'], properties: { min: { type: 'integer' }, rate: { type: 'integer' }, remaining: { type: 'integer' } } },
          },
        },
        discount_percent: { type: 'integer' }, membership_split: split, booking_split: split, leaderboard_opt_out: { type: 'boolean' },
        balance: { type: 'object', properties: { pending_cents: cents, approved_cents: cents, processing_cents: cents, paid_cents: cents } },
        commissions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, source_kind: { type: 'string' }, referee: { type: ['string', 'null'], description: 'Masked email' },
              base_amount_cents: cents, commission_percent: { type: 'integer' }, commission_cents: cents, status: { type: 'string' },
              paid_at: { type: ['string', 'null'] }, hold_until: { type: 'string' }, approved_at: { type: ['string', 'null'] }, reversed_at: { type: ['string', 'null'] },
            },
          },
        },
        payouts: { type: 'array', items: ref('ReferralPayout') },
        payout_profile: { type: ['object', 'null'], properties: { status: { type: 'string' }, method: { type: 'string' } } },
        next_close_date: { type: 'string', format: 'date' },
        program: { type: 'object' },
      },
    },
    ReferralLeaderboard: {
      type: 'object',
      properties: {
        month: month,
        entries: { type: 'array', items: { type: 'object', properties: { rank: { type: 'integer' }, name: { type: 'string', example: 'Duy N.' }, referrals: { type: 'integer' } } } },
      },
    },
    ReferralPayoutProfile: {
      type: 'object',
      properties: {
        user_id: { type: 'string' }, method: { type: 'string', enum: ['vn_bank', 'paypal'] }, status: { type: 'string', enum: PAYOUT_PROFILE_STATUSES },
        full_name: { type: ['string', 'null'] }, bank_name: { type: ['string', 'null'] }, bank_account: { type: ['string', 'null'] },
        national_id: { type: ['string', 'null'] }, address: { type: ['string', 'null'] }, paypal_email: { type: ['string', 'null'] },
        has_id_front: { type: 'boolean' }, has_id_back: { type: 'boolean' }, verified_at: { type: ['string', 'null'] }, reject_reason: { type: ['string', 'null'] },
        email: { type: ['string', 'null'], description: 'Admin views only' }, updated_at: { type: 'string' },
      },
    },
    ReferralAdminReferrer: {
      type: 'object',
      properties: {
        user_id: { type: 'string' }, email: { type: 'string' }, name: { type: ['string', 'null'] }, code: { type: 'string' }, rate: { type: 'integer' },
        tier_count_90d: { type: 'integer' }, tier_rate: { type: 'integer' }, admin_rate_override: { type: ['integer', 'null'] }, admin_enabled: { type: 'boolean' },
        discount_percent: { type: 'integer' }, locked_at: { type: ['string', 'null'] }, lock_reason: { type: ['string', 'null'] }, leaderboard_opt_out: { type: 'boolean' },
        balance_cents: cents, held_cents: cents, referred_count: { type: 'integer' }, created_at: { type: 'string' },
      },
    },
    ReferralCommission: {
      type: 'object',
      properties: {
        id: { type: 'string' }, source_kind: { type: 'string', enum: ['billing_order', 'card_subscription', 'booking'] }, source_id: { type: 'string' },
        referrer_user_id: { type: 'string' }, referrer_email: { type: ['string', 'null'] }, referee_user_id: { type: ['string', 'null'] }, referee_email: { type: ['string', 'null'] },
        base_amount_cents: cents, commission_percent: { type: 'integer' }, commission_cents: cents,
        status: { type: 'string', enum: ['pending', 'review', 'approved', 'reversed', 'blocked'] }, review_reasons: { type: 'array', items: { type: 'string' } },
        hold_until: { type: 'string' }, paid_at: { type: ['string', 'null'] }, approved_at: { type: ['string', 'null'] }, reversed_at: { type: ['string', 'null'] },
      },
    },
    ReferralPayout: {
      type: 'object',
      properties: {
        id: { type: 'string' }, referrer_user_id: { type: 'string' }, period: month, method: { type: 'string', enum: ['vn_bank', 'paypal'] },
        gross_cents: cents, deduction_bp: { type: 'integer' }, deduction_cents: cents, net_cents: cents,
        usd_vnd_rate: { type: ['number', 'null'] }, net_vnd: { type: ['integer', 'null'] }, status: { type: 'string', enum: PAYOUT_STATUSES },
        transaction_ref: { type: ['string', 'null'] }, paid_at: { type: ['string', 'null'] }, paid_by: { type: ['string', 'null'] },
        email: { type: ['string', 'null'], description: 'Admin list only' },
        payee: { type: 'object', description: 'Admin list only, snapshotted from the verified payout profile at close: full_name, bank_name, bank_account, national_id, address, paypal_email, verified_at (null = not payable)' },
      },
    },
  },
};
