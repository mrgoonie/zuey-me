/**
 * Zuey OS appearance: theme mode, accent colour and wallpaper. Stored per device in localStorage
 * and applied to <html> before first paint by LOOK_BOOT_SCRIPT (inlined in the page head).
 * Only the shell (menubar, dock, desktop, Exposé) follows the theme; documents stay paper.
 */

export type ThemeMode = 'dark' | 'light' | 'system';
export type AccentId = 'ember' | 'rose' | 'violet' | 'ocean' | 'forest' | 'amber';
export type WallpaperId = 'gradient' | 'dusk' | 'forest' | 'ocean' | 'aurora' | 'mono' | 'video' | 'image';

export interface Look {
  mode: ThemeMode;
  accent: AccentId;
  wallpaper: WallpaperId;
  /** Dim over photo and video wallpapers, 0–80 (%). */
  dim: number;
}

export const THEME_MODES: ThemeMode[] = ['dark', 'light', 'system'];
/** [accent, accent-ink (pressed / text on paper), accent-hi (text on dark glass)] */
export const ACCENTS: Record<AccentId, [string, string, string]> = {
  ember: ['#c4532a', '#a3401c', '#f2b48a'],
  rose: ['#c2416b', '#9e2c53', '#f4a7c0'],
  violet: ['#6b4fd6', '#5236b8', '#c3b4ff'],
  ocean: ['#2f7fa8', '#1f6288', '#9fd3ef'],
  forest: ['#3e8a5c', '#2b6a44', '#a8dcb9'],
  amber: ['#b8862b', '#8f6719', '#f2d08a'],
};
export const ACCENT_IDS = Object.keys(ACCENTS) as AccentId[];
export const WALLPAPERS: WallpaperId[] = ['gradient', 'dusk', 'forest', 'ocean', 'aurora', 'mono', 'video', 'image'];

export const DEFAULT_LOOK: Look = { mode: 'dark', accent: 'ember', wallpaper: 'video', dim: 35 };
export const LOOK_KEY = 'zos_look_v1';
export const WALL_IMAGE_KEY = 'zos_wall_img_v1';
/** Data URLs above this length are kept for the visit only (localStorage quota is ~5 MB of UTF-16). */
export const MAX_STORED_IMAGE = 2_400_000;

const isMode = (v: unknown): v is ThemeMode => v === 'dark' || v === 'light' || v === 'system';
const isAccent = (v: unknown): v is AccentId => typeof v === 'string' && v in ACCENTS;
const isWallpaper = (v: unknown): v is WallpaperId => typeof v === 'string' && (WALLPAPERS as string[]).includes(v);

export function parseLook(raw: unknown): Look {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_LOOK };
  const mode = 'mode' in raw && isMode(raw.mode) ? raw.mode : DEFAULT_LOOK.mode;
  const accent = 'accent' in raw && isAccent(raw.accent) ? raw.accent : DEFAULT_LOOK.accent;
  const wallpaper = 'wallpaper' in raw && isWallpaper(raw.wallpaper) ? raw.wallpaper : DEFAULT_LOOK.wallpaper;
  const dimRaw = 'dim' in raw && typeof raw.dim === 'number' && Number.isFinite(raw.dim) ? raw.dim : DEFAULT_LOOK.dim;
  return { mode, accent, wallpaper, dim: Math.max(0, Math.min(80, Math.round(dimRaw))) };
}

export function readLook(): Look {
  try {
    const raw = localStorage.getItem(LOOK_KEY);
    return parseLook(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_LOOK };
  }
}

export function writeLook(look: Look): void {
  try {
    localStorage.setItem(LOOK_KEY, JSON.stringify(look));
  } catch {
    // Storage unavailable (private window, blocked site data): the look lasts for this visit.
  }
}

export function readWallImage(): string | null {
  try {
    const v = localStorage.getItem(WALL_IMAGE_KEY);
    return v && v.startsWith('data:image/') ? v : null;
  } catch {
    return null;
  }
}

/** Returns false when the image could not be kept (too large or storage refused). */
export function writeWallImage(dataUrl: string | null): boolean {
  try {
    if (!dataUrl) {
      localStorage.removeItem(WALL_IMAGE_KEY);
      return true;
    }
    if (dataUrl.length > MAX_STORED_IMAGE) return false;
    localStorage.setItem(WALL_IMAGE_KEY, dataUrl);
    return true;
  } catch {
    return false;
  }
}

/**
 * Turns an uploaded image into a wallpaper data URL, downscaled to at most 2560 px on the long
 * side as JPEG so it usually fits in localStorage. Rejects non-images and unreadable files.
 */
export async function imageFileToWallpaper(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('not_image');
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    const scale = Math.min(1, 2560 / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('unreadable');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.84);
  } catch (err) {
    throw err instanceof Error && err.message === 'not_image' ? err : new Error('unreadable');
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function resolvedTheme(mode: ThemeMode): 'dark' | 'light' {
  if (mode !== 'system') return mode;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/** Writes the look onto <html>: data-zt (theme), data-wp (wallpaper) and the accent tokens. */
export function applyLook(look: Look, root: HTMLElement = document.documentElement): void {
  const [a, ink, hi] = ACCENTS[look.accent];
  root.dataset.zt = resolvedTheme(look.mode);
  root.dataset.wp = look.wallpaper;
  root.style.setProperty('--accent', a);
  root.style.setProperty('--accent-ink', ink);
  root.style.setProperty('--accent-hi', hi);
  root.style.setProperty('--dim', String(look.dim));
}

/**
 * Inline, dependency-free copy of readLook + applyLook for the page head, so the first paint
 * already has the visitor's theme, accent and wallpaper (no flash of the default look).
 */
export const LOOK_BOOT_SCRIPT = `(function(){try{var A=${JSON.stringify(ACCENTS)},W=${JSON.stringify(WALLPAPERS)},d=${JSON.stringify(DEFAULT_LOOK)},s={};try{s=JSON.parse(localStorage.getItem(${JSON.stringify(LOOK_KEY)})||'{}')||{}}catch(e){}var m=s.mode==='light'||s.mode==='system'||s.mode==='dark'?s.mode:d.mode,c=A[s.accent]?s.accent:d.accent,w=W.indexOf(s.wallpaper)>=0?s.wallpaper:d.wallpaper,n=typeof s.dim==='number'?Math.max(0,Math.min(80,s.dim)):d.dim,r=document.documentElement;if(m==='system')m=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';r.setAttribute('data-zt',m);r.setAttribute('data-wp',w);r.style.setProperty('--accent',A[c][0]);r.style.setProperty('--accent-ink',A[c][1]);r.style.setProperty('--accent-hi',A[c][2]);r.style.setProperty('--dim',String(n))}catch(e){}})();`;
