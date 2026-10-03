/** Typed view of public/mascot/manifest.json (see docs/mascot-provenance.md). */

export interface SpriteFrame {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  durationMs: number;
}

export interface SpriteAnimation {
  loop: boolean;
  frames: SpriteFrame[];
  reducedMotionFrame: SpriteFrame;
}

export interface MascotManifest {
  imageWebp: string;
  imagePng: string;
  width: number;
  height: number;
  cell: number;
  walkFacing: 'right' | 'left';
  animations: Record<string, SpriteAnimation>;
  /** UI state → animation name (idle, walking, wave, talking, thinking, happy, surprised). */
  expressions: Record<string, string>;
}

/** Weather scene → expression, as recorded in the mascot provenance (sun → happy, rain → thinking, snow → surprised). */
export const WEATHER_EXPRESSION: Record<string, string> = {
  clear: 'happy',
  rain: 'thinking',
  storm: 'thinking',
  snow: 'surprised',
  clouds: 'idle',
  fog: 'idle',
};

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? Object.fromEntries(Object.entries(v)) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function frameOf(v: unknown, fallbackDuration = 200): SpriteFrame | null {
  const r = rec(v);
  if (!r) return null;
  const x = num(r.x);
  const y = num(r.y);
  const w = num(r.w);
  const h = num(r.h);
  if (x === null || y === null || w === null || h === null || w <= 0 || h <= 0) return null;
  return { name: typeof r.name === 'string' ? r.name : '', x, y, w, h, durationMs: Math.max(40, num(r.durationMs) ?? fallbackDuration) };
}

/** Validates the manifest; returns null when it is unusable (the mascot then stays hidden). */
export function parseMascotManifest(raw: unknown, baseUrl = '/mascot/'): MascotManifest | null {
  const root = rec(raw);
  const image = rec(root?.image);
  const cell = rec(root?.cell);
  const frames = rec(root?.frames);
  const animations = rec(root?.animations);
  const expressions = rec(root?.expressions);
  if (!root || !image || !cell || !frames || !animations || !expressions) return null;
  const width = num(image.width);
  const height = num(image.height);
  const cellW = num(cell.width);
  if (!width || !height || !cellW || typeof image.webp !== 'string' || typeof image.png !== 'string') return null;

  const parsed: Record<string, SpriteAnimation> = {};
  for (const [name, value] of Object.entries(animations)) {
    const a = rec(value);
    if (!a || !Array.isArray(a.frames)) continue;
    const list = a.frames.map(f => frameOf(f)).filter((f): f is SpriteFrame => f !== null);
    if (list.length === 0) continue;
    const reducedName = typeof a.reducedMotionFrame === 'string' ? a.reducedMotionFrame : '';
    const reduced = frameOf({ ...rec(frames[reducedName]), name: reducedName }) ?? list[0];
    parsed[name] = { loop: a.loop === true, frames: list, reducedMotionFrame: reduced };
  }
  if (!parsed.idle) return null;

  const exprs: Record<string, string> = {};
  for (const [state, anim] of Object.entries(expressions)) {
    if (typeof anim === 'string' && parsed[anim]) exprs[state] = anim;
  }
  const facing = rec(root.facing);
  return {
    imageWebp: `${baseUrl}${image.webp}`,
    imagePng: `${baseUrl}${image.png}`,
    width,
    height,
    cell: cellW,
    walkFacing: facing?.walk === 'left' ? 'left' : 'right',
    animations: parsed,
    expressions: exprs,
  };
}

/** CSS background-position for a frame inside the atlas (percent-based so any rendered size works). */
export function framePosition(frame: SpriteFrame, m: Pick<MascotManifest, 'width' | 'height'>): string {
  const px = m.width === frame.w ? 0 : (frame.x / (m.width - frame.w)) * 100;
  const py = m.height === frame.h ? 0 : (frame.y / (m.height - frame.h)) * 100;
  return `${px}% ${py}%`;
}
