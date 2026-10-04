import { APPS, isAppId, type AppId, type Rect } from './apps';

/** Window placement modes: free, zoomed to the work area, or snapped to one half. */
export type WinMode = 'normal' | 'max' | 'left' | 'right';

export interface WinState {
  /** Mounted at least once: slot panels stay mounted (hidden) so their islands keep state. */
  mounted: boolean;
  open: boolean;
  min: boolean;
  z: number;
  mode: WinMode;
  /** Free-mode rect (also restored after un-zooming); null until measured on the client. */
  rect: Rect | null;
}

export type WinMap = Record<AppId, WinState>;

/** Work area inside the screen layer: w × h, `b` = lowest y a window may reach (above the dock). */
export interface Area { w: number; h: number; b: number }

export const GAP = 8;
export const LAYOUT_KEY = 'zos_wins_v1';
export const OPEN_KEY = 'zos_open_v1';
/** Windows open on a fresh desktop (and in the server-rendered HTML). */
export const BOOT_APPS: AppId[] = ['about', 'ai'];

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));

export function initialWins(open: AppId[] = BOOT_APPS): WinMap {
  const map = {} as WinMap;
  for (const id of Object.keys(APPS) as AppId[]) {
    const idx = open.indexOf(id);
    map[id] = { mounted: idx >= 0, open: idx >= 0, min: false, z: idx >= 0 ? idx + 1 : 0, mode: 'normal', rect: null };
  }
  return map;
}

/** Keeps a rect fully inside the work area, never below the app minimum unless the screen is. */
export function fitRect(r: Rect, id: AppId, a: Area): Rect {
  const m = APPS[id].min;
  const maxW = a.w - 2 * GAP;
  const maxH = a.b - GAP;
  const w = Math.round(clamp(r.w, Math.min(m.w, maxW), maxW));
  const h = Math.round(clamp(r.h, Math.min(m.h, maxH), maxH));
  return {
    w,
    h,
    x: Math.round(clamp(r.x, GAP, a.w - w - GAP)),
    y: Math.round(clamp(r.y, GAP, a.b - h)),
  };
}

export function modeRect(mode: Exclude<WinMode, 'normal'>, a: Area): Rect {
  const half = Math.round((a.w - 3 * GAP) / 2);
  const h = a.b - GAP;
  if (mode === 'left') return { x: GAP, y: GAP, w: half, h };
  if (mode === 'right') return { x: a.w - GAP - half, y: GAP, w: half, h };
  return { x: GAP, y: GAP, w: a.w - 2 * GAP, h };
}

/** Where a window sits for its mode. */
export function placedRect(win: WinState, id: AppId, a: Area): Rect {
  if (win.mode !== 'normal') return modeRect(win.mode, a);
  return fitRect(win.rect ?? defaultRect(id, 0, a), id, a);
}

/**
 * Default placement. About and Zuey AI open side by side (matching the pre-hydration CSS in
 * os.css: About at the left edge, AI filling the space to its right); others cascade centred.
 */
export function defaultRect(id: AppId, index: number, a: Area): Rect {
  const aboutW = Math.round(Math.min(500, a.w * 0.4));
  const h = a.b - 2 * GAP;
  if (id === 'about') return fitRect({ x: 3 * GAP, y: GAP, w: aboutW, h }, id, a);
  if (id === 'ai') {
    const x = 3 * GAP + aboutW + 2 * GAP;
    return fitRect({ x, y: GAP, w: Math.min(900, a.w - x - 3 * GAP), h }, id, a);
  }
  const size = APPS[id].size(a.w, a.b);
  return fitRect({ x: Math.round((a.w - size.w) / 2) + index * 26, y: 3 * GAP + index * 24, w: size.w, h: size.h }, id, a);
}

/* ---------- persistence (every access guarded: private windows may refuse storage) ---------- */

interface SavedLayout { rect: Rect; mode: WinMode }

const isRect = (v: unknown): v is Rect =>
  typeof v === 'object' && v !== null &&
  'x' in v && 'y' in v && 'w' in v && 'h' in v &&
  [v.x, v.y, v.w, v.h].every(n => typeof n === 'number' && Number.isFinite(n));
const isMode = (v: unknown): v is WinMode => v === 'normal' || v === 'max' || v === 'left' || v === 'right';

export function readLayout(): Partial<Record<AppId, SavedLayout>> {
  const out: Partial<Record<AppId, SavedLayout>> = {};
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}');
    if (typeof raw !== 'object' || raw === null) return out;
    for (const [id, v] of Object.entries(raw)) {
      if (!isAppId(id) || typeof v !== 'object' || v === null) continue;
      const rect = 'rect' in v ? v.rect : null;
      const mode = 'mode' in v ? v.mode : 'normal';
      if (isRect(rect)) out[id] = { rect, mode: isMode(mode) ? mode : 'normal' };
    }
  } catch {
    // Unreadable layout: start from defaults.
  }
  return out;
}

export function writeLayout(wins: WinMap): void {
  const out: Partial<Record<AppId, SavedLayout>> = {};
  for (const [id, w] of Object.entries(wins)) if (isAppId(id) && w.rect) out[id] = { rect: w.rect, mode: w.mode };
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(out));
  } catch {
    // Storage unavailable: layout lasts for this visit.
  }
}

