import type { OpenApiFragment } from '../openapi/types';
import { adminSecurity, errorResponses } from '../openapi/types';
import { INVOICE_STATUS_FILTER, PROMO_INPUT_PROPERTIES } from './promo-admin-schemas';

const TAG = 'Promo codes & invoices';

const json = (schema: Record<string, unknown>) => ({ 'application/json': { schema } });
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const ok = (description: string, schema: Record<string, unknown>) => ({
  description, content: json({ type: 'object', properties: { success: { type: 'boolean', enum: [true] }, data: schema } }),
});
const err = (description: string) => ({ description, content: json({ $ref: '#/components/schemas/Error' }) });
const body = (schema: Record<string, unknown>) => ({ required: true, content: json(schema) });
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };
const denied = { '401': errorResponses['401'], '403': errorResponses['403'] };
const nullableInt = { type: ['integer', 'null'] };

export const promosOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: [
      'Percent-off promo codes for memberships (SePay and Dodo card), consultations and courses, entered in the same "Mã ưu đãi" field as referral codes',
      '(checkout body `discount_code`; `referral_code` is still accepted). Discounts never stack: the larger percent applies and a tie goes to the referral.',
      'A checkout holds one use until the order expires; checkout errors are 400 `promo_code_invalid` (`error.reason`: disabled, not_started, expired,',
      'exhausted, already_used, product_not_eligible, plan_not_eligible, course_not_eligible, term_too_short) or `discount_code_invalid`.',
      'SePay checkouts accept `invoice: { tax_id, email }` (10 or 10-3 digit tax ID); admins are emailed when the order is paid and record the invoice number here.',
    ].join(' '),
  },
  paths: {
    '/api/v1/promos/quote': {
      get: {
        tags: [TAG], summary: 'Look up a promo code for display (checkout re-validates and reserves)', security: [],
        parameters: [{ name: 'code', in: 'query', required: true, schema: { type: 'string', maxLength: 32 } }],
        responses: {
          '200': ok('Live code and its limits', {
            type: 'object',
            properties: {
              code: { type: 'string' }, percent: { type: 'integer', minimum: 1, maximum: 100 },
              products: { type: ['array', 'null'], items: { type: 'string', enum: ['membership', 'booking', 'course'] } },
              plans: { type: ['array', 'null'], items: { type: 'string' } }, course_ids: { type: ['array', 'null'], items: { type: 'string' } },
              min_months: nullableInt, card_cycles: { type: 'integer' }, ends_at: { type: ['string', 'null'], format: 'date-time' },
            },
          }),
          '400': err('`promo_code_invalid` with `error.reason` (disabled, not_started, expired, exhausted, …)'),
          '404': err('`promo_code_not_found`: no promo with this name (it may be a referral code)'),
        },
      },
    },
    '/api/v1/admin/promo-codes': {
      get: {
        tags: [TAG], summary: 'Promo codes with uses and revenue', security: adminSecurity,
        parameters: [
          { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
          { name: 'status', in: 'query', required: false, schema: { type: 'string', enum: ['active', 'disabled'] } },
          { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 500 } },
        ],
        responses: { '200': ok('Codes', { type: 'object', properties: { promo_codes: { type: 'array', items: ref('PromoCode') } } }), ...denied },
      },
      post: {
        tags: [TAG], summary: 'Create a promo code', security: adminSecurity,
        requestBody: body({ type: 'object', properties: PROMO_INPUT_PROPERTIES, required: ['code', 'percent'] }),
        responses: { '201': ok('Created', ref('PromoCode')), '400': errorResponses['400'], ...denied, '409': err('`code_taken`: a promo or referral code has this name') },
      },
    },
    '/api/v1/admin/promo-codes/{id}': {
      get: {
        tags: [TAG], summary: 'One promo code with uses and revenue', security: adminSecurity, parameters: [idParam],
        responses: { '200': ok('Code', ref('PromoCode')), ...denied, '404': err('`not_found`') },
      },
      patch: {
        tags: [TAG], summary: 'Update a promo code (only the fields sent)', security: adminSecurity, parameters: [idParam],
        requestBody: body({ type: 'object', properties: PROMO_INPUT_PROPERTIES }),
        responses: { '200': ok('Updated', ref('PromoCode')), '400': errorResponses['400'], ...denied, '404': err('`not_found`'), '409': err('`code_taken` or `code_in_use` (a used code cannot be renamed)') },
      },
    },
    '/api/v1/admin/promo-codes/{id}/redemptions': {
      get: {
        tags: [TAG], summary: 'Orders that used the code', security: adminSecurity, parameters: [idParam],
        responses: { '200': ok('Redemptions', { type: 'object', properties: { promo_code: ref('PromoCode'), redemptions: { type: 'array', items: { type: 'object' } } } }), ...denied, '404': err('`not_found`') },
      },
    },
    '/api/v1/admin/invoice-requests': {
      get: {
        tags: [TAG], summary: 'Business invoice requests (SePay)', security: adminSecurity,
        parameters: [{ name: 'status', in: 'query', required: false, schema: INVOICE_STATUS_FILTER }],
        responses: { '200': ok('Requests', { type: 'object', properties: { invoice_requests: { type: 'array', items: ref('InvoiceRequest') } } }), ...denied },
      },
    },
    '/api/v1/admin/invoice-requests/{id}/issue': {
      post: {
        tags: [TAG], summary: 'Record the issued invoice number', security: adminSecurity, parameters: [idParam],
        requestBody: body({ type: 'object', properties: { invoice_no: { type: 'string', maxLength: 64 }, note: { type: 'string', maxLength: 500 } }, required: ['invoice_no'] }),
        responses: { '200': ok('Issued', ref('InvoiceRequest')), '400': errorResponses['400'], ...denied, '404': err('`not_found`'), '409': err('`invalid_state`: the order is not paid') },
      },
    },
    '/api/v1/admin/invoice-requests.csv': {
      get: {
        tags: [TAG], summary: 'CSV export for the accountant (default status requested)', security: adminSecurity,
        parameters: [{ name: 'status', in: 'query', required: false, schema: INVOICE_STATUS_FILTER }],
        responses: { '200': { description: 'CSV', content: { 'text/csv': { schema: { type: 'string' } } } }, ...denied },
      },
    },
  },
  schemas: {
    PromoCode: {
      type: 'object',
      properties: {
        id: { type: 'string' }, ...PROMO_INPUT_PROPERTIES, created_by: { type: ['string', 'null'] }, created_at: { type: 'string' }, updated_at: { type: 'string' },
        remaining_uses: nullableInt,
        stats: {
          type: 'object',
          properties: {
            redeemed: { type: 'integer' }, reserved: { type: 'integer' }, revenue_vnd: { type: 'integer' }, revenue_usd_cents: { type: 'integer' },
            discount_vnd: { type: 'integer' }, discount_usd_cents: { type: 'integer' },
          },
        },
      },
    },
    InvoiceRequest: {
      type: 'object',
      properties: {
        id: { type: 'string' }, source_kind: { type: 'string', enum: ['billing_order', 'booking', 'course_order'] }, source_id: { type: 'string' },
        source_code: { type: 'string' }, user_id: { type: ['string', 'null'] }, tax_id: { type: 'string' }, email: { type: 'string' },
        description: { type: 'string' }, amount_vnd: { type: 'integer' }, amount_paid_vnd: nullableInt,
        status: { type: 'string', enum: ['awaiting_payment', 'requested', 'issued', 'cancelled'] }, paid_at: { type: ['string', 'null'] },
        invoice_no: { type: ['string', 'null'] }, issued_at: { type: ['string', 'null'] }, issued_by: { type: ['string', 'null'] }, note: { type: ['string', 'null'] },
        created_at: { type: 'string' }, updated_at: { type: 'string' },
      },
    },
  },
};
