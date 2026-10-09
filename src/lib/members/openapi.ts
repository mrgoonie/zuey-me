import type { OpenApiFragment } from '../openapi/types';
import { adminSecurity, errorResponses } from '../openapi/types';
import { USER_KEY_SCOPES } from './api-keys';
import { MAX_NOTE_LENGTH, RESOLVE_ACTIONS } from './billing-attention';
import { BILLING_MONTHS, ENTITLEMENTS, PLAN_IDS } from './plans';
import { CREDENTIAL_VIAS } from './policy';

const ACCOUNT_TAG = 'Members & account';
const BILLING_TAG = 'Membership billing';

const errorRef = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

function ok(description: string, schema: Record<string, unknown>) {
  return { description, content: json({ type: 'object', properties: { success: { type: 'boolean', enum: [true] }, data: schema } }) };
}

const body = (schema: Record<string, unknown>, required = true) => ({ required, content: json(schema) });

/** Session cookie (browser, same-origin + CSRF Origin check) or a personal `zk_` key with the named scope. */
const memberSecurity = [{ MemberSession: [] }, { BearerAuth: [] }];
const sessionOnly = [{ MemberSession: [] }];

const denied = {
  '401': { description: '`unauthorized`, `invalid_api_key`, `api_key_expired` or `api_key_revoked`', ...errorRef },
  '403': { description: '`insufficient_scope`, `entitlement_required`, `session_required` or `csrf_rejected`', ...errorRef },
};
const notFound = { description: 'Not found (also returned for resources owned by another member)', ...errorRef };
const rateLimited = { description: '`rate_limited` (retry_after_seconds)', ...errorRef };

