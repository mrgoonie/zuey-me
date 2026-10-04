/**
 * Zuey OS applications: every window the desktop can open. `slot` apps host a panel the page
 * renders (Astro named slot, its own island); `shell` apps are rendered by the OS island itself.
 */

export type AppId =
  | 'about' | 'ai' | 'knowledges' | 'reads' | 'github'
  | 'pricing' | 'business' | 'mcp' | 'account' | 'appearance';

export type SlotAppId = 'ai' | 'knowledges' | 'reads' | 'pricing' | 'business' | 'account';

export interface Rect { x: number; y: number; w: number; h: number }

export interface AppDef {
  id: AppId;
  /** `paper`: light document surface; `stage`: dark stage hosting a full page panel; `glass`: follows the theme. */
  surface: 'paper' | 'stage' | 'glass';
  /** Standalone route with the same content (deep links, payment redirects, SEO). */
  href: string;
  /** Default size for a work area of `aw` × `ah` pixels. */
  size: (aw: number, ah: number) => { w: number; h: number };
  min: { w: number; h: number };
}

const clampTo = (v: number, max: number) => Math.min(v, max);

export const APPS: Record<AppId, AppDef> = {
  about: { id: 'about', surface: 'paper', href: '/#about', size: (_, h) => ({ w: 500, h: clampTo(720, h - 16) }), min: { w: 340, h: 360 } },
  ai: { id: 'ai', surface: 'glass', href: '/chat', size: (w, h) => ({ w: clampTo(860, w - 40), h: clampTo(680, h - 16) }), min: { w: 360, h: 420 } },
  knowledges: { id: 'knowledges', surface: 'paper', href: '/articles', size: (_, h) => ({ w: 600, h: clampTo(700, h - 16) }), min: { w: 340, h: 360 } },
  reads: { id: 'reads', surface: 'stage', href: '/reads', size: (w, h) => ({ w: clampTo(880, w - 40), h: clampTo(680, h - 16) }), min: { w: 360, h: 360 } },
  github: { id: 'github', surface: 'paper', href: '/#github', size: (w, h) => ({ w: clampTo(860, w - 40), h: clampTo(640, h - 16) }), min: { w: 360, h: 320 } },
  pricing: { id: 'pricing', surface: 'stage', href: '/pricing', size: (w, h) => ({ w: clampTo(1080, w - 40), h: clampTo(720, h - 16) }), min: { w: 360, h: 400 } },
  business: { id: 'business', surface: 'stage', href: '/business', size: (w, h) => ({ w: clampTo(720, w - 40), h: clampTo(720, h - 16) }), min: { w: 360, h: 400 } },
  mcp: { id: 'mcp', surface: 'paper', href: '/docs', size: (_, h) => ({ w: 560, h: clampTo(560, h - 16) }), min: { w: 340, h: 320 } },
  account: { id: 'account', surface: 'stage', href: '/account', size: (w, h) => ({ w: clampTo(760, w - 40), h: clampTo(720, h - 16) }), min: { w: 360, h: 400 } },
  appearance: { id: 'appearance', surface: 'glass', href: '/#appearance', size: (_, h) => ({ w: 560, h: clampTo(640, h - 16) }), min: { w: 340, h: 360 } },
};

export const APP_IDS = Object.keys(APPS) as AppId[];
/** Dock order (Alt+1…9 follow it). Appearance lives in the menu and the dock's right side. */
export const DOCK_APPS: AppId[] = ['about', 'ai', 'knowledges', 'reads', 'github', 'pricing', 'business', 'mcp', 'account'];
export const SLOT_APPS: SlotAppId[] = ['ai', 'knowledges', 'reads', 'pricing', 'business', 'account'];

export const isAppId = (v: unknown): v is AppId => typeof v === 'string' && (APP_IDS as string[]).includes(v);

/** URL hash → app (legacy `#profile` opens About, `#activity` opens GitHub). */
export function appFromHash(hash: string): AppId | null {
  const h = hash.replace(/^#/, '');
  if (h === 'profile') return 'about';
  if (h === 'activity') return 'github';
  return isAppId(h) ? h : null;
}
