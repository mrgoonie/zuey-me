import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { extractApiToken } from '../auth';
import { AppError } from '../http';
import { isAdminIdentity } from '../members/admins';
import { PLANS } from '../members/plans';
import { requireMembersDb, sha256Hex, siteUrl } from '../members/runtime';
import { getEntitlements } from '../members/subscriptions';
import { getUserById } from '../members/users';
import { timingSafeEqualStrings } from '../payments/sepay';
import type { ChannelType } from './link-token';
import { LINK_TOKEN_SHAPE_RE, MAX_LINK_TOKEN_LENGTH, SENDER_ID_RE, SUPPORTED_CHANNEL_TYPES, isChannelType } from './link-token';
import { findChannelIdentity } from './identities';

/**
 * External entitlement verifier for the dewee Channel Access Gate (contract version 1). Dewee asks, per
 * inbound message (cached by dewee), whether a channel sender may talk to the Zuey AI agent:
 * - `allow`: the sender is linked to a member whose plans grant `agent_chat` (admins always);
 * - `deny` + pricing `link_url`: linked, but no active plan with `agent_chat`;
 * - `link_required` (+ `/connect` link when dewee sent `link_token` in a direct chat; never in a group): the sender
 *   is not linked to any member.
 */

export const CHANNEL_ACCESS_SCOPE = 'channel_access:check';
export const CHANNEL_ACCESS_CONTRACT_VERSION = 1;
export const ALLOW_TTL_SECONDS = 300;
export const DENY_TTL_SECONDS = 30;
export const LINK_REQUIRED_TTL_SECONDS = 30;
/** A shorter configured key is treated as missing, so a weak value never opens the verifier. */
const MIN_SERVICE_KEY_LENGTH = 32;
const CHAT_TYPES = ['direct', 'group'] as const;
type ChatType = (typeof CHAT_TYPES)[number];

export type ChannelAccessDecision = 'allow' | 'deny' | 'link_required';

export interface ChannelAccessCheckInput {
  version: number;
  tenant: string | null;
  agent_key: string | null;
  channel_type: ChannelType;
  channel_instance: string | null;
  sender_id: string;
  sender_username: string | null;
  chat_type: ChatType;
  chat_id: string | null;
  link_token: string | null;
}

export interface ChannelAccessResult {
  decision: ChannelAccessDecision;
  reply?: string;
  link_url?: string;
  ttl_seconds: number;
  subject_ref?: string;
}

/**
 * Only the dedicated service credential `CHANNEL_ACCESS_SERVICE_KEY` (Bearer or X-API-Key) may call the
 * verifier: admin keys, Studio sessions and personal `zk_` keys are all rejected, and the service key is
 * accepted nowhere else. Compared in constant time; the key is never logged or echoed.
 */
export async function requireChannelAccessService(request: Request, env: RuntimeEnv): Promise<void> {
  const expected = (env.CHANNEL_ACCESS_SERVICE_KEY ?? '').trim();
  if (expected.length < MIN_SERVICE_KEY_LENGTH) {
    throw new AppError(503, 'channel_access_unconfigured', 'The channel access verifier is not configured', { missing: ['CHANNEL_ACCESS_SERVICE_KEY'] });
  }
  const presented = extractApiToken(request);
  if (!presented) {
    throw new AppError(401, 'unauthorized', `A service key with scope ${CHANNEL_ACCESS_SCOPE} is required (Authorization: Bearer <key>)`);
  }
  if (!(await timingSafeEqualStrings(presented, expected))) {
    throw new AppError(401, 'invalid_service_key', `Invalid service key for scope ${CHANNEL_ACCESS_SCOPE}`);
  }
}

function invalid(field: string, message: string): AppError {
  return new AppError(400, 'invalid_field', message, { field });
}

function optionalText(args: Record<string, unknown>, key: string, max: number): string | null {
  const v = args[key];
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  if (typeof v !== 'string' || v.length > max) throw invalid(key, `${key} must be a string of at most ${max} characters`);
  return v;
}