export const membersOpenApi: OpenApiFragment = {
  tag: {
    name: ACCOUNT_TAG,
    description: [
      'Member sign-in (magic link, Google, GitHub), profile, sessions, activity, export/delete and personal API keys.',
      'Browser calls use the `zuey_member` HttpOnly cookie; unsafe methods must be same-origin (`Origin` header) or are rejected with `csrf_rejected`.',
      `Programmatic calls send \`Authorization: Bearer zk_…\` personal keys limited to scopes: ${USER_KEY_SCOPES.join(', ')}. There is no admin scope.`,
      'Key management, email change, session revocation and account deletion require the browser session.',
    ].join(' '),
  },
  paths: {
    '/api/email/unsubscribe': {
      post: {
        tags: [ACCOUNT_TAG],
        summary: 'Stop or resume new-article emails with the signed token from the email (no sign-in)',
        description: 'RFC 8058 one-click target of the `List-Unsubscribe` header (form body `List-Unsubscribe=One-Click`, token in the query). The /unsubscribe page posts a form with `action` and gets a 303 back to the page. JSON callers send `{ token, action? }`. Sign-in and billing emails are not affected.',
        parameters: [{ name: 'token', in: 'query', required: false, schema: { type: 'string' } }],
        requestBody: body({ type: 'object', properties: { token: { type: 'string' }, action: { type: 'string', enum: ['unsubscribe', 'resubscribe'], default: 'unsubscribe' } } }, false),
        responses: {
          '200': ok('Preference saved', { type: 'object', properties: { subscribed: { type: 'boolean' } } }),
          '303': { description: 'Form from the /unsubscribe page: back to the page with the result' },
          '400': { description: '`invalid_token`', ...errorRef }, '404': notFound,
        },
      },
    },
    '/api/webhooks/resend': {
      post: {
        tags: [ACCOUNT_TAG],
        summary: 'Resend webhook (Svix signature): hard bounces and spam complaints stop new-article emails to that address',
        parameters: [
          { name: 'svix-id', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'svix-timestamp', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'svix-signature', in: 'header', required: true, schema: { type: 'string', example: 'v1,<base64>' } },
        ],
        requestBody: body({ type: 'object' }),
        responses: {
          '200': ok('Event processed or ignored', { type: 'object', properties: { outcome: { type: 'string', enum: ['ignored', 'suppressed'] }, reason: { type: 'string', enum: ['bounce', 'complaint'] }, suppressed: { type: 'integer' } } }),
          '400': errorResponses['400'], '401': { description: '`invalid_signature`', ...errorRef }, '503': { description: '`webhook_unconfigured` (RESEND_WEBHOOK_SECRET missing)', ...errorRef },
        },
      },
    },
    '/api/members/auth/magic-link': {
      post: {
        tags: [ACCOUNT_TAG], summary: 'Email a 15-minute single-use sign-in link',
        requestBody: body({ type: 'object', properties: { email: { type: 'string', format: 'email' }, next: { type: 'string', description: 'Same-site path to open after sign-in' } }, required: ['email'] }),
        responses: {
          '202': ok('Link sent', { type: 'object', properties: { sent: { type: 'boolean' }, expires_in_minutes: { type: 'integer' } } }),
          '400': errorResponses['400'], '429': rateLimited,
          '502': { description: '`email_failed`', ...errorRef },
          '503': { description: '`email_unconfigured` (RESEND_API_KEY missing)', ...errorRef },
        },
      },
    },
    '/api/members/auth/magic-link/verify': {
      post: {
        tags: [ACCOUNT_TAG], summary: 'Consume a magic-link token and open a session (sets zuey_member)',
        requestBody: body({ type: 'object', properties: { token: { type: 'string' } }, required: ['token'] }),
        responses: {
          '200': ok('Signed in', { type: 'object', properties: { next: { type: 'string' }, created: { type: 'boolean' } } }),
          '400': { description: '`invalid_token` (unknown, used or expired)', ...errorRef },
        },
      },
    },
    '/api/members/auth/{provider}': {
      get: {
        tags: [ACCOUNT_TAG], summary: 'Start Google or GitHub sign-in (browser redirect)',
        parameters: [
          { name: 'provider', in: 'path', required: true, schema: { type: 'string', enum: ['google', 'github'] } },
          { name: 'next', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '302': { description: 'Redirect to the provider; callback returns to /api/auth/{provider}/callback' } },
      },
    },
    '/api/members/auth/logout': {
      post: { tags: [ACCOUNT_TAG], summary: 'Sign out the current session', security: sessionOnly, responses: { '200': ok('Signed out', { type: 'object' }) } },
    },
    '/api/v1/me': {
      get: { tags: [ACCOUNT_TAG], summary: 'Your profile, plans and entitlements (account:read)', security: memberSecurity, responses: { '200': ok('Member', ref('Member')), ...denied } },
      patch: {
        tags: [ACCOUNT_TAG], summary: 'Update name, avatar URL or locale (account:write)', security: memberSecurity,
        requestBody: body({ type: 'object', properties: { name: { type: ['string', 'null'], maxLength: 80 }, avatar_url: { type: ['string', 'null'], format: 'uri' }, locale: { type: 'string', enum: ['vi', 'en'] } } }),
        responses: { '200': ok('Updated member', ref('Member')), '400': errorResponses['400'], ...denied },
      },
      delete: {
        tags: [ACCOUNT_TAG], summary: 'Delete your account (session only)', security: sessionOnly,
        requestBody: body({ type: 'object', properties: { confirm_email: { type: 'string' } }, required: ['confirm_email'] }),
        responses: { '200': ok('Deleted; billing records are retained without your email', { type: 'object' }), '400': { description: '`confirmation_required`', ...errorRef }, ...denied },
      },
    },
    '/api/v1/me/email': {
      post: {
        tags: [ACCOUNT_TAG], summary: 'Request an email change (verification link sent to the new address; session only)', security: sessionOnly,
        requestBody: body({ type: 'object', properties: { new_email: { type: 'string', format: 'email' } }, required: ['new_email'] }),
        responses: { '202': ok('Verification sent', { type: 'object', properties: { pending_email: { type: 'string' }, expires_in_minutes: { type: 'integer' } } }), '409': { description: '`email_taken`', ...errorRef }, '429': rateLimited, '503': { description: '`email_unconfigured`', ...errorRef }, ...denied },
      },
    },
    '/api/v1/me/email/confirm': {
      post: {
        tags: [ACCOUNT_TAG], summary: 'Confirm an email change with the emailed token (the old address is notified)',
        requestBody: body({ type: 'object', properties: { token: { type: 'string' } }, required: ['token'] }),
        responses: { '200': ok('Email changed', { type: 'object', properties: { email: { type: 'string' } } }), '400': { description: '`invalid_token`', ...errorRef }, '409': { description: '`email_taken`', ...errorRef } },
      },
    },
    '/api/v1/me/sessions': {
      get: { tags: [ACCOUNT_TAG], summary: 'Your signed-in sessions (account:read)', security: memberSecurity, responses: { '200': ok('Sessions', { type: 'array', items: ref('MemberSession') }), ...denied } },
      delete: { tags: [ACCOUNT_TAG], summary: 'Sign out all other sessions (session only)', security: sessionOnly, responses: { '200': ok('Revoked count', { type: 'object', properties: { revoked: { type: 'integer' } } }), ...denied } },
    },
    '/api/v1/me/sessions/{id}': {
      delete: {
        tags: [ACCOUNT_TAG], summary: 'Revoke one of your sessions (session only)', security: sessionOnly,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok('Revoked', { type: 'object' }), '404': notFound, ...denied },
      },
    },
    '/api/v1/me/activity': {
      get: {
        tags: [ACCOUNT_TAG], summary: 'Your account activity, newest first (account:read)', security: memberSecurity,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }],
        responses: { '200': ok('Activity', { type: 'array', items: { type: 'object' } }), ...denied },
      },
    },
    '/api/v1/me/export': {
      get: { tags: [ACCOUNT_TAG], summary: 'Download your data as JSON (account:read)', security: memberSecurity, responses: { '200': ok('Export', { type: 'object' }), ...denied } },
    },
    '/api/v1/me/keys': {
      get: { tags: [ACCOUNT_TAG], summary: 'List your API keys (metadata only; session only)', security: sessionOnly, responses: { '200': ok('Keys', { type: 'array', items: ref('UserApiKey') }), ...denied } },
      post: {
        tags: [ACCOUNT_TAG], summary: 'Create an API key; the secret is returned once (session only)', security: sessionOnly,
        requestBody: body(ref('UserApiKeyCreate')),
        responses: { '201': ok('Key + one-time secret', { type: 'object', properties: { secret: { type: 'string' }, key: ref('UserApiKey') } }), '400': errorResponses['400'], '409': { description: '`key_limit_reached`', ...errorRef }, ...denied },
      },
    },
    '/api/v1/me/keys/{id}': {
      delete: {
        tags: [ACCOUNT_TAG], summary: 'Revoke a key immediately (session only)', security: sessionOnly,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok('Revoked key', ref('UserApiKey')), '404': notFound, ...denied },
      },
    },
    '/api/v1/me/keys/{id}/rotate': {
      post: {
        tags: [ACCOUNT_TAG], summary: 'Issue a replacement (same or narrower scopes); the old key works until you revoke it (session only)', security: sessionOnly,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: body({ type: 'object', properties: { name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string', enum: [...USER_KEY_SCOPES] } }, expires_in_days: { type: 'integer' } } }, false),
        responses: { '201': ok('Replacement + one-time secret', { type: 'object', properties: { secret: { type: 'string' }, key: ref('UserApiKey'), previous: ref('UserApiKey') } }), '404': notFound, '409': { description: '`key_inactive` or `already_rotated`', ...errorRef }, ...denied },
      },
    },
    '/api/v1/admin/members': {
      get: {
        tags: [ACCOUNT_TAG], summary: 'Admin: list/search members', security: [...adminSecurity, { MemberSession: [] }],
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } },
          { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
        ],
        responses: { '200': ok('Members', { type: 'object' }), ...denied },
      },
    },
  },
  schemas: {
    Member: {
      type: 'object',
      properties: {
        id: { type: 'string' }, email: { type: 'string' }, email_verified: { type: 'boolean' }, name: { type: ['string', 'null'] },
        avatar_url: { type: ['string', 'null'] }, locale: { type: 'string' }, created_at: { type: 'string', format: 'date-time' },
        is_admin: { type: 'boolean' }, plans: { type: 'array', items: { type: 'string', enum: PLAN_IDS } },
        entitlements: { type: 'array', items: { type: 'string', enum: ENTITLEMENTS } },
        identities: { type: 'array', items: { type: 'object', properties: { provider: { type: 'string' }, email: { type: ['string', 'null'] } } } },
        auth: {
          type: 'object',
          properties: {
            via: { type: 'string', enum: [...CREDENTIAL_VIAS], description: '`oauth_token` for OAuth access tokens on /mcp, `user_api_key` for personal `zk_` keys' },
            scopes: { type: ['array', 'null'], items: { type: 'string' } },
          },
        },
      },
    },
    MemberSession: {
      type: 'object',
      properties: { id: { type: 'string' }, created_at: { type: 'string' }, last_seen_at: { type: 'string' }, expires_at: { type: 'string' }, user_agent: { type: ['string', 'null'] }, current: { type: 'boolean' } },
    },
    UserApiKey: {
      type: 'object',
      properties: {
        id: { type: 'string' }, prefix: { type: 'string', description: 'First characters of the secret, e.g. zk_AbCdEfG' }, name: { type: 'string' },
        scopes: { type: 'array', items: { type: 'string', enum: [...USER_KEY_SCOPES] } }, created_at: { type: 'string' }, expires_at: { type: 'string' },
        last_used_at: { type: ['string', 'null'] }, revoked_at: { type: ['string', 'null'] }, replaced_by: { type: ['string', 'null'] },
        status: { type: 'string', enum: ['active', 'expired', 'revoked'] },
      },
    },
    UserApiKeyCreate: {
      type: 'object',
      required: ['name', 'scopes'],
      properties: {
        name: { type: 'string', maxLength: 60 },
        scopes: { type: 'array', minItems: 1, items: { type: 'string', enum: [...USER_KEY_SCOPES] } },
        expires_in_days: { type: 'integer', minimum: 1, maximum: 365, default: 90 },
      },
    },
  },
};

