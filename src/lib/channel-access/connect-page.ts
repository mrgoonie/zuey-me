import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { isAdminIdentity } from '../members/admins';
import { getEntitlements } from '../members/subscriptions';
import type { LinkPreviewState } from './identities';
import { linkPreview, readLinkToken } from './identities';

export type ChannelConnectState = LinkPreviewState | 'error';

/**
 * Everything the /connect island receives. It is serialised into the page HTML (island props), so it never
 * holds the link token: the confirm button posts to `/connect/link`, which reads the token from the cookie.
 * The sender handle is shown in full so the member can tell their own chat account from an attacker's (a
 * phishing link would otherwise attach someone else's Telegram account to the member's plan). /connect is an
 * analytics-sensitive path with no query string and the island sits inside `ph-no-capture`.
 */
export interface ChannelConnectProps {
  state: ChannelConnectState;
  /** Channel type of the token, e.g. `telegram`. */
  provider: string | null;
  /** Full sender handle the member must recognise before linking, e.g. `@alice` or `ID 777001`. */
  senderLabel: string | null;
  /** Whether the member's plans already allow chatting with the agent (shown once linked). */
  entitled: boolean;
  /** Error code when state is error. */
  errorCode: string | null;
}

/** The sender as the member knows it: `@username`, or the numeric id when the account has no username. */
export function senderLabel(senderId: string, username: string | null): string {
  const u = (username ?? '').replace(/^@/, '');
  return u ? `@${u}` : `ID ${senderId}`;
}

interface ConnectViewer {
  id: string;
  email: string;
  email_verified_at: string | null;
}

const NO_TOKEN: ChannelConnectProps = { state: 'error', provider: null, senderLabel: null, entitled: false, errorCode: 'missing_token' };

/** Builds the /connect island props for the signed-in viewer from the token parked in the cookie. */
export async function buildConnectProps(env: RuntimeEnv, token: string | null, viewer: ConnectViewer): Promise<ChannelConnectProps> {
  if (!token) return NO_TOKEN;
  const d1 = env.DB;
  if (!d1) return { ...NO_TOKEN, errorCode: 'database_unavailable' };
  try {
    const payload = await readLinkToken(env, token);
    const state = await linkPreview(d1, payload, viewer.id);
    const entitled = state === 'linked_to_you'
      && (isAdminIdentity(viewer.email, viewer.email_verified_at, env)
        || (await getEntitlements(d1, viewer.id)).entitlements.includes('agent_chat'));
    return { state, provider: payload.channel_type, senderLabel: senderLabel(payload.sender_id, payload.sender_username), entitled, errorCode: null };
  } catch (err) {
    if (err instanceof AppError) return { ...NO_TOKEN, errorCode: err.code };
    // A database or runtime failure says nothing about the token: keep it (and its cookie) for a retry.
    console.error('connect page failed:', err instanceof Error ? err.message : 'unknown');
    return { ...NO_TOKEN, errorCode: 'database_unavailable' };
  }
}
