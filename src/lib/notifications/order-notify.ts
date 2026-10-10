import type { RuntimeEnv } from '../../env';
import { runtimeWaitUntil } from '../blocks/articles';
import { fetchWithTimeout } from '../experience/runtime';

const NOTIFY_TIMEOUT_MS = 5000;

export type OrderKind = 'membership' | 'course' | 'booking';
export type OrderSource = 'sepay' | 'sepay_reconcile' | 'dodo' | 'paypal';

export interface OrderNotice {
  kind: OrderKind;
  source: OrderSource;
  /** Order, booking or card-subscription reference shown to the admin. */
  code: string;
  /** Whole đồng for VND; minor units (cents) for any other currency. */
  amount: number | null;
  currency: string;
  /** Outcome returned by the payment applier. */
  outcome: string;
  paymentRef: string | null;
}

const KIND_LABELS: Record<OrderKind, string> = {
  membership: 'Gói thành viên',
  course: 'Khoá học',
  booking: 'Lịch tư vấn',
};

const SOURCE_LABELS: Record<OrderSource, string> = {
  sepay: 'Chuyển khoản SePay',
  sepay_reconcile: 'Chuyển khoản SePay (đối soát)',
  dodo: 'Thẻ (Dodo)',
  paypal: 'PayPal',
};

/** Outcomes worth a message: a newly paid order or card subscription, or money that arrived but needs an admin. */
const PAID_OUTCOMES = new Set(['paid', 'confirmed', 'activated']);
const ATTENTION_OUTCOMES = new Set(['needs_attention']);

export function shouldNotifyOrder(outcome: string): boolean {
  return PAID_OUTCOMES.has(outcome) || ATTENTION_OUTCOMES.has(outcome);
}

function formatAmount(amount: number | null, currency: string): string {
  if (amount === null) return 'không rõ';
  const cur = currency.toUpperCase();
  if (cur === 'VND') return `${new Intl.NumberFormat('vi-VN').format(amount)} ₫`;
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount / 100)} ${cur}`;
}

export function formatOrderNotice(n: OrderNotice): string {
  const head = PAID_OUTCOMES.has(n.outcome) ? '💰 Đơn hàng mới đã thanh toán' : '⚠️ Thanh toán cần kiểm tra';
  return [
    head,
    `Loại: ${KIND_LABELS[n.kind]}`,
    `Mã đơn: ${n.code}`,
    `Số tiền: ${formatAmount(n.amount, n.currency)}`,
    `Kênh: ${SOURCE_LABELS[n.source]}`,
    `Mã giao dịch: ${n.paymentRef ?? 'không có'}`,
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
 * Sends an order notice to the admin channels that are configured: the Telegram group
 * (TELEGRAM_GROUP_ID_SEPAY_NOTI, sent with TELEGRAM_BOT_TOKEN) and the Discord channel webhook
 * (DISCORD_WEBHOOK_SEPAY_NOTI). Never throws; a channel without config is skipped.
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

/** Notifies after the response when the Workers runtime allows it (waitUntil), otherwise inline. */
export async function announceOrder(
  runtime: { ctx?: { waitUntil(promise: Promise<unknown>): void } } | undefined, env: RuntimeEnv, n: OrderNotice,
): Promise<void> {
  if (!shouldNotifyOrder(n.outcome)) return;
  const sent = notifyOrder(env, n);
  const waitUntil = runtimeWaitUntil(runtime);
  if (waitUntil) waitUntil(sent);
  else await sent;
}