export const billingOpenApi: OpenApiFragment = {
  tag: {
    name: BILLING_TAG,
    description: 'Monthly plans: Knowledges $9 (read_full), Zuey AI $9 (ai_chat, $3/month AI budget), Kết hợp $19 (read_full + ai_chat, $5 AI budget), Cộng đồng $29 (+ community, $5 AI budget). SePay bank transfer prepays 1, 3, 6 or 12 months at USD × USD_VND_RATE rounded up to 1,000 VND per month, with 5/10/20% off for 3/6/12-month prepayments. When Dodo Payments is configured, a plan can also be a monthly USD card subscription that renews automatically and is cancellable from the account page. Plans are activated only by a verified SePay or Dodo webhook (or admin reconciliation), never by a checkout redirect.',
  },
  paths: {
    '/api/v1/plans': {
      get: { tags: [BILLING_TAG], summary: 'Plan catalog with VND prepay prices', responses: { '200': ok('Plans', ref('PlansCatalog')) } },
    },
    '/api/v1/billing/orders': {
      get: { tags: [BILLING_TAG], summary: 'Your orders (billing:read)', security: memberSecurity, responses: { '200': ok('Orders', { type: 'array', items: ref('BillingOrder') }), ...denied } },
      post: {
        tags: [BILLING_TAG],
        summary: 'Start a purchase (checkout:write): SePay VietQR prepaid order, or a Dodo monthly card subscription checkout',
        description: '`provider: sepay` (default) returns VietQR transfer details. `provider: dodo` returns a hosted `checkout_url`; months must be 1 or omitted. Either way, poll `status_url` for the real state.',
        security: memberSecurity,
        requestBody: body({
          type: 'object', required: ['plan'],
          properties: {
            plan: { type: 'string', enum: PLAN_IDS },
            provider: { type: 'string', enum: ['sepay', 'dodo'], default: 'sepay' },
            months: { type: 'integer', enum: [...BILLING_MONTHS], default: 1, description: 'SePay only; card subscriptions are monthly' },
            discount_code: { type: 'string', description: 'Promo or referral code ("Mã ưu đãi"). The larger discount applies, never both. 400 `promo_code_invalid` (error.reason) or `discount_code_invalid`.' },
            invoice: { type: 'object', properties: { tax_id: { type: 'string', pattern: '^\\d{10}(-\\d{3})?$' }, email: { type: 'string', format: 'email' } }, required: ['tax_id', 'email'], description: 'Business (VAT) invoice request; SePay only (400 `invoice_requires_sepay` otherwise)' },
            referral_code: { type: 'string', pattern: '^[A-Za-z0-9]{6,16}$', description: 'Optional referral code. Applies only to a first paid order; the account binding or the `zr_ref` cookie is used when omitted. 400 `referral_code_invalid` when it cannot apply.' },
          },
        }),
        responses: {
          '201': ok('Pending SePay order or pending card checkout', { oneOf: [ref('BillingOrderCheckout'), ref('CardCheckout')] }), '400': errorResponses['400'], ...denied,
          '409': { description: '`already_subscribed` (an active card subscription exists for this plan)', ...errorRef },
          '429': { description: '`too_many_pending_orders`', ...errorRef },
          '502': { description: '`payment_provider_error` (Dodo API failure)', ...errorRef },
          '503': { description: '`billing_unconfigured` (SePay) or `payment_unconfigured` (Dodo); lists missing env names', ...errorRef },
        },
      },
    },
    '/api/v1/billing/orders/{code}': {
      get: {
        tags: [BILLING_TAG], summary: 'One of your orders (billing:read; admins any)', security: memberSecurity,
        parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': ok('Order', ref('BillingOrder')), '404': notFound, ...denied },
      },
    },
    '/api/v1/billing/subscription': {
      get: {
        tags: [BILLING_TAG], summary: 'Your plans and effective entitlements (billing:read)', security: memberSecurity,
        responses: {
          '200': ok('Subscription', {
            type: 'object',
            properties: {
              subscriptions: { type: 'array', items: { type: 'object' } },
              card_subscriptions: { type: 'array', items: ref('CardSubscription') },
              active_plans: { type: 'array', items: { type: 'string' } },
              entitlements: { type: 'array', items: { type: 'string' } },
            },
          }),
          ...denied,
        },
      },
    },
    '/api/v1/billing/card/{id}': {
      get: {
        tags: [BILLING_TAG], summary: 'One of your card subscriptions (billing:read; admins any)', security: memberSecurity,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '^csub_[a-f0-9]{20}$' } }],
        responses: { '200': ok('Card subscription', ref('CardSubscription')), '404': notFound, ...denied },
      },
    },
    '/api/v1/billing/card/{id}/portal': {
      post: {
        tags: [BILLING_TAG], summary: 'Open the Dodo customer portal (card, invoices, cancellation; session only)', security: sessionOnly,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': ok('One-time portal link', { type: 'object', properties: { url: { type: 'string' } } }), '404': notFound, ...denied,
          '409': { description: '`not_manageable` (no Dodo customer yet)', ...errorRef },
          '502': { description: '`payment_provider_error`', ...errorRef }, '503': { description: '`payment_unconfigured`', ...errorRef },
        },
      },
    },
    '/api/v1/billing/card/{id}/cancel': {
      post: {
        tags: [BILLING_TAG], summary: 'Stop renewing at the end of the paid period; access continues until then (session only)', security: sessionOnly,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          '200': ok('Updated card subscription', ref('CardSubscription')), '404': notFound, ...denied,
          '409': { description: '`not_cancellable` (not active)', ...errorRef },
          '502': { description: '`payment_provider_error`', ...errorRef }, '503': { description: '`payment_unconfigured`', ...errorRef },
        },
      },
    },
    '/api/webhooks/dodo': {
      post: {
        tags: [BILLING_TAG],
        summary: 'Dodo Payments webhook (Standard Webhooks signature, 5-minute window; subscription.* and payment.succeeded/failed)',
        description: 'Idempotent by `webhook-id`. Activation requires the configured product, the plan price and USD; anything else, or a payment without member metadata, is recorded as needs_attention.',
        parameters: [
          { name: 'webhook-id', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'webhook-timestamp', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'webhook-signature', in: 'header', required: true, schema: { type: 'string', example: 'v1,<base64>' } },
        ],
        requestBody: body({ type: 'object' }),
        responses: {
          '200': ok('Event processed or ignored', {
            type: 'object',
            properties: {
              outcome: { type: 'string', enum: ['duplicate_event', 'unmatched', 'ignored', 'stale_event', 'needs_attention', 'activated', 'deactivated', 'updated'] },
              card_subscription_id: { type: ['string', 'null'] },
            },
          }),
          '400': errorResponses['400'], '401': { description: '`invalid_signature`', ...errorRef }, '503': { description: '`payment_unconfigured` (DODO_WEBHOOK_SECRET missing)', ...errorRef },
        },
      },
    },
    '/api/v1/billing/reconcile': {
      post: {
        tags: [BILLING_TAG], summary: 'Admin: match recent SePay transactions to pending orders', security: [...adminSecurity, { MemberSession: [] }],
        responses: {
          '200': ok('Reconciliation result', { type: 'object', properties: { checked: { type: 'integer' }, matched: { type: 'integer' }, results: { type: 'array', items: { type: 'object' } } } }),
          ...denied, '502': { description: '`sepay_api_error`', ...errorRef }, '503': { description: '`reconcile_unconfigured` (SEPAY_API_TOKEN missing)', ...errorRef },
        },
      },
    },
    '/api/v1/billing/reminders': {
      post: {
        tags: [BILLING_TAG], summary: 'Admin/cron: send renewal reminders for plans ending within 7 days', security: [...adminSecurity, { MemberSession: [] }],
        responses: { '200': ok('Counts', { type: 'object' }), ...denied, '503': { description: '`email_unconfigured`', ...errorRef } },
      },
    },
    '/api/v1/admin/billing/attention': {
      get: {
        tags: [BILLING_TAG], summary: 'Admin: payments needing attention (SePay orders and Dodo card subscriptions)', security: [...adminSecurity, { MemberSession: [] }],
        description: 'Oldest first, at most 200 of each kind. Card rows are read-only (resolve them in the Dodo dashboard; `card_note` explains why).',
        responses: { '200': ok('Attention queue', ref('BillingAttentionQueue')), ...denied },
      },
    },
    '/api/v1/admin/billing/orders/{code}/resolve': {
      post: {
        tags: [BILLING_TAG], summary: 'Admin: activate or dismiss a flagged SePay order', security: [...adminSecurity, { MemberSession: [] }],
        description: [
          '`activate` marks the order paid now and grants/extends its plan through the normal fulfilment path (receipt email included).',
          '`dismiss` closes it as `expired` without access, keeping `attention_reason`. Repeating an action returns `already_activated` / `already_dismissed`;',
          'a dismissed order may still be activated. The admin and note are written to the member activity log.',
        ].join(' '),
        parameters: [{ name: 'code', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: body({
          type: 'object',
          properties: { action: { type: 'string', enum: RESOLVE_ACTIONS }, note: { type: 'string', maxLength: MAX_NOTE_LENGTH } },
          required: ['action'],
        }),
        responses: {
          '200': ok('Resolution', {
            type: 'object',
            properties: {
              outcome: { type: 'string', enum: ['activated', 'already_activated', 'dismissed', 'already_dismissed'] },
              order: ref('BillingOrder'),
              subscription: { type: ['object', 'null'], description: 'Plan period after activation; null otherwise' },
            },
          }),
          '400': errorResponses['400'], ...denied, '404': notFound,
          '409': { description: '`not_in_attention` (the order is pending, expired normally or already paid)', ...errorRef },
        },
      },
    },
  },
  schemas: {
    PlansCatalog: {
      type: 'object',
      properties: {
        billing_configured: { type: 'boolean' }, missing: { type: 'array', items: { type: 'string' } }, usd_vnd_rate: { type: ['number', 'null'] },
        card_plans: { type: 'array', items: { type: 'string', enum: PLAN_IDS }, description: 'Plans purchasable as a Dodo monthly card subscription (empty when Dodo is not configured)' },
        plans: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', enum: PLAN_IDS }, name: { type: 'string' }, price_usd_cents: { type: 'integer' },
              entitlements: { type: 'array', items: { type: 'string', enum: ENTITLEMENTS } },
              prices: { type: 'array', items: { type: 'object', properties: { months: { type: 'integer' }, discount_percent: { type: 'integer', description: 'Prepay discount for this term (SePay only)' }, amount_usd_cents: { type: 'integer' }, amount_vnd: { type: ['integer', 'null'] } } } },
            },
          },
        },
      },
    },
    BillingOrderCheckout: {
      allOf: [ref('BillingOrder'), { type: 'object', properties: { provider: { type: 'string', enum: ['sepay'] }, status_url: { type: 'string' } } }],
    },
    CardSubscription: {
      type: 'object',
      properties: {
        id: { type: 'string' }, provider: { type: 'string', enum: ['dodo'] },
        plan: { type: ['string', 'null'], enum: [...PLAN_IDS, null] }, plan_name: { type: ['string', 'null'] },
        status: { type: 'string', enum: ['pending', 'active', 'on_hold', 'paused', 'cancelled', 'failed', 'expired', 'needs_attention'] },
        current_period_end: { type: ['string', 'null'], description: "Provider's next billing date: renewal date, or end of access once cancellation is scheduled" },
        cancel_at_period_end: { type: 'boolean' }, amount_cents: { type: ['integer', 'null'] }, currency: { type: ['string', 'null'] },
        attention_reason: { type: ['string', 'null'] },
        referral_discount_percent: { type: ['integer', 'null'], description: 'Referral discount on the first monthly charge only' },
        can_manage: { type: 'boolean' }, can_cancel: { type: 'boolean' },
        created_at: { type: 'string' }, updated_at: { type: 'string' }, status_url: { type: 'string' },
      },
    },
    CardCheckout: {
      allOf: [ref('CardSubscription'), { type: 'object', properties: { checkout_url: { type: 'string', description: 'Dodo hosted checkout; redirect the member here' } } }],
    },
    BillingAttentionQueue: {
      type: 'object',
      properties: {
        orders: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              code: { type: 'string' }, user_id: { type: 'string' }, member_email: { type: ['string', 'null'] },
              plan: { type: 'string', enum: PLAN_IDS }, plan_name: { type: 'string' }, months: { type: 'integer' },
              amount_vnd: { type: 'integer' }, amount_paid: { type: ['integer', 'null'] },
              attention_reason: { type: ['string', 'null'], description: '`late_payment`, `underpaid`, `additional_payment`, …' },
              payment_ref: { type: ['string', 'null'] }, expires_at: { type: 'string' }, created_at: { type: 'string' }, updated_at: { type: 'string' },
            },
          },
        },
        card_subscriptions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' }, user_id: { type: ['string', 'null'] }, member_email: { type: ['string', 'null'] },
              plan: { type: ['string', 'null'] }, plan_name: { type: ['string', 'null'] },
              amount_cents: { type: ['integer', 'null'] }, currency: { type: ['string', 'null'] },
              attention_reason: { type: ['string', 'null'], description: '`metadata_missing`, `metadata_mismatch`, `product_mismatch`, `amount_mismatch`' },
              provider_subscription_id: { type: ['string', 'null'] }, current_period_end: { type: ['string', 'null'] },
              last_event_at: { type: ['string', 'null'] }, created_at: { type: 'string' }, updated_at: { type: 'string' },
            },
          },
        },
        card_note: { type: 'string' },
      },
    },
    BillingOrder: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'ZSB order code; must appear in the transfer content' }, plan: { type: 'string', enum: PLAN_IDS },
        months: { type: 'integer' }, amount_vnd: { type: 'integer' }, amount_usd_cents: { type: 'integer' },
        status: { type: 'string', enum: ['pending', 'paid', 'expired', 'needs_attention'] }, expires_at: { type: 'string' },
        paid_at: { type: ['string', 'null'] }, amount_paid: { type: ['integer', 'null'] }, attention_reason: { type: ['string', 'null'] },
        transfer: {
          type: ['object', 'null'],
          properties: { bank_account: { type: 'string' }, bank_code: { type: 'string' }, amount: { type: 'integer' }, transfer_content: { type: 'string' }, qr_url: { type: 'string' } },
        },
      },
    },
  },
};
