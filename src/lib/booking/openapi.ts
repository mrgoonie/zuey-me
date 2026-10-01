import type { OpenApiFragment } from '../openapi/types';
import { adminSecurity, errorResponses } from '../openapi/types';

const TAG = 'Business booking';

function ok(description: string, schemaRef: string) {
  return {
    description,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: { success: { type: 'boolean', enum: [true] }, data: { $ref: `#/components/schemas/${schemaRef}` } },
        },
      },
    },
  };
}

const errorRef = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
const conflict = { description: 'Slot taken, hold not active, or reschedule not allowed', ...errorRef };
const notFound = { description: 'Booking not found or manage token invalid', ...errorRef };
const unconfigured = { description: 'Payment provider not configured (`payment_unconfigured`, lists missing variables) or DB unavailable', ...errorRef };
const idParam = { name: 'id', in: 'path', required: true, schema: { type: 'string' } };

export const bookingOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: 'Zuey for Business: one-off $1,999 consultation (90-minute Google Meet). Slots are held for 15 minutes and confirmed only by a verified payment webhook.',
  },
  paths: {
    '/api/v1/booking/slots': {
      get: {
        tags: [TAG],
        summary: 'List open consultation slots (UTC)',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'days', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 60, default: 60 } },
        ],
        responses: { '200': ok('Open slots', 'BookingSlotList'), '400': errorResponses['400'], '503': unconfigured },
      },
    },
    '/api/v1/booking/hold': {
      post: {
        tags: [TAG],
        summary: 'Hold a slot for 15 minutes',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BookingHoldRequest' } } } },
        responses: { '201': ok('Hold created; returns the one-time manage token', 'BookingHoldResult'), '400': errorResponses['400'], '409': conflict, '503': unconfigured },
      },
    },
    '/api/v1/booking/{id}': {
      get: {
        tags: [TAG],
        summary: 'Get a booking (guest with manage token, or admin)',
        parameters: [idParam, { name: 'token', in: 'query', schema: { type: 'string' } }],
        responses: { '200': ok('Guest view (with token) or admin view', 'BookingGuestView'), '404': notFound },
      },
    },
    '/api/v1/booking/{id}/checkout': {
      post: {
        tags: [TAG],
        summary: 'Start payment for an active hold',
        parameters: [idParam],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'] } } } },
        responses: { '200': ok('Polar checkout URL or SePay VietQR instructions', 'BookingCheckout'), '404': notFound, '409': conflict, '502': { description: 'Payment provider error', ...errorRef }, '503': unconfigured },
      },
    },
    '/api/v1/booking/{id}/reschedule': {
      post: {
        tags: [TAG],
        summary: 'Reschedule once (both times at least 48h away)',
        parameters: [idParam],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { token: { type: 'string' }, slot_start: { type: 'string', format: 'date-time' } }, required: ['token', 'slot_start'] } } } },
        responses: { '200': ok('Updated booking', 'BookingGuestView'), '400': errorResponses['400'], '404': notFound, '409': conflict },
      },
    },
    '/api/v1/booking/availability': {
      get: {
        tags: [TAG], summary: 'Get availability rules and exceptions', security: adminSecurity,
        responses: { '200': ok('Availability', 'BookingAvailability'), '401': errorResponses['401'], '403': errorResponses['403'] },
      },
      put: {
        tags: [TAG], summary: 'Replace availability rules and exceptions', security: adminSecurity,
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BookingAvailability' } } } },
        responses: { '200': ok('Saved availability', 'BookingAvailability'), '400': errorResponses['400'], '401': errorResponses['401'], '403': errorResponses['403'] },
      },
    },
    '/api/v1/booking/admin': {
      get: {
        tags: [TAG], summary: 'List bookings', security: adminSecurity,
        parameters: [
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['held', 'confirmed', 'expired', 'cancelled', 'needs_attention'] } },
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'to', in: 'query', schema: { type: 'string', format: 'date-time' } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500 } },
        ],
        responses: { '200': ok('Bookings', 'BookingAdminList'), '400': errorResponses['400'], '401': errorResponses['401'], '403': errorResponses['403'] },
      },
      post: {
        tags: [TAG], summary: 'Admin action on a booking (cancel never refunds automatically)', security: adminSecurity,
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BookingAdminAction' } } } },
        responses: { '200': ok('Updated booking', 'BookingAdminView'), '400': errorResponses['400'], '401': errorResponses['401'], '403': errorResponses['403'], '404': notFound, '409': conflict },
      },
    },
    '/api/webhooks/polar': {
      post: {
        tags: [TAG],
        summary: 'Polar webhook (Standard Webhooks signature; handles order.paid)',
        parameters: [
          { name: 'webhook-id', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'webhook-timestamp', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'webhook-signature', in: 'header', required: true, schema: { type: 'string', example: 'v1,<base64>' } },
        ],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': ok('Event processed or ignored (idempotent)', 'BookingPaymentResult'), '401': { description: 'Invalid signature', ...errorRef }, '503': unconfigured },
      },
    },
    '/api/webhooks/sepay': {
      post: {
        tags: [TAG],
        summary: 'SePay bank transfer webhook (Authorization: Apikey <key>)',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/SepayWebhook' } } } },
        responses: { '200': ok('Event processed or ignored (idempotent)', 'BookingPaymentResult'), '400': errorResponses['400'], '401': { description: 'Invalid API key', ...errorRef }, '503': unconfigured },
      },
    },
  },
  schemas: {
    BookingSlot: {
      type: 'object',
      properties: { start: { type: 'string', format: 'date-time' }, end: { type: 'string', format: 'date-time' }, duration_min: { type: 'integer' } },
    },
    BookingSlotList: { type: 'object', properties: { slots: { type: 'array', items: { $ref: '#/components/schemas/BookingSlot' } } } },
    BookingHoldRequest: {
      type: 'object',
      required: ['slot_start', 'name', 'email', 'payment_method'],
      properties: {
        slot_start: { type: 'string', format: 'date-time' },
        name: { type: 'string', maxLength: 120 },
        email: { type: 'string', format: 'email' },
        company: { type: 'string', maxLength: 160 },
        notes: { type: 'string', maxLength: 2000 },
        timezone: { type: 'string', description: 'Guest IANA time zone' },
        payment_method: { type: 'string', enum: ['polar', 'sepay'] },
      },
    },
    BookingHoldResult: {
      type: 'object',
      properties: {
        booking: { $ref: '#/components/schemas/BookingGuestView' },
        manage_token: { type: 'string', description: 'Shown once; stored only as a hash' },
        manage_url: { type: 'string' },
      },
    },
    BookingGuestView: {
      type: 'object',
      properties: {
        id: { type: 'string' }, code: { type: 'string' },
        status: { type: 'string', enum: ['held', 'confirmed', 'expired', 'cancelled', 'needs_attention'] },
        slot_start: { type: 'string', format: 'date-time' }, slot_end: { type: 'string', format: 'date-time' },
        duration_min: { type: 'integer' }, hold_expires_at: { type: 'string', format: 'date-time' },
        guest_name: { type: 'string' }, guest_email: { type: 'string' }, guest_timezone: { type: 'string', nullable: true },
        payment_method: { type: 'string', enum: ['polar', 'sepay'] },
        amount_expected: { type: 'integer', nullable: true, description: 'USD cents or VND' }, currency: { type: 'string', nullable: true },
        meet_url: { type: 'string', nullable: true }, reschedule_count: { type: 'integer' },
        can_reschedule: { type: 'boolean' }, reschedule_blocked_reason: { type: 'string', nullable: true },
        sepay: { $ref: '#/components/schemas/SepayTransfer' },
      },
    },
    BookingAdminView: {
      type: 'object',
      description: 'Full booking record (without the manage token hash), including fulfilment status fields.',
      properties: {
        id: { type: 'string' }, code: { type: 'string' }, status: { type: 'string' },
        slot_start: { type: 'string' }, slot_end: { type: 'string' }, guest_name: { type: 'string' }, guest_email: { type: 'string' },
        company: { type: 'string', nullable: true }, notes: { type: 'string', nullable: true },
        payment_method: { type: 'string' }, amount_expected: { type: 'integer', nullable: true }, amount_paid: { type: 'integer', nullable: true },
        currency: { type: 'string', nullable: true }, payment_ref: { type: 'string', nullable: true },
        meet_status: { type: 'string', nullable: true, enum: ['sent', 'unconfigured', 'failed', null] }, meet_error: { type: 'string', nullable: true },
        email_status: { type: 'string', nullable: true, enum: ['sent', 'unconfigured', 'failed', null] }, email_error: { type: 'string', nullable: true },
        attention_reason: { type: 'string', nullable: true, description: 'amount_mismatch | late_payment | admin' },
        admin_note: { type: 'string', nullable: true }, reschedule_count: { type: 'integer' },
      },
    },
    BookingAdminList: { type: 'object', properties: { bookings: { type: 'array', items: { $ref: '#/components/schemas/BookingAdminView' } } } },
    BookingAdminAction: {
      type: 'object',
      required: ['id', 'action'],
      properties: { id: { type: 'string' }, action: { type: 'string', enum: ['cancel', 'resolve', 'mark_attention', 'note'] }, note: { type: 'string' } },
    },
    BookingAvailability: {
      type: 'object',
      properties: {
        rules: {
          type: 'array',
          items: {
            type: 'object',
            required: ['weekday', 'start_time', 'end_time'],
            properties: {
              weekday: { type: 'integer', minimum: 0, maximum: 6 }, start_time: { type: 'string', example: '09:00' },
              end_time: { type: 'string', example: '17:00' }, timezone: { type: 'string', default: 'Asia/Ho_Chi_Minh' },
              slot_minutes: { type: 'integer', default: 90 },
            },
          },
        },
        exceptions: {
          type: 'array',
          items: {
            type: 'object',
            required: ['start_at', 'end_at'],
            properties: { start_at: { type: 'string', format: 'date-time' }, end_at: { type: 'string', format: 'date-time' }, reason: { type: 'string' } },
          },
        },
      },
    },
    SepayTransfer: {
      type: 'object',
      nullable: true,
      properties: {
        provider: { type: 'string', enum: ['sepay'] }, bank_account: { type: 'string' }, bank_code: { type: 'string' },
        amount: { type: 'integer' }, currency: { type: 'string', enum: ['VND'] },
        transfer_content: { type: 'string', example: 'ZBKAB23CD45' }, qr_url: { type: 'string' },
      },
    },
    BookingCheckout: {
      type: 'object',
      description: 'Polar: { provider, url, checkout_id, expires_at }. SePay: SepayTransfer fields plus expires_at.',
      properties: {
        provider: { type: 'string', enum: ['polar', 'sepay'] }, url: { type: 'string' }, checkout_id: { type: 'string' },
        qr_url: { type: 'string' }, transfer_content: { type: 'string' }, amount: { type: 'integer' }, expires_at: { type: 'string', format: 'date-time' },
      },
    },
    BookingPaymentResult: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['ignored', 'duplicate_event', 'unmatched', 'already_confirmed', 'confirmed', 'needs_attention'] },
        booking_id: { type: 'string', nullable: true },
      },
    },
    SepayWebhook: {
      type: 'object',
      required: ['id', 'transferType', 'transferAmount', 'content'],
      properties: {
        id: { type: 'integer' }, gateway: { type: 'string' }, transactionDate: { type: 'string' }, accountNumber: { type: 'string' },
        content: { type: 'string' }, transferType: { type: 'string', enum: ['in', 'out'] }, transferAmount: { type: 'number' }, referenceCode: { type: 'string' },
      },
    },
  },
};
