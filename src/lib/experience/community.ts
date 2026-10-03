import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import type { Principal } from '../members/policy';
import { can, requireCan } from '../members/policy';
import type { Row } from '../members/runtime';
import { randomId, str, strOrNull } from '../members/runtime';
import { getEntitlements } from '../members/subscriptions';
import { experienceRuntime, fetchWithTimeout, isRecord, readNumber, readString } from './runtime';

export const COMMUNITY_CHATS = ['en', 'vi'] as const;
export type CommunityChat = (typeof COMMUNITY_CHATS)[number];
export type MembershipStatus = 'invited' | 'joined' | 'left' | 'removed' | 'revoked';

/** Single-use invite links expire after one hour. */
export const INVITE_TTL_SECONDS = 60 * 60;
/** Invite requests per member per rolling day (guards against link farming). */
export const INVITE_DAILY_LIMIT = 6;
const TELEGRAM_TIMEOUT_MS = 8000;

export function isCommunityChat(v: unknown): v is CommunityChat {
  return typeof v === 'string' && (COMMUNITY_CHATS as readonly string[]).includes(v);
}

interface TelegramConfig {
  token: string;
  chats: Partial<Record<CommunityChat, string>>;
}

/** Env names that are still missing for the community bot (empty when usable). */
export function missingCommunityConfig(env: RuntimeEnv): string[] {
  const missing: string[] = [];
  if (!env.TELEGRAM_BOT_TOKEN) missing.push('TELEGRAM_BOT_TOKEN');
  if (!env.TELEGRAM_GROUP_EN_ID && !env.TELEGRAM_GROUP_VI_ID) missing.push('TELEGRAM_GROUP_EN_ID or TELEGRAM_GROUP_VI_ID');
  return missing;
}

function telegramConfig(env: RuntimeEnv): TelegramConfig | null {
  if (missingCommunityConfig(env).length > 0 || !env.TELEGRAM_BOT_TOKEN) return null;
  const chats: Partial<Record<CommunityChat, string>> = {};
  if (env.TELEGRAM_GROUP_EN_ID) chats.en = env.TELEGRAM_GROUP_EN_ID.trim();
  if (env.TELEGRAM_GROUP_VI_ID) chats.vi = env.TELEGRAM_GROUP_VI_ID.trim();
  return { token: env.TELEGRAM_BOT_TOKEN.trim(), chats };
}

function requireConfig(env: RuntimeEnv): TelegramConfig {
  const cfg = telegramConfig(env);
  if (!cfg) {
    throw new AppError(503, 'community_unconfigured', 'The Telegram community is not configured yet', { missing: missingCommunityConfig(env) });
  }
  return cfg;
}

