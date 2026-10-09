// Shared helpers for the Studio Referrals tab: admin JSON client, value readers and the Studio dark styles.
import type { ReactNode } from 'react';

export type AdminResult = { ok: true; data: Record<string, unknown> } | { ok: false; message: string };

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const s = (r: Record<string, unknown>, k: string): string => (typeof r[k] === 'string' ? String(r[k]) : '');
export const sn = (r: Record<string, unknown>, k: string): string | null => (typeof r[k] === 'string' ? String(r[k]) : null);
export const n = (r: Record<string, unknown>, k: string): number => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? Number(r[k]) : 0);
export const nn = (r: Record<string, unknown>, k: string): number | null => (typeof r[k] === 'number' && Number.isFinite(r[k]) ? Number(r[k]) : null);
export const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isRecord) : []);

/** Admin API call (Studio or admin member session cookie). Never throws. */
export async function adminApi(url: string, init?: { method?: string; body?: unknown }): Promise<AdminResult> {
  try {
    const res = await fetch(url, {
      method: init?.method ?? 'GET',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const body: unknown = await res.json().catch(() => null);
    if (isRecord(body) && body.success === true && isRecord(body.data)) return { ok: true, data: body.data };
    const err = isRecord(body) && isRecord(body.error) ? body.error : {};
    return { ok: false, message: typeof err.message === 'string' ? err.message : `Request failed (HTTP ${res.status})` };
  } catch {
    return { ok: false, message: 'Network error' };
  }
}

export const usd = (cents: number | null) => (cents === null ? '—' : `${cents < 0 ? '−' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`);
export const vnd = (v: number | null) => (v === null ? '—' : `${v.toLocaleString('vi-VN')} ₫`);
export const when = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso)) : '—');

export const field = 'px-2.5 py-1.5 bg-stone-900 border border-stone-700 rounded-lg text-xs text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 min-w-0';
export const btn = 'px-3 py-1.5 rounded-lg text-xs font-semibold border border-stone-700 text-stone-200 hover:bg-stone-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400 disabled:opacity-50 disabled:cursor-not-allowed';
export const btnPrimary = 'px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-400 hover:bg-amber-300 text-stone-950 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-200 disabled:opacity-50 disabled:cursor-not-allowed';
export const btnDanger = `${btn} text-rose-300 border-rose-500/40`;
export const panel = 'bg-stone-900/60 border border-stone-800 rounded-2xl p-4 sm:p-6 space-y-4';
export const row = 'border border-stone-800 rounded-xl p-3 space-y-2 text-xs text-stone-300';

const TONES: Record<string, string> = {
  ok: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  wait: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
  bad: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
  mute: 'bg-stone-700/40 text-stone-300 border-stone-600',
};

export function toneOf(status: string): 'ok' | 'wait' | 'bad' | 'mute' {
  if (['approved', 'paid', 'verified', 'enabled'].includes(status)) return 'ok';
  if (['pending', 'review', 'submitted', 'draft'].includes(status)) return 'wait';
  if (['reversed', 'blocked', 'rejected', 'locked', 'cancelled'].includes(status)) return 'bad';
  return 'mute';
}

export function Pill({ status, children }: { status: string; children?: ReactNode }) {
  return <span className={`px-2 py-0.5 rounded-full border font-mono text-[10px] ${TONES[toneOf(status)]}`}>{children ?? status}</span>;
}

/** Result banner shared by every panel. */
export function Flash({ message }: { message: { kind: 'ok' | 'error'; text: string } | null }) {
  return (
    <div aria-live="polite" role="status">
      {message && (
        <p className={`text-xs rounded-lg px-3 py-2 border ${message.kind === 'ok' ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'}`}>{message.text}</p>
      )}
    </div>
  );
}

export type FlashMessage = { kind: 'ok' | 'error'; text: string } | null;
