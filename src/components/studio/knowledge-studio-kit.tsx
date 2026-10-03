import type { ReactNode } from 'react';
import { LOCALES, isLocale } from '../../lib/i18n/locales';
import type { Locale } from '../../lib/i18n/locales';

/**
 * Shared pieces for the Studio knowledge tools (article editor, label review, taxonomy manager):
 * a JSON envelope client with typed narrowing and the small dark form controls used across Studio.
 */

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
export const str = (o: Obj, k: string): string => (typeof o[k] === 'string' ? String(o[k]) : '');
export const num = (o: Obj, k: string, fallback = 0): number => (typeof o[k] === 'number' ? Number(o[k]) : fallback);
export const strOrNull = (o: Obj, k: string): string | null => (typeof o[k] === 'string' ? String(o[k]) : null);
export const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
export const objArr = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
export const localeOr = (v: unknown, fallback: Locale): Locale => (isLocale(v) ? v : fallback);
export const localeArr = (v: unknown): Locale[] => (Array.isArray(v) ? v.filter(isLocale) : []);

/** Localized names map ({ vi: '…', en: '…' }) narrowed from unknown. */
export function namesOf(v: unknown): Partial<Record<Locale, string>> {
  if (!isObj(v)) return {};
  const out: Partial<Record<Locale, string>> = {};
  for (const l of LOCALES) if (typeof v[l] === 'string') out[l] = String(v[l]);
  return out;
}

export function displayName(names: Partial<Record<Locale, string>>, fallback: string, prefer: Locale = 'vi'): string {
  return names[prefer] || names.en || Object.values(names).find(Boolean) || fallback;
}

export interface ApiResult { ok: boolean; status: number; data: unknown; code: string; message: string; error: Obj }

/** Calls a same-origin JSON API and unwraps the { success, data | error } envelope. Never throws. */
export async function api(path: string, init: { method?: string; body?: unknown } = {}): Promise<ApiResult> {
  try {
    const hasBody = init.body !== undefined;
    const res = await fetch(path, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: hasBody ? { 'Content-Type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(init.body) : undefined,
    });
    const body: unknown = await res.json().catch(() => null);
    const error = isObj(body) && isObj(body.error) ? body.error : {};
    return {
      ok: res.ok,
      status: res.status,
      data: isObj(body) ? body.data : null,
      code: str(error, 'code'),
      message: str(error, 'message') || (res.ok ? '' : `HTTP ${res.status}`),
      error,
    };
  } catch {
    return { ok: false, status: 0, data: null, code: 'network', message: 'Không kết nối được máy chủ', error: {} };
  }
}

/** Field-level issues from a 422 envelope ({ errors: [{ path|index, message }] }). */
export function issuesFrom(error: Obj): Array<{ path: string; message: string }> {
  return objArr(error.errors).map(e => ({ path: str(e, 'path') || (typeof e.index === 'number' ? `#${e.index}` : ''), message: str(e, 'message') }));
}

export interface StatusMsg { text: string; error: boolean }

export const inputCls = 'w-full min-w-0 px-3 py-2 bg-stone-900 border border-stone-700 rounded-lg text-xs text-white placeholder-stone-500 focus:outline-none focus:border-amber-400';
export const btnCls = 'px-2.5 py-1.5 rounded-lg text-[11px] font-semibold border border-stone-700 bg-stone-900 hover:bg-stone-800 text-stone-200 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400';
export const primaryCls = 'px-3.5 py-2 rounded-xl text-xs font-bold bg-amber-400 text-stone-950 hover:bg-amber-300 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400';
export const dangerCls = `${btnCls} text-rose-300`;
export const cardCls = 'rounded-xl border border-stone-800 bg-stone-950/60 p-3 min-w-0';

export function tabCls(active: boolean): string {
  return `px-3 py-1.5 rounded-lg text-xs font-semibold ${active ? 'bg-amber-400 text-stone-950' : 'bg-stone-900 text-stone-300 border border-stone-700 hover:bg-stone-800'}`;
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="block text-[10px] uppercase tracking-widest text-stone-500 font-mono mb-1">{label}</span>
      {children}
    </label>
  );
}

export function Text({ label, value, onChange, placeholder, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return <Field label={label}><input type={type} className={inputCls} value={value} placeholder={placeholder} onChange={e => onChange(e.target.value)} /></Field>;
}

export function Area({ label, value, onChange, rows = 3, mono }: { label: string; value: string; onChange: (v: string) => void; rows?: number; mono?: boolean }) {
  return <Field label={label}><textarea className={`${inputCls} ${mono ? 'font-mono' : ''}`} rows={rows} value={value} onChange={e => onChange(e.target.value)} /></Field>;
}

export function Select<T extends string>({ label, value, options, onChange, labels }: {
  label: string; value: T; options: readonly T[]; onChange: (v: T) => void; labels?: Partial<Record<T, string>>;
}) {
  return (
    <Field label={label}>
      <select className={inputCls} value={value} onChange={e => { const v = options.find(o => o === e.target.value); if (v !== undefined) onChange(v); }}>
        {options.map(o => <option key={o} value={o}>{labels?.[o] ?? o}</option>)}
      </select>
    </Field>
  );
}

export function StatusLine({ status }: { status: StatusMsg | null }) {
  if (!status) return null;
  return <span className={`text-xs ${status.error ? 'text-rose-400' : 'text-emerald-400'}`} role={status.error ? 'alert' : 'status'}>{status.text}</span>;
}

/** Inputs for one localized name per site locale. */
export function NamesFields({ value, onChange, max = 60 }: { value: Partial<Record<Locale, string>>; onChange: (v: Partial<Record<Locale, string>>) => void; max?: number }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
      {LOCALES.map(l => (
        <Field key={l} label={`Tên ${l}`}>
          <input className={inputCls} maxLength={max} value={value[l] ?? ''} onChange={e => onChange({ ...value, [l]: e.target.value })} />
        </Field>
      ))}
    </div>
  );
}

/** Drops empty locales so the API receives only real names. */
export function compactNames(names: Partial<Record<Locale, string>>): Partial<Record<Locale, string>> {
  const out: Partial<Record<Locale, string>> = {};
  for (const l of LOCALES) {
    const v = names[l]?.trim();
    if (v) out[l] = v;
  }
  return out;
}

export function formatTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('vi-VN', { timeZone: 'Asia/Saigon', dateStyle: 'short', timeStyle: 'short' });
}
