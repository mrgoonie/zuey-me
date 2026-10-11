/**
 * Analytics consent: honours Do Not Track, Global Privacy Control and a local opt-out flag stored in
 * this browser. Everything degrades to "no tracking" when the browser APIs are missing or throw.
 */

export const OPT_OUT_STORAGE_KEY = 'zuey_analytics_opt_out';

/** Written and removed once per page to prove the browser lets this site save a choice. */
export const STORAGE_PROBE_KEY = 'zuey_analytics_storage_probe';

/**
 * `storage_blocked`: this browser cannot save a choice for the site (localStorage refused or full), so
 * analytics stays off. Distinct from `opted_out`, which the visitor chose and can undo.
 */
export type ConsentState = 'granted' | 'opted_out' | 'do_not_track' | 'storage_blocked';

type ConsentStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The browser surface consent reads; injectable so tests can run without a DOM. */
export interface ConsentEnvironment {
  navigator?: { doNotTrack?: string | null; globalPrivacyControl?: boolean } | null;
  windowDoNotTrack?: string | null;
  storage?: ConsentStorage | null;
}

const blocked = (): never => {
  throw new Error('localStorage is blocked');
};

/**
 * Stand-in for a localStorage the browser refuses to expose (privacy mode, blocked cookies). Every call
 * throws, so consent reads as `storage_blocked` and `setOptOut` reports that the choice cannot be saved.
 */
export const BLOCKED_STORAGE: ConsentStorage = {
  getItem: blocked,
  setItem: blocked,
  removeItem: blocked,
};

/**
 * Resolves the storage consent should use. Returns null when there is none (server), and
 * `BLOCKED_STORAGE` when touching it, reading it or writing to it throws (blocked or full storage).
 */
export function resolveConsentStorage(get: () => ConsentStorage | undefined): ConsentStorage | null {
  try {
    const storage = get();
    if (!storage) return null;
    storage.getItem(OPT_OUT_STORAGE_KEY);
    storage.setItem(STORAGE_PROBE_KEY, '1');
    storage.removeItem(STORAGE_PROBE_KEY);
    return storage;
  } catch {
    return BLOCKED_STORAGE;
  }
}

// Probed once per page: the write probe would otherwise fire `storage` events in other tabs on every check.
let pageStorage: ConsentStorage | null | undefined;

function safeStorage(): ConsentStorage | null {
  if (pageStorage === undefined) {
    pageStorage = resolveConsentStorage(() => (typeof localStorage === 'undefined' ? undefined : localStorage));
  }
  return pageStorage;
}

/** Forgets the per-page probe result so the next read probes again (tests that swap browser globals). */
export function resetConsentStorageProbe(): void {
  pageStorage = undefined;
}

/**
 * Builds an environment whose storage is resolved only when first read. `consentState` checks Do Not
 * Track and Global Privacy Control before reading storage, so those visitors get no storage probe at all.
 */
export function lazyConsentEnvironment(
  nav: ConsentEnvironment['navigator'],
  windowDoNotTrack: string | null,
  storage: () => ConsentStorage | null,
): ConsentEnvironment {
  return {
    navigator: nav,
    windowDoNotTrack,
    get storage() {
      return storage();
    },
  };
}

/** Reads the live browser globals (or nothing on the server). */
export function browserConsentEnvironment(): ConsentEnvironment {
  if (typeof window === 'undefined') return {};
  const win: Window & { doNotTrack?: string | null } = window;
  return lazyConsentEnvironment(typeof navigator === 'undefined' ? null : navigator, win.doNotTrack ?? null, safeStorage);
}

/** True when the browser asks not to be tracked (DNT `1`/`yes` or GPC). */
export function hasDoNotTrack(env: ConsentEnvironment): boolean {
  const nav = env.navigator;
  const dnt = nav?.doNotTrack ?? env.windowDoNotTrack ?? null;
  if (dnt === '1' || dnt === 'yes') return true;
  return nav?.globalPrivacyControl === true;
}

function readOptOut(env: ConsentEnvironment): boolean | 'blocked' {
  try {
    return env.storage?.getItem(OPT_OUT_STORAGE_KEY) === '1';
  } catch {
    return 'blocked';
  }
}

export function consentState(env: ConsentEnvironment = browserConsentEnvironment()): ConsentState {
  if (hasDoNotTrack(env)) return 'do_not_track';
  const optOut = readOptOut(env);
  if (optOut === 'blocked') return 'storage_blocked';
  return optOut ? 'opted_out' : 'granted';
}

/** What the `/privacy` consent control shows for a state; `null` toggle means no button. */
export interface ConsentControlView {
  status: 'granted' | 'optedOut' | 'dnt' | 'storageOff';
  toggle: 'optOut' | 'optIn' | null;
}

export function consentControlView(state: ConsentState): ConsentControlView {
  switch (state) {
    case 'granted': return { status: 'granted', toggle: 'optOut' };
    case 'opted_out': return { status: 'optedOut', toggle: 'optIn' };
    case 'do_not_track': return { status: 'dnt', toggle: null };
    case 'storage_blocked': return { status: 'storageOff', toggle: null };
  }
}

export function canTrack(env: ConsentEnvironment = browserConsentEnvironment()): boolean {
  return consentState(env) === 'granted';
}

/**
 * Stores the opt-out flag. Returns false when storage is unavailable (the choice cannot persist) and,
 * without touching storage, when the browser sends Do Not Track or Global Privacy Control.
 */
export function setOptOut(optOut: boolean, env: ConsentEnvironment = browserConsentEnvironment()): boolean {
  if (hasDoNotTrack(env)) return false;
  try {
    if (!env.storage) return false;
    if (optOut) env.storage.setItem(OPT_OUT_STORAGE_KEY, '1');
    else env.storage.removeItem(OPT_OUT_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}
