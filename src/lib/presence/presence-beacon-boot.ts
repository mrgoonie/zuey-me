/**
 * Wires the presence beacon to the real browser. Loaded lazily from the site layout after the page is
 * idle. Runs only on the production hostnames, or anywhere when PUBLIC_ANALYTICS_DEBUG is set (the
 * layout's `zuey-presence` meta carries it), so localhost and previews never inflate live counts.
 */
import { PRODUCTION_HOSTNAMES } from '../analytics/constants';
import { canTrack } from '../analytics/consent';
import { createPresenceBeacon, type PresenceBeacon, type PresenceSocket, type PresenceSocketHandlers } from './presence-beacon';

export const PRESENCE_CONFIG_ELEMENT_ID = 'zuey-presence';

function base64UrlId(bytes: number): string {
  let bin = '';
  for (const b of crypto.getRandomValues(new Uint8Array(bytes))) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function safeLocalStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function safeSessionStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** The ticket rides in `protocols` (Sec-WebSocket-Protocol), never in the URL. */
function openBrowserSocket(url: string, protocols: string[], handlers: PresenceSocketHandlers): PresenceSocket {
  const ws = new WebSocket(url, protocols);
  ws.addEventListener('open', () => handlers.onOpen());
  ws.addEventListener('close', () => handlers.onClose());
  return {
    send(data) {
      if (ws.readyState !== WebSocket.OPEN) return false;
      ws.send(data);
      return true;
    },
    close() {
      ws.close(1000);
    },
  };
}

/** True when the beacon may run on this host. */
export function presenceAllowedOn(hostname: string, debug: boolean): boolean {
  return debug || PRODUCTION_HOSTNAMES.includes(hostname.toLowerCase());
}

let beacon: PresenceBeacon | null = null;

/** Starts the site-wide beacon once per page. Never throws. */
export function startPresenceBeacon(): void {
  try {
    if (typeof window === 'undefined' || typeof WebSocket === 'undefined' || beacon) return;
    const debug = document.getElementById(PRESENCE_CONFIG_ELEMENT_ID)?.getAttribute('data-debug') === '1';
    if (!presenceAllowedOn(window.location.hostname, debug)) return;
    beacon = createPresenceBeacon({
      consentGranted: () => canTrack(),
      storage: safeLocalStorage,
      sessionStorage: safeSessionStorage,
      fetch: (url, init) => fetch(url, init),
      openSocket: openBrowserSocket,
      win: window,
      doc: document,
      visible: () => document.visibilityState === 'visible',
      location: () => ({ pathname: window.location.pathname, hash: window.location.hash }),
      now: () => Date.now(),
      random: () => Math.random(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: handle => window.clearTimeout(typeof handle === 'number' ? handle : undefined),
      setTicker: (fn, ms) => window.setInterval(fn, ms),
      clearTicker: handle => window.clearInterval(typeof handle === 'number' ? handle : undefined),
      randomId: () => base64UrlId(18),
      debug: message => {
        if (debug) console.debug(message);
      },
    });
    beacon.start();
  } catch {
    // Presence is optional: a browser without WebSocket or crypto simply is not counted.
  }
}