/** Validates a contract-v1 request; throws AppError(400) naming the offending field. */
export function parseChannelAccessInput(args: Record<string, unknown>): ChannelAccessCheckInput {
  if (args.version !== CHANNEL_ACCESS_CONTRACT_VERSION) {
    throw new AppError(400, 'unsupported_version', `Only contract version ${CHANNEL_ACCESS_CONTRACT_VERSION} is supported`, { field: 'version' });
  }
  const channelType = args.channel_type;
  if (!isChannelType(channelType)) {
    throw new AppError(400, 'unsupported_channel', `channel_type must be one of ${SUPPORTED_CHANNEL_TYPES.join(', ')}`, { field: 'channel_type' });
  }
  const sender = optionalText(args, 'sender_id', 128);
  if (sender === null || !SENDER_ID_RE.test(sender)) throw invalid('sender_id', 'sender_id is required (letters, digits and _ . : @ + -)');
  const chatType = args.chat_type;
  if (chatType !== 'direct' && chatType !== 'group') throw invalid('chat_type', `chat_type must be one of ${CHAT_TYPES.join(', ')}`);
  const linkToken = optionalText(args, 'link_token', MAX_LINK_TOKEN_LENGTH);
  return {
    version: CHANNEL_ACCESS_CONTRACT_VERSION,
    tenant: optionalText(args, 'tenant', 128),
    agent_key: optionalText(args, 'agent_key', 128),
    channel_type: channelType,
    channel_instance: optionalText(args, 'channel_instance', 128),
    sender_id: sender,
    sender_username: optionalText(args, 'sender_username', 64),
    chat_type: chatType,
    chat_id: optionalText(args, 'chat_id', 128),
    // A token that does not look like one is ignored rather than echoed into a URL.
    link_token: linkToken !== null && LINK_TOKEN_SHAPE_RE.test(linkToken) ? linkToken : null,
  };
}

/** Opaque, stable reference to the member for dewee audit logs: never the email or the internal id. */
export async function subjectRef(userId: string): Promise<string> {
  return `zm_${(await sha256Hex(`channel-subject:${userId}`)).slice(0, 32)}`;
}

const AGENT_PLAN_NAMES = PLANS.filter(p => p.entitlements.includes('agent_chat')).map(p => p.name).join(', ');

/** Decides whether the sender may talk to the agent. Expects a validated input. */
export async function checkChannelAccess(d1: D1DatabaseLike, env: RuntimeEnv, input: ChannelAccessCheckInput): Promise<ChannelAccessResult> {
  const site = siteUrl(env);
  const identity = await findChannelIdentity(d1, input.channel_type, input.sender_id);
  const user = identity ? await getUserById(d1, identity.user_id) : null;
  if (!identity || !user) {
    // A link token names one sender: in a group anyone could open it and link that sender to their own account,
    // so the token is only ever handed out in a direct chat with the bot.
    if (input.chat_type !== 'direct') {
      return {
        decision: 'link_required',
        reply: 'Nhắn riêng cho bot để liên kết tài khoản zuey.me và chat với Zuey AI.\nSend the bot a direct message to link your zuey.me account and chat with Zuey AI.',
        ttl_seconds: LINK_REQUIRED_TTL_SECONDS,
      };
    }
    const linkUrl = input.link_token ? `${site}/connect?token=${encodeURIComponent(input.link_token)}` : undefined;
    return {
      decision: 'link_required',
      reply: linkUrl
        ? `Liên kết tài khoản zuey.me để chat với Zuey AI: ${linkUrl}\nLink your zuey.me account to chat with Zuey AI: ${linkUrl}`
        : 'Hãy liên kết tài khoản zuey.me để chat với Zuey AI.\nLink your zuey.me account to chat with Zuey AI.',
      ...(linkUrl ? { link_url: linkUrl } : {}),
      ttl_seconds: LINK_REQUIRED_TTL_SECONDS,
    };
  }
  const ref = await subjectRef(user.id);
  // Same rule as every other entitlement check: active subscriptions, card renewals within their grace period.
  const entitled = isAdminIdentity(user.email, user.email_verified_at, env)
    || (await getEntitlements(d1, user.id)).entitlements.includes('agent_chat');
  if (entitled) return { decision: 'allow', ttl_seconds: ALLOW_TTL_SECONDS, subject_ref: ref };
  const pricing = `${site}/pricing`;
  return {
    decision: 'deny',
    reply: `Zuey AI trên Telegram dành cho thành viên có gói ${AGENT_PLAN_NAMES} còn hạn. Đăng ký hoặc gia hạn: ${pricing}\nZuey AI on Telegram is for members with an active plan (${AGENT_PLAN_NAMES}): ${pricing}`,
    link_url: pricing,
    ttl_seconds: DENY_TTL_SECONDS,
    subject_ref: ref,
  };
}

/** Full verifier call shared by the MCP tool and the REST endpoint: service auth, validation, decision. */
export async function handleChannelAccessCheck(request: Request, env: RuntimeEnv, args: Record<string, unknown>): Promise<ChannelAccessResult> {
  await requireChannelAccessService(request, env);
  const input = parseChannelAccessInput(args);
  return checkChannelAccess(requireMembersDb(env), env, input);
}