/** Calls the Bot API. The token never appears in errors or logs. */
async function telegram(cfg: TelegramConfig, method: string, params: Record<string, unknown>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`https://api.telegram.org/bot${cfg.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }, TELEGRAM_TIMEOUT_MS);
  } catch {
    throw new AppError(502, 'telegram_unreachable', `Telegram ${method} could not be reached`);
  }
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body)) throw new AppError(502, 'telegram_error', `Telegram ${method} returned HTTP ${res.status}`);
  if (body.ok !== true) {
    const description = readString(body, 'description') ?? `HTTP ${res.status}`;
    const parameters = isRecord(body.parameters) ? body.parameters : {};
    const retry = readNumber(parameters, 'retry_after');
    if (res.status === 429 || retry !== null) {
      throw new AppError(429, 'telegram_rate_limited', `Telegram ${method} is rate limited`, { retry_after_seconds: retry });
    }
    throw new AppError(502, 'telegram_error', `Telegram ${method} failed: ${description.slice(0, 200)}`);
  }
  return body.result;
}

export interface MembershipView {
  id: string;
  chat: CommunityChat;
  status: MembershipStatus;
  /** Only returned while the invite is still usable. */
  invite_link: string | null;
  invite_expires_at: string;
  joined_at: string | null;
  created_at: string;
}

function toView(row: Row, now: number): MembershipView {
  const status = str(row, 'status');
  const chat = str(row, 'chat');
  const expires = str(row, 'invite_expires_at');
  const usable = status === 'invited' && Date.parse(expires) > now;
  return {
    id: str(row, 'id'),
    chat: isCommunityChat(chat) ? chat : 'en',
    status: isStatus(status) ? status : 'revoked',
    invite_link: usable ? str(row, 'invite_link') : null,
    invite_expires_at: expires,
    joined_at: strOrNull(row, 'joined_at'),
    created_at: str(row, 'created_at'),
  };
}

function isStatus(v: string): v is MembershipStatus {
  return ['invited', 'joined', 'left', 'removed', 'revoked'].includes(v);
}

export interface CommunityStatus {
  /** False for anonymous visitors (the UI then offers sign-in rather than an upgrade). */
  signed_in: boolean;
  configured: boolean;
  entitled: boolean;
  chats: { chat: CommunityChat; available: boolean }[];
  memberships: MembershipView[];
}

/** What the signed-in member can do; never throws for unconfigured or unentitled members. */
export async function communityStatus(d1: D1DatabaseLike, env: RuntimeEnv, p: Principal): Promise<CommunityStatus> {
  const cfg = telegramConfig(env);
  const now = experienceRuntime.now();
  const memberships: MembershipView[] = [];
  if (p.userId) {
    const { results } = await d1.prepare('SELECT * FROM community_memberships WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').bind(p.userId).all<Row>();
    memberships.push(...(results ?? []).map(r => toView(r, now)));
  }
  return {
    signed_in: p.kind !== 'anonymous',
    configured: cfg !== null,
    entitled: can(p, 'community:access'),
    chats: COMMUNITY_CHATS.map(chat => ({ chat, available: Boolean(cfg?.chats[chat]) })),
    memberships,
  };
}

/**
 * Issues (or re-shows) a one-hour, single-use invite link for one group. Requires a signed-in
 * member with the `community` entitlement ($29 plan); admins are allowed for testing.
 */
export async function requestInvite(d1: D1DatabaseLike, env: RuntimeEnv, p: Principal, chat: unknown): Promise<MembershipView> {
  requireCan(p, 'community:access');
  if (!p.userId) throw new AppError(403, 'member_account_required', 'Sign in with your member account to join the community');
  if (!isCommunityChat(chat)) throw new AppError(400, 'invalid_field', `chat must be one of ${COMMUNITY_CHATS.join(', ')}`, { field: 'chat' });
  const cfg = requireConfig(env);
  const chatId = cfg.chats[chat];
  if (!chatId) throw new AppError(503, 'community_unconfigured', `The ${chat.toUpperCase()} group is not configured yet`, { missing: [`TELEGRAM_GROUP_${chat.toUpperCase()}_ID`] });

  const now = experienceRuntime.now();
  const nowIso = new Date(now).toISOString();
  const joined = await d1.prepare("SELECT * FROM community_memberships WHERE user_id = ? AND chat = ? AND status = 'joined' LIMIT 1").bind(p.userId, chat).first<Row>();
  if (joined) throw new AppError(409, 'already_joined', 'You are already in this group', { membership: toView(joined, now) });
  const open = await d1.prepare(
    "SELECT * FROM community_memberships WHERE user_id = ? AND chat = ? AND status = 'invited' AND invite_expires_at > ? ORDER BY created_at DESC LIMIT 1"
  ).bind(p.userId, chat, nowIso).first<Row>();
  if (open) return toView(open, now);

  const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
  const recent = await d1.prepare('SELECT COUNT(*) AS n FROM community_memberships WHERE user_id = ? AND created_at > ?').bind(p.userId, dayAgo).first<Row>();
  if (Number(recent?.n ?? 0) >= INVITE_DAILY_LIMIT) {
    throw new AppError(429, 'rate_limited', 'Too many invite links today; try again tomorrow', { retry_after_seconds: 3600 });
  }

  const expireDate = Math.floor(now / 1000) + INVITE_TTL_SECONDS;
  const id = randomId('cm');
  const result = await telegram(cfg, 'createChatInviteLink', {
    chat_id: chatId,
    name: `zuey ${id}`.slice(0, 32),
    expire_date: expireDate,
    member_limit: 1,
  });
  const link = isRecord(result) ? readString(result, 'invite_link') : null;
  if (!link || !link.startsWith('https://t.me/')) throw new AppError(502, 'telegram_error', 'Telegram did not return an invite link');
  await d1.prepare(
    "INSERT INTO community_memberships (id, user_id, chat, invite_link, invite_expires_at, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'invited', ?, ?)"
  ).bind(id, p.userId, chat, link, new Date(expireDate * 1000).toISOString(), nowIso, nowIso).run();
  const row = await d1.prepare('SELECT * FROM community_memberships WHERE id = ?').bind(id).first<Row>();
  if (!row) throw new AppError(500, 'internal_error', 'Invite was not stored');
  return toView(row, now);
}

function chatForTelegramId(cfg: TelegramConfig, telegramChatId: string): CommunityChat | null {
  for (const chat of COMMUNITY_CHATS) if (cfg.chats[chat] === telegramChatId) return chat;
  return null;
}

/** Removes a user from a group without a permanent ban (ban, then lift the ban). */
async function removeFromChat(cfg: TelegramConfig, chatId: string, telegramUserId: string): Promise<void> {
  await telegram(cfg, 'banChatMember', { chat_id: chatId, user_id: Number(telegramUserId), revoke_messages: false });
  await telegram(cfg, 'unbanChatMember', { chat_id: chatId, user_id: Number(telegramUserId), only_if_banned: true });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type WebhookOutcome = 'joined' | 'joined_then_removed' | 'left' | 'ignored';

/**
 * Handles a Bot API `chat_member` update (webhook registered with secret_token and
 * allowed_updates ["chat_member"]). Links the joining Telegram user to the member who received
 * the single-use invite; a member whose entitlement lapsed before joining is removed at once.
 */
export async function handleTelegramUpdate(d1: D1DatabaseLike, env: RuntimeEnv, secretHeader: string | null, update: unknown): Promise<WebhookOutcome> {
  const cfg = requireConfig(env);
  if (!env.TELEGRAM_WEBHOOK_SECRET) {
    throw new AppError(503, 'community_unconfigured', 'TELEGRAM_WEBHOOK_SECRET is not set', { missing: ['TELEGRAM_WEBHOOK_SECRET'] });
  }
  if (!secretHeader || !constantTimeEqual(secretHeader, env.TELEGRAM_WEBHOOK_SECRET)) {
    throw new AppError(401, 'invalid_webhook_secret', 'Webhook secret token does not match');
  }
  if (!isRecord(update) || !isRecord(update.chat_member)) return 'ignored';
  const cm = update.chat_member;
  const chatObj = isRecord(cm.chat) ? cm.chat : null;
  const memberObj = isRecord(cm.new_chat_member) ? cm.new_chat_member : null;
  const userObj = memberObj && isRecord(memberObj.user) ? memberObj.user : null;
  const chatIdNum = chatObj ? readNumber(chatObj, 'id') : null;
  const userIdNum = userObj ? readNumber(userObj, 'id') : null;
  const status = memberObj ? readString(memberObj, 'status') : null;
  if (chatIdNum === null || userIdNum === null || !status) return 'ignored';
  const chat = chatForTelegramId(cfg, String(chatIdNum));
  if (!chat) return 'ignored';
  const telegramUserId = String(userIdNum);
  const nowIso = new Date(experienceRuntime.now()).toISOString();

  if (status === 'left' || status === 'kicked') {
    await d1.prepare(
      "UPDATE community_memberships SET status = 'left', updated_at = ? WHERE chat = ? AND telegram_user_id = ? AND status = 'joined'"
    ).bind(nowIso, chat, telegramUserId).run();
    return 'left';
  }
  if (!['member', 'restricted', 'administrator'].includes(status)) return 'ignored';
  const inviteObj = isRecord(cm.invite_link) ? cm.invite_link : null;
  const link = inviteObj ? readString(inviteObj, 'invite_link') : null;
  if (!link) return 'ignored';
  const row = await d1.prepare("SELECT * FROM community_memberships WHERE invite_link = ? AND chat = ? AND status = 'invited'").bind(link, chat).first<Row>();
  if (!row) return 'ignored';
  const userId = str(row, 'user_id');
  await d1.prepare(
    "UPDATE community_memberships SET status = 'joined', telegram_user_id = ?, joined_at = ?, updated_at = ? WHERE id = ?"
  ).bind(telegramUserId, nowIso, nowIso, str(row, 'id')).run();
  const { entitlements } = await getEntitlements(d1, userId);
  if (!entitlements.includes('community')) {
    const chatId = cfg.chats[chat];
    if (chatId) await removeFromChat(cfg, chatId, telegramUserId);
    await d1.prepare("UPDATE community_memberships SET status = 'removed', removed_at = ?, updated_at = ? WHERE id = ?").bind(nowIso, nowIso, str(row, 'id')).run();
    return 'joined_then_removed';
  }
  return 'joined';
}

export interface SweepResult {
  checked: number;
  removed: number;
  revoked: number;
  errors: { id: string; code: string; message: string }[];
}

/**
 * Admin/cron: removes joined members whose `community` entitlement lapsed and retires invite
 * links that expired or belong to lapsed members. Safe to re-run.
 */
export async function sweepCommunity(d1: D1DatabaseLike, env: RuntimeEnv): Promise<SweepResult> {
  const cfg = requireConfig(env);
  const now = experienceRuntime.now();
  const nowIso = new Date(now).toISOString();
  const { results } = await d1.prepare("SELECT * FROM community_memberships WHERE status IN ('invited', 'joined') ORDER BY created_at LIMIT 500").all<Row>();
  const rows = results ?? [];
  const entitledCache = new Map<string, boolean>();
  const out: SweepResult = { checked: rows.length, removed: 0, revoked: 0, errors: [] };
  for (const row of rows) {
    const id = str(row, 'id');
    const userId = str(row, 'user_id');
    const chat = str(row, 'chat');
    const chatId = isCommunityChat(chat) ? cfg.chats[chat] : undefined;
    let entitled = entitledCache.get(userId);
    if (entitled === undefined) {
      entitled = (await getEntitlements(d1, userId)).entitlements.includes('community');
      entitledCache.set(userId, entitled);
    }
    try {
      if (str(row, 'status') === 'invited') {
        const expired = Date.parse(str(row, 'invite_expires_at')) <= now;
        if (!expired && entitled) continue;
        if (!expired && chatId) await telegram(cfg, 'revokeChatInviteLink', { chat_id: chatId, invite_link: str(row, 'invite_link') });
        await d1.prepare("UPDATE community_memberships SET status = 'revoked', updated_at = ? WHERE id = ?").bind(nowIso, id).run();
        out.revoked += 1;
        continue;
      }
      if (entitled) continue;
      const telegramUserId = strOrNull(row, 'telegram_user_id');
      if (!chatId || !telegramUserId) {
        out.errors.push({ id, code: 'community_unconfigured', message: `No configured group or Telegram user for membership ${id}` });
        continue;
      }
      await removeFromChat(cfg, chatId, telegramUserId);
      await d1.prepare("UPDATE community_memberships SET status = 'removed', removed_at = ?, updated_at = ? WHERE id = ?").bind(nowIso, nowIso, id).run();
      out.removed += 1;
    } catch (err) {
      out.errors.push({ id, code: err instanceof AppError ? err.code : 'internal_error', message: err instanceof Error ? err.message : 'unknown error' });
    }
  }
  return out;
}
