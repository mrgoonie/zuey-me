import type { RuntimeEnv } from '../../env';
import { fetchWithTimeout } from '../experience/runtime';

const NOTIFY_TIMEOUT_MS = 5000;

export type OrderKind = 'membership' | 'course' | 'booking';

export interface OrderNotice {
  kind: OrderKind;
  /** Order or booking code from the transfer content (ZSB… / ZSC… / ZBK…). */
  code: string;
  amountVnd: number;
  /** Outcome returned by the payment applier. */
  outcome: string;
  paymentRef: string;
}

const KIND_LABELS: Record<OrderKind, string> = {
  membership: 'Gói thành viên',
  course: 'Khoá học',
  booking: 'Lịch tư vấn',
};

/** Outcomes worth a message: a newly paid order, or money that arrived but needs an admin. */
const PAID_OUTCOMES = new Set(['paid', 'confirmed']);
const ATTENTION_OUTCOMES = new Set(['needs_attention']);

export function shouldNotifyOrder(outcome: string): boolean {
  return PAID_OUTCOMES.has(outcome) || ATTENTION_OUTCOMES.has(outcome);
}

export function formatOrderNotice(n: OrderNotice): string {
  const head = PAID_OUTCOMES.has(n.outcome) ? '💰 Đơn hàng mới đã thanh toán' : '⚠️ Chuyển khoản cần kiểm tra';
  return [
    head,
    `Loại: ${KIND_LABELS[n.kind]}`,
    `Mã đơn: ${n.code}`,
    `Số tiền: ${new Intl.NumberFormat('vi-VN').format(n.amountVnd)} ₫`,
    `Mã giao dịch: ${n.paymentRef}`,
  ].join('\n');
}

/** Best-effort POST: failures are logged by channel name only, so tokens and webhook URLs never reach logs. */
async function post(channel: string, url: string, body: unknown): Promise<void> {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, NOTIFY_TIMEOUT_MS);
    if (!res.ok) console.warn(`order ${channel} notice failed: HTTP ${res.status}`);
  } catch {
    console.warn(`order ${channel} notice failed: unreachable`);
  }
}

/**
 * Announces an order to the admin channels that are configured: the Telegram group
 * (TELEGRAM_GROUP_ID_SEPAY_NOTI, sent with TELEGRAM_BOT_TOKEN) and the Discord channel webhook
 * (DISCORD_WEBHOOK_SEPAY_NOTI). Never fails the payment webhook; a channel without config is skipped.
 */
export async function notifyOrder(env: RuntimeEnv, n: OrderNotice): Promise<void> {
  if (!shouldNotifyOrder(n.outcome)) return;
  const text = formatOrderNotice(n);
  const sends: Promise<void>[] = [];
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_GROUP_ID_SEPAY_NOTI?.trim();
  if (token && chatId) {
    sends.push(post('telegram', `https://api.telegram.org/bot${token}/sendMessage`, { chat_id: chatId, text, disable_web_page_preview: true }));
  }
  const discord = env.DISCORD_WEBHOOK_SEPAY_NOTI?.trim();
  if (discord) {
    // No mentions: an order notice must never ping @everyone even if a code looked like one.
    sends.push(post('discord', discord, { content: text, allowed_mentions: { parse: [] } }));
  }
  await Promise.all(sends);
}
