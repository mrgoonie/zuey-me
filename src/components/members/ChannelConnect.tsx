import { useState } from 'react';
import { alertError, alertInfo, alertOk, btnGhost, btnPrimary, callApi, card, isRecord, jsonBody } from './member-ui';

export type ChannelConnectState = 'ready' | 'linked_to_you' | 'linked_elsewhere' | 'used' | 'error';

export interface ChannelConnectProps {
  state: ChannelConnectState;
  /** Signed dewee token (only when state is ready). */
  token: string | null;
  provider: string | null;
  senderId: string | null;
  senderUsername: string | null;
  /** Whether the member's plans already allow chatting with the agent. */
  entitled: boolean;
  /** Error code when state is error. */
  errorCode: string | null;
}

const PROVIDER_LABEL: Record<string, string> = { telegram: 'Telegram' };

const ERROR_COPY: Record<string, string> = {
  missing_token: 'Không tìm thấy liên kết. Hãy mở lại liên kết mà bot gửi cho bạn trên Telegram.',
  invalid_link_token: 'Liên kết không hợp lệ. Hãy nhắn lại cho bot trên Telegram để nhận liên kết mới.',
  link_token_expired: 'Liên kết đã hết hạn. Hãy nhắn lại cho bot trên Telegram để nhận liên kết mới.',
  link_token_used: 'Liên kết này đã được dùng. Hãy nhắn lại cho bot trên Telegram để nhận liên kết mới.',
  unsupported_channel: 'Kênh chat này chưa hỗ trợ liên kết với zuey.me.',
  channel_linked_elsewhere: 'Tài khoản chat này đã được liên kết với một tài khoản zuey.me khác. Mỗi tài khoản Telegram chỉ liên kết được với một tài khoản zuey.me. Nếu đó là tài khoản cũ của bạn, hãy đăng nhập tài khoản đó và huỷ liên kết trong trang Tài khoản, hoặc liên hệ hi@zuey.me.',
  channel_link_unconfigured: 'Tính năng liên kết chưa sẵn sàng. Vui lòng thử lại sau.',
  database_unavailable: 'Hệ thống đang bận. Vui lòng thử lại sau.',
};

function errorCopy(code: string | null, fallback = 'Không liên kết được. Vui lòng thử lại.'): string {
  return (code && ERROR_COPY[code]) || fallback;
}

function Done({ entitled, provider }: { entitled: boolean; provider: string }) {
  if (entitled) {
    return (
      <p className={alertOk}>
        Đã liên kết. Bạn có thể quay lại {provider} và nhắn tiếp cho Zuey AI.
      </p>
    );
  }
  return (
    <div className="grid gap-3">
      <p className={alertInfo}>
        Đã liên kết. Để chat với Zuey AI trên {provider}, tài khoản của bạn cần một gói còn hạn có Zuey AI (Zuey AI, Kết hợp hoặc Cộng đồng).
      </p>
      <p><a className={btnPrimary} href="/pricing">Xem các gói thành viên</a></p>
    </div>
  );
}

/** Confirmation step of /connect: the member explicitly links the chat account named by the token. */
export function ChannelConnect(props: ChannelConnectProps) {
  const provider = PROVIDER_LABEL[props.provider ?? ''] ?? 'Telegram';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [linked, setLinked] = useState<{ entitled: boolean } | null>(props.state === 'linked_to_you' ? { entitled: props.entitled } : null);

  async function link() {
    if (!props.token) return;
    setBusy(true); setError(null);
    const res = await callApi('/api/v1/channel-access/link', { method: 'POST', body: jsonBody({ token: props.token }) });
    setBusy(false);
    if (res.ok) setLinked({ entitled: isRecord(res.data) && res.data.entitled === true });
    else setError(errorCopy(res.code, res.message));
  }

  const who = props.senderUsername ? `@${props.senderUsername}` : `ID ${props.senderId ?? ''}`;

  return (
    <section className={card} aria-labelledby="connect-title">
      <h1 id="connect-title" className="text-2xl sm:text-3xl font-bold font-serif mb-4">Liên kết {provider} với zuey.me</h1>
      {props.state === 'error' && <p className={alertError}>{errorCopy(props.errorCode)}</p>}
      {props.state === 'linked_elsewhere' && <p className={alertError}>{errorCopy('channel_linked_elsewhere')}</p>}
      {props.state === 'used' && <p className={alertError}>{errorCopy('link_token_used')}</p>}
      {linked && <Done entitled={linked.entitled} provider={provider} />}
      {props.state === 'ready' && !linked && (
        <div className="grid gap-4">
          <p className="text-sm">
            Liên kết tài khoản {provider} <strong className="break-all">{who}</strong> với tài khoản zuey.me đang đăng nhập.
            Sau khi liên kết, Zuey AI trên {provider} sẽ trả lời bạn theo gói thành viên của tài khoản này.
          </p>
          <p className="text-xs text-stone-600">
            Chỉ tiếp tục nếu đây là tài khoản {provider} của bạn và liên kết này do chính bạn mở từ bot. Bạn có thể huỷ liên kết bất cứ lúc nào trong trang Tài khoản.
          </p>
          <div role="status" aria-live="polite" className="empty:hidden">{error && <p className={alertError}>{error}</p>}</div>
          <p className="flex flex-wrap gap-2">
            <button type="button" className={btnPrimary} disabled={busy} onClick={link}>{busy ? 'Đang liên kết…' : 'Liên kết tài khoản'}</button>
            <a className={btnGhost} href="/account#email">Huỷ</a>
          </p>
        </div>
      )}
    </section>
  );
}
