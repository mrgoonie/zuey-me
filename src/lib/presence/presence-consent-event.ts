/**
 * Same-tab signal that the visitor changed their analytics choice. localStorage `storage` events only
 * reach other tabs, so the /privacy consent control dispatches this after opting out or in, and the
 * presence beacon stops (or may start) at once.
 */
export const PRESENCE_CONSENT_EVENT = 'zuey:consent-change';

export interface PresenceConsentDetail {
  /** False whenever the visitor may no longer be counted, even if storage could not keep the choice. */
  granted: boolean;
}

export function dispatchPresenceConsent(granted: boolean): void {
  try {
    if (typeof window === 'undefined') return;
    const detail: PresenceConsentDetail = { granted };
    window.dispatchEvent(new CustomEvent(PRESENCE_CONSENT_EVENT, { detail }));
  } catch {
    // A consent toggle must never fail because of presence.
  }
}

/** Reads `granted` from a consent event; null for anything that is not one. */
export function presenceConsentFrom(ev: Event): boolean | null {
  if (!('detail' in ev)) return null;
  const detail: unknown = ev.detail;
  if (typeof detail !== 'object' || detail === null || !('granted' in detail) || typeof detail.granted !== 'boolean') return null;
  return detail.granted;
}
