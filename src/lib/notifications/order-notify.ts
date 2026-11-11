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
  /** What the admin must do about it, when the outcome alone does not say. */
  note?: string;
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

/**
 * A SePay transfer on a course order that is already paid is money that arrived twice: the admin refunds it or decides
 * otherwise. Only the notice's own transfer reaches here (a redelivered transfer is a `duplicate_event`, which never
 * notifies), so the transfer's event id is the dedupe. Other kinds and Dodo's `already_paid` (the order's own payment
 * delivered again) stay silent.
 */
function isSecondCoursePayment(outcome: string, n?: Pick<OrderNotice, 'kind' | 'source'>): boolean {
  return outcome === 'already_paid' && n?.kind === 'course' && (n.source === 'sepay' || n.source === 'sepay_reconcile');
}

export function shouldNotifyOrder(outcome: string, n?: Pick<OrderNotice, 'kind' | 'source'>): boolean {
  return PAID_OUTCOMES.has(outcome) || ATTENTION_OUTCOMES.has(outcome) || isSecondCoursePayment(outcome, n);
}

function formatAmount(amount: number | null, currency: string): string {
  if (amount === null) return 'không rõ';
  const cur = currency.toUpperCase();
  if (cur === 'VND') return `${new Intl.NumberFormat('vi-VN').format(amount)} ₫`;
  return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount / 100)} ${cur}`;
}

const SECOND_PAYMENT_NOTE = 'Đơn đã thanh toán trước đó; số tiền trên là khoản thanh toán lần hai, cần hoàn tiền hoặc xử lý';

export function formatOrderNotice(n: OrderNotice): string {
  const head = PAID_OUTCOMES.has(n.outcome) ? '💰 Đơn hàng mới đã thanh toán' : '⚠️ Thanh toán cần kiểm tra';
  return [
    head,
    `Loại: ${KIND_LABELS[n.kind]}`,
    `Mã đơn: ${n.code}`,
    `Số tiền: ${formatAmount(n.amount, n.currency)}`,
    `Kênh: ${SOURCE_LABELS[n.source]}`,
    `Mã giao dịch: ${n.paymentRef ?? 'không có'}`,
    ...(n.note ? [`Ghi chú: ${n.note}`] : isSecondCoursePayment(n.outcome, n) ? [SECOND_PAYMENT_NOTE] : []),
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
  if (!shouldNotifyOrder(n.outcome, n)) return;
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
  if (!shouldNotifyOrder(n.outcome, n)) return;
  const sent = notifyOrder(env, n);
  const waitUntil = runtimeWaitUntil(runtime);
  if (waitUntil) waitUntil(sent);
  else await sent;
}
