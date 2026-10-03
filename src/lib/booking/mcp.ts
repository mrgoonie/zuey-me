import { AppError } from '../http';
import type { McpToolModule } from '../mcp/types';
import { SLOT_HORIZON_DAYS } from './availability';
import {
  ADMIN_ACTIONS,
  BOOKING_STATUSES,
  adminUpdateBooking,
  getAvailability,
  listBookings,
  listSlots,
  parseAdminAction,
  parseAvailabilityInput,
  parseStatusFilter,
  requireDb,
  setAvailability,
} from './store';

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string') throw new AppError(400, 'invalid_argument', `${key} must be a string`);
  return v;
}

function optionalIso(args: Record<string, unknown>, key: string): string | undefined {
  const v = optionalString(args, key);
  if (v === undefined) return undefined;
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new AppError(400, 'invalid_argument', `${key} must be an ISO date-time`);
  return new Date(ms).toISOString();
}

function optionalInt(args: Record<string, unknown>, key: string, min: number, max: number): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new AppError(400, 'invalid_argument', `${key} must be an integer ${min}-${max}`);
  }
  return v;
}

const ruleSchema = {
  type: 'object',
  properties: {
    weekday: { type: 'integer', minimum: 0, maximum: 6, description: '0 = Sunday' },
    start_time: { type: 'string', description: 'HH:MM local time' },
    end_time: { type: 'string', description: 'HH:MM local time' },
    timezone: { type: 'string', description: 'IANA zone, default Asia/Ho_Chi_Minh' },
    slot_minutes: { type: 'integer', minimum: 15, maximum: 480, description: 'Default 90' },
  },
  required: ['weekday', 'start_time', 'end_time'],
};

const exceptionSchema = {
  type: 'object',
  properties: {
    start_at: { type: 'string', description: 'UTC ISO start of blocked range' },
    end_at: { type: 'string', description: 'UTC ISO end of blocked range' },
    reason: { type: 'string' },
  },
  required: ['start_at', 'end_at'],
};

export const bookingMcpModule: McpToolModule = {
  tools: [
    {
      name: 'booking_slots',
      description: 'List open "Zuey for Business" consultation slots ($1,999, 90-minute Google Meet). Times are UTC ISO.',
      inputSchema: {
        type: 'object',
        properties: {
          from: { type: 'string', description: 'ISO start of the window (default now)' },
          days: { type: 'integer', minimum: 1, maximum: SLOT_HORIZON_DAYS, description: 'Window length in days' },
        },
      },
    },
    {
      name: 'booking_list',
      description: 'Admin: list consultation bookings with optional filters.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: BOOKING_STATUSES },
          from: { type: 'string', description: 'ISO lower bound of slot_start' },
          to: { type: 'string', description: 'ISO upper bound of slot_start' },
          limit: { type: 'integer', minimum: 1, maximum: 500 },
        },
      },
    },
    {
      name: 'availability_get',
      description: 'Admin: read weekly availability rules and blocked ranges.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'availability_set',
      description: 'Admin: replace all weekly availability rules and blocked ranges.',
      inputSchema: {
        type: 'object',
        properties: {
          rules: { type: 'array', items: ruleSchema },
          exceptions: { type: 'array', items: exceptionSchema },
        },
        required: ['rules'],
      },
    },
    {
      name: 'booking_update_status',
      description: 'Admin: cancel (no automatic refund), resolve (manual confirm), mark_attention or add a note to a booking.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          action: { type: 'string', enum: ADMIN_ACTIONS },
          note: { type: 'string' },
        },
        required: ['id', 'action'],
      },
    },
  ],

  async call(name, args, ctx) {
    const d1 = requireDb({ ...ctx.env, DB: ctx.d1 ?? ctx.env.DB });
    switch (name) {
      case 'booking_slots': {
        const from = optionalIso(args, 'from');
        const days = optionalInt(args, 'days', 1, SLOT_HORIZON_DAYS);
        return { slots: await listSlots(d1, { from: from ? Date.parse(from) : undefined, days }) };
      }
      case 'booking_list':
        await ctx.requireAdmin();
        return {
          bookings: await listBookings(d1, {
            status: parseStatusFilter(optionalString(args, 'status')),
            from: optionalIso(args, 'from'),
            to: optionalIso(args, 'to'),
            limit: optionalInt(args, 'limit', 1, 500),
          }),
        };
      case 'availability_get':
        await ctx.requireAdmin();
        return getAvailability(d1);
      case 'availability_set':
        await ctx.requireAdmin();
        return setAvailability(d1, parseAvailabilityInput(args));
      case 'booking_update_status': {
        await ctx.requireAdmin();
        const id = optionalString(args, 'id');
        if (!id) throw new AppError(400, 'invalid_argument', 'id is required');
        return adminUpdateBooking(d1, ctx.env, id, parseAdminAction(args.action), optionalString(args, 'note') ?? null);
      }
      default:
        throw new AppError(404, 'unknown_tool', `Unknown tool: ${name}`);
    }
  },
};
