/**
 * Analytics consent: honours Do Not Track, Global Privacy Control and a local opt-out flag stored in
 * this browser. Everything degrades to "no tracking" when the browser APIs are missing or throw.
 */

export const OPT_OUT_STORAGE_KEY = 'zuey_analytics_opt_out';

export type ConsentState = 'granted' | 'opted_out' | 'do_not_track';

/** The browser surface consent reads; injectable so tests can run without a DOM. */
export interface ConsentEnvironment {
  navigator?: { doNotTrack?: string | null; globalPrivacyControl?: boolean } | null;
  windowDoNotTrack?: string | null;
  storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
}

function safeStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Reads the live browser globals (or nothing on the server). */
export function browserConsentEnvironment(): ConsentEnvironment {
  if (typeof window === 'undefined') return {};
  const win: Window & { doNotTrack?: string | null } = window;
  return {
    navigator: typeof navigator === 'undefined' ? null : navigator,
    windowDoNotTrack: win.doNotTrack ?? null,
    storage: safeStorage(),
  };
}

/** True when the browser asks not to be tracked (DNT `1`/`yes` or GPC). */
export function hasDoNotTrack(env: ConsentEnvironment): boolean {
  const nav = env.navigator;
  const dnt = nav?.doNotTrack ?? env.windowDoNotTrack ?? null;
  if (dnt === '1' || dnt === 'yes') return true;
  return nav?.globalPrivacyControl === true;
}

export function isOptedOut(env: ConsentEnvironment): boolean {
  try {
    return env.storage?.getItem(OPT_OUT_STORAGE_KEY) === '1';
  } catch {
    // Storage blocked: treat as opted out rather than tracking someone who may have opted out.
    return true;
  }
}

export function consentState(env: ConsentEnvironment = browserConsentEnvironment()): ConsentState {
  if (hasDoNotTrack(env)) return 'do_not_track';
  if (isOptedOut(env)) return 'opted_out';
  return 'granted';
}

export function canTrack(env: ConsentEnvironment = browserConsentEnvironment()): boolean {
  return consentState(env) === 'granted';
}

/** Stores the opt-out flag. Returns false when storage is unavailable (the choice cannot persist). */
export function setOptOut(optOut: boolean, env: ConsentEnvironment = browserConsentEnvironment()): boolean {
  try {
    if (!env.storage) return false;
    if (optOut) env.storage.setItem(OPT_OUT_STORAGE_KEY, '1');
    else env.storage.removeItem(OPT_OUT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
