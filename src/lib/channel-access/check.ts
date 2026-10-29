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

/**
 * External entitlement verifier for the dewee Channel Access Gate in hosted linking mode (Dewee Connect).
 * Dewee links chat accounts itself and calls the verifier only for linked senders, with contract version 2
 * carrying `external_subject` = the zuey.me member id. The decision is one entitlement lookup by that id:
 * - `allow`: the member's plans grant `agent_chat` (admins always);
 * - `deny` + pricing `link_url`: no active plan with `agent_chat`;
 * - `deny` without a link: an unknown or deleted member, or a request without `external_subject`. A sender
 *   id is never mapped to a member here.
 */

export const CHANNEL_ACCESS_SCOPE = 'channel_access:check';
/** Version 2 is the hosted-mode request; version 1 (partner linking) is still parsed but never allowed. */
export const CHANNEL_ACCESS_CONTRACT_VERSIONS = [1, 2] as const;
export const ALLOW_TTL_SECONDS = 300;
export const DENY_TTL_SECONDS = 30;
/** A shorter configured key is treated as missing, so a weak value never opens the verifier. */
const MIN_SERVICE_KEY_LENGTH = 32;
/** Dewee's canonical sender id. */
export const SENDER_ID_RE = /^[A-Za-z0-9_.:@+-]{1,128}$/;
const CHANNEL_TYPE_RE = /^[a-z0-9_-]{1,32}$/;
const AUTHN_LEVELS = ['verified', 'channel'] as const;
type AuthnLevel = (typeof AUTHN_LEVELS)[number];
const CHAT_TYPES = ['direct', 'group'] as const;
type ChatType = (typeof CHAT_TYPES)[number];
type ContractVersion = (typeof CHANNEL_ACCESS_CONTRACT_VERSIONS)[number];
/** Dewee caps a partner subject at 255 bytes. */
const MAX_SUBJECT_LENGTH = 255;

export type ChannelAccessDecision = 'allow' | 'deny';

export interface ChannelAccessCheckInput {
  version: ContractVersion;
  tenant: string | null;
  agent_key: string | null;
  channel_type: string;
  channel_instance: string | null;
  sender_id: string;
  sender_username: string | null;
  chat_type: ChatType;
  chat_id: string | null;
  /** Dewee principal of the linked sender (version 2). */
  principal_id: string | null;
  /** zuey.me member id of the linked sender (version 2); null means no member was established. */
  external_subject: string | null;
  authn_level: AuthnLevel | null;
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

function isContractVersion(v: unknown): v is ContractVersion {
  return v === 1 || v === 2;
}

function isAuthnLevel(v: string): v is AuthnLevel {
  return v === 'verified' || v === 'channel';
}

/** Validates a contract request; throws AppError(400) naming the offending field. */
export function parseChannelAccessInput(args: Record<string, unknown>): ChannelAccessCheckInput {
  const version = args.version;
  if (!isContractVersion(version)) {
    throw new AppError(400, 'unsupported_version', `Only contract versions ${CHANNEL_ACCESS_CONTRACT_VERSIONS.join(', ')} are supported`, { field: 'version' });
  }
  const channelType = args.channel_type;
  if (typeof channelType !== 'string' || !CHANNEL_TYPE_RE.test(channelType)) {
    throw new AppError(400, 'unsupported_channel', 'channel_type must be a dewee channel type (lower-case letters, digits, _ and -)', { field: 'channel_type' });
  }
  const sender = optionalText(args, 'sender_id', 128);
  if (sender === null || !SENDER_ID_RE.test(sender)) throw invalid('sender_id', 'sender_id is required (letters, digits and _ . : @ + -)');
  const chatType = args.chat_type;
  if (chatType !== 'direct' && chatType !== 'group') throw invalid('chat_type', `chat_type must be one of ${CHAT_TYPES.join(', ')}`);
  // Identity fields count only in version 2, where Dewee itself established them.
  const v2 = version === 2;
  const subject = v2 ? optionalText(args, 'external_subject', MAX_SUBJECT_LENGTH) : null;
  const authn = v2 ? optionalText(args, 'authn_level', 16) : null;
  if (authn !== null && !isAuthnLevel(authn)) throw invalid('authn_level', `authn_level must be one of ${AUTHN_LEVELS.join(', ')}`);
  return {
    version,
    tenant: optionalText(args, 'tenant', 128),
    agent_key: optionalText(args, 'agent_key', 128),
    channel_type: channelType,
    channel_instance: optionalText(args, 'channel_instance', 128),
    sender_id: sender,
    sender_username: optionalText(args, 'sender_username', 64),
    chat_type: chatType,
    chat_id: optionalText(args, 'chat_id', 128),
    principal_id: v2 ? optionalText(args, 'principal_id', 64) : null,
    external_subject: subject !== null && subject.trim() !== '' ? subject : null,
    authn_level: authn,
  };
}

/** Opaque, stable reference to the member for dewee audit logs: never the email or the internal id. */
export async function subjectRef(userId: string): Promise<string> {
  return `zm_${(await sha256Hex(`channel-subject:${userId}`)).slice(0, 32)}`;
}

const AGENT_PLAN_NAMES = PLANS.filter(p => p.entitlements.includes('agent_chat')).map(p => p.name).join(', ');

/** Decides whether the linked member may talk to the agent. Expects a validated input. */
export async function checkChannelAccess(d1: D1DatabaseLike, env: RuntimeEnv, input: ChannelAccessCheckInput): Promise<ChannelAccessResult> {
  // Fail closed: without a Dewee-established member there is nobody to look up, and the sender id is never
  // used to guess one. In hosted mode Dewee does not call the verifier for unlinked senders at all.
  const user = input.external_subject ? await getUserById(d1, input.external_subject) : null;
  if (!user) {
    return {
      decision: 'deny',
      reply: 'Tài khoản chat này chưa được liên kết với tài khoản zuey.me. Hãy làm theo lời nhắc liên kết của bot.\nThis chat account is not linked to a zuey.me account. Follow the bot\'s link prompt.',
      ttl_seconds: DENY_TTL_SECONDS,
    };
  }
  const ref = await subjectRef(user.id);
  // Same rule as every other entitlement check: active subscriptions, card renewals within their grace period.
  const entitled = isAdminIdentity(user.email, user.email_verified_at, env)
    || (await getEntitlements(d1, user.id)).entitlements.includes('agent_chat');
  if (entitled) return { decision: 'allow', ttl_seconds: ALLOW_TTL_SECONDS, subject_ref: ref };
  const pricing = `${siteUrl(env)}/pricing`;
  return {
    decision: 'deny',
    reply: `Zuey AI dành cho thành viên có gói ${AGENT_PLAN_NAMES} còn hạn. Đăng ký hoặc gia hạn: ${pricing}\nZuey AI is for members with an active plan (${AGENT_PLAN_NAMES}): ${pricing}`,
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