export function readOpen(): AppId[] | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'null');
    return Array.isArray(raw) ? raw.filter(isAppId) : null;
  } catch {
    return null;
  }
}

export function writeOpen(wins: WinMap): void {
  const ids = (Object.keys(wins) as AppId[]).filter(id => wins[id].open && !wins[id].min && id !== 'appearance');
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(ids));
  } catch {
    // Storage unavailable.
  }
}

/* ---------- reducer ---------- */

export type WinAction =
  | { type: 'open'; id: AppId }
  | { type: 'close'; id: AppId }
  | { type: 'minimize'; id: AppId }
  | { type: 'focus'; id: AppId }
  | { type: 'mode'; id: AppId; mode: WinMode }
  | { type: 'rect'; id: AppId; rect: Rect; mode?: WinMode }
  | { type: 'restore'; open: AppId[]; layout: Partial<Record<AppId, SavedLayout>> }
  | { type: 'closeAll' }
  | { type: 'arrange'; area: Area };

const topZ = (wins: WinMap) => Math.max(0, ...Object.values(wins).map(w => w.z));

export function winReducer(wins: WinMap, action: WinAction): WinMap {
  switch (action.type) {
    case 'open':
      return { ...wins, [action.id]: { ...wins[action.id], mounted: true, open: true, min: false, z: topZ(wins) + 1 } };
    case 'close':
      return { ...wins, [action.id]: { ...wins[action.id], open: false, min: false } };
    case 'minimize':
      return { ...wins, [action.id]: { ...wins[action.id], min: true } };
    case 'focus':
      if (wins[action.id].z === topZ(wins)) return wins;
      return { ...wins, [action.id]: { ...wins[action.id], z: topZ(wins) + 1 } };
    case 'mode':
      return { ...wins, [action.id]: { ...wins[action.id], mode: action.mode } };
    case 'rect':
      return { ...wins, [action.id]: { ...wins[action.id], rect: action.rect, mode: action.mode ?? 'normal' } };
    case 'restore': {
      const next = { ...wins };
      for (const id of Object.keys(next) as AppId[]) {
        const saved = action.layout[id];
        const idx = action.open.indexOf(id);
        next[id] = {
          ...next[id],
          mounted: next[id].mounted || idx >= 0,
          open: idx >= 0,
          min: false,
          z: idx >= 0 ? idx + 1 : 0,
          rect: saved?.rect ?? next[id].rect,
          mode: saved?.mode ?? next[id].mode,
        };
      }
      return next;
    }
    case 'closeAll': {
      const next = { ...wins };
      for (const id of Object.keys(next) as AppId[]) next[id] = { ...next[id], open: false, min: false };
      return next;
    }
    case 'arrange': {
      const next = { ...wins };
      const visible = (Object.keys(next) as AppId[]).filter(id => next[id].open && !next[id].min).sort((p, q) => next[p].z - next[q].z);
      visible.forEach((id, i) => { next[id] = { ...next[id], mode: 'normal', rect: defaultRect(id, i, action.area) }; });
      return next;
    }
  }
}

/** Visible (open, not minimized) windows, back to front. */
export function visibleIds(wins: WinMap): AppId[] {
  return (Object.keys(wins) as AppId[]).filter(id => wins[id].open && !wins[id].min).sort((p, q) => wins[p].z - wins[q].z);
}

export function topId(wins: WinMap): AppId | null {
  const v = visibleIds(wins);
  return v.length ? v[v.length - 1] : null;
}

/* ---------- Exposé grid ---------- */

export interface ExpoSlot { s: number; cx: number; cy: number; cw: number }

/** Picks the column count that shows the windows largest, then centres each row. */
export function expoLayout(rects: Rect[], a: Area): { cols: number; slots: ExpoSlot[] } {
  const pad = 28, lbl = 36, top = 54, bot = 16, n = rects.length;
  const AW = a.w - pad * 2, AH = a.b - top - bot;
  let best: { cols: number; rows: number; cw: number; ch: number; sc: number[]; score: number } | null = null;
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const cw = (AW - pad * (cols - 1)) / cols;
    const ch = (AH - pad * (rows - 1)) / rows - lbl;
    if (cw < 60 || ch < 40) continue;
    const sc = rects.map(r => Math.min(cw / r.w, ch / r.h, 0.86));
    const score = sc.reduce((t, s, i) => t + s * s * rects[i].w * rects[i].h, 0);
    if (!best || score > best.score * 1.02) best = { cols, rows, cw, ch, sc, score };
  }
  const b = best ?? { cols: n, rows: 1, cw: 60, ch: 40, sc: rects.map(r => Math.min(60 / r.w, 40 / r.h)), score: 0 };
  const gridH = b.rows * (b.ch + lbl) + (b.rows - 1) * pad;
  const y0 = top + Math.max(0, (AH - gridH) / 2);
  return {
    cols: b.cols,
    slots: rects.map((_, i) => {
      const row = Math.floor(i / b.cols), col = i % b.cols;
      const inRow = row === b.rows - 1 ? n - row * b.cols : b.cols;
      const x0 = pad + (AW - (inRow * b.cw + (inRow - 1) * pad)) / 2;
      return { s: b.sc[i], cx: x0 + col * (b.cw + pad) + b.cw / 2, cy: y0 + row * (b.ch + lbl + pad) + b.ch / 2, cw: b.cw };
    }),
  };
}
