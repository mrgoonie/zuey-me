/**
 * JSON Schemas shared by the promo/invoice OpenAPI fragment and MCP tools, so both describe the same admin
 * input the REST handlers validate (`parsePromoPatch`, `markInvoiceIssued`).
 */
import { BILLING_MONTHS, PLAN_IDS } from '../members/plans';
import { INVOICE_STATUSES } from './invoice-requests';
import { MAX_CARD_CYCLES, PROMO_PRODUCTS, PROMO_STATUSES } from './promo-codes';

const nullable = (schema: Record<string, unknown>) => ({ ...schema, type: [schema.type, 'null'] });

export const PROMO_INPUT_PROPERTIES: Record<string, unknown> = {
  code: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$', description: 'Stored upper-case; must not match a referral code' },
  percent: { type: 'integer', minimum: 1, maximum: 100, description: 'Percent off (100 = free order)' },
  status: { type: 'string', enum: PROMO_STATUSES },
  label: nullable({ type: 'string', maxLength: 120 }),
  note: nullable({ type: 'string', maxLength: 1000 }),
  starts_at: nullable({ type: 'string', format: 'date-time' }),
  ends_at: nullable({ type: 'string', format: 'date-time' }),
  max_uses: nullable({ type: 'integer', minimum: 1, description: 'Total uses (open checkouts hold a use until they expire); null = unlimited' }),
  once_per_customer: { type: 'boolean', description: 'One use per account / mailbox (default true)' },
  products: nullable({ type: 'array', items: { type: 'string', enum: PROMO_PRODUCTS }, description: 'null = every product' }),
  plans: nullable({ type: 'array', items: { type: 'string', enum: PLAN_IDS }, description: 'Membership plans; null = every plan' }),
  course_ids: nullable({ type: 'array', items: { type: 'string' }, description: 'Courses; null = every course' }),
  min_months: nullable({ type: 'integer', enum: BILLING_MONTHS, description: 'Shortest SePay prepaid term' }),
  card_cycles: { type: 'integer', minimum: 1, maximum: MAX_CARD_CYCLES, description: 'Monthly card (Dodo) charges the discount covers (default 1)' },
};

export const INVOICE_STATUS_FILTER = { type: 'string', enum: [...INVOICE_STATUSES, 'all'] };
