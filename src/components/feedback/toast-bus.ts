/**
 * Cross-island toast channel. Astro islands are separate React roots, so a context provider
 * cannot reach them; any island calls `showToast` and the single mounted `<Toaster>` renders it.
 * A mounted Toaster accepts a toast by cancelling the event, so `showToast` reports whether one
 * was shown; pages without a Toaster (e.g. the standalone article page) keep their own feedback.
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

/**
 * Shows a short confirmation through the page's `<Toaster>` (announced politely to screen readers).
 * Returns true when a Toaster took it, false when none is mounted so the caller can fall back to
 * its own live region instead of announcing twice.
 */
export function showToast(message: string, tone: ToastTone = 'success'): boolean {
  if (typeof window === 'undefined' || !message.trim()) return false;
  const event = new CustomEvent<ToastDetail>(TOAST_EVENT, { detail: { message, tone }, cancelable: true });
  return !window.dispatchEvent(event);
}
