import type { RuntimeEnv } from '../../env';
import { AppError } from '../http';
import { isAdminIdentity } from '../members/admins';
import { getEntitlements } from '../members/subscriptions';
import type { LinkPreviewState } from './identities';
import { linkPreview, readLinkToken } from './identities';

export type ChannelConnectState = LinkPreviewState | 'error';

/**
 * Everything the /connect island receives. It is serialised into the page HTML (island props), where page
 * analytics may record it, so it holds only non-secret preview data: never the link token, never the full
 * sender id or username. The confirm button posts to `/connect/link`, which reads the token from the cookie.
 */
export interface ChannelConnectProps {
  state: ChannelConnectState;
  /** Channel type of the token, e.g. `telegram`. */
  provider: string | null;
  /** Masked sender handle shown for recognition, e.g. `@al…e` or `ID …001`. */
  senderLabel: string | null;
  /** Whether the member's plans already allow chatting with the agent (shown once linked). */
  entitled: boolean;
  /** Error code when state is error. */
  errorCode: string | null;
}

/** Enough of the handle for the member to recognise their own account, not enough to identify anyone. */
export function maskSender(senderId: string, username: string | null): string {
  if (username) {
    const u = username.replace(/^@/, '');
    return u.length <= 3 ? `@${u.slice(0, 1)}…` : `@${u.slice(0, 2)}…${u.slice(-1)}`;
  }
  return `ID …${senderId.slice(-3)}`;
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
    return { state, provider: payload.channel_type, senderLabel: maskSender(payload.sender_id, payload.sender_username), entitled, errorCode: null };
  } catch (err) {
    if (!(err instanceof AppError)) console.error('connect page failed:', err instanceof Error ? err.message : 'unknown');
    return { ...NO_TOKEN, errorCode: err instanceof AppError ? err.code : 'invalid_link_token' };
  }
}
