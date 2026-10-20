/**
 * Cross-island toast channel. Astro islands are separate React roots, so a context provider
 * cannot reach them; any island calls `showToast` and the single mounted `<Toaster>` renders it.
 * Calling it with no Toaster on the page is a harmless no-op.
 */
export const TOAST_EVENT = 'zuey:toast';

export type ToastTone = 'success' | 'error' | 'info';

export interface ToastDetail {
  message: string;
  tone: ToastTone;
}

const TONES: readonly ToastTone[] = ['success', 'error', 'info'];

/** Narrows an event payload to a toast; anything else (foreign events, bad input) is ignored. */
export function parseToastDetail(value: unknown): ToastDetail | null {
  if (typeof value !== 'object' || value === null || !('message' in value)) return null;
  const message = value.message;
  if (typeof message !== 'string' || !message.trim()) return null;
  const tone = 'tone' in value ? TONES.find(t => t === value.tone) : undefined;
  return { message: message.trim(), tone: tone ?? 'info' };
}

/** Shows a short confirmation through the page's `<Toaster>` (announced politely to screen readers). */
export function showToast(message: string, tone: ToastTone = 'success'): void {
  if (typeof window === 'undefined' || !message.trim()) return;
  window.dispatchEvent(new CustomEvent<ToastDetail>(TOAST_EVENT, { detail: { message, tone } }));
}
