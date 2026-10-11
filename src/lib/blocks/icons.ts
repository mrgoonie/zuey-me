/**
 * Curated icon allowlist shared by the validator, the renderer, the Studio picker, REST and MCP.
 * Names are Lucide's kebab-case names (https://lucide.dev/icons), so they stay stable and documented.
 * Only names listed here can be stored in a document; the renderer maps each one to an individually
 * imported component (see src/components/blocks/block-icons.tsx), so no icon is ever fetched or built
 * from untrusted strings. Brand logos are not part of this set (see src/components/BrandIcons.tsx).
 */

export const ICON_GROUPS = {
  arrows: [
    'arrow-right', 'arrow-left', 'arrow-up', 'arrow-down', 'arrow-up-right', 'chevron-right', 'chevron-down',
    'refresh-cw', 'repeat', 'external-link',
  ],
  status: [
    'check', 'x', 'circle-check', 'circle-x', 'circle-alert', 'triangle-alert', 'info', 'circle-help', 'ban',
    'shield-check', 'badge-check', 'clock', 'hourglass', 'bell', 'flag', 'thumbs-up', 'thumbs-down', 'star', 'heart',
    'sparkles', 'zap', 'flame', 'award', 'trophy', 'target',
  ],
  objects: [
    'book', 'book-open', 'bookmark', 'file', 'file-text', 'folder', 'image', 'camera', 'video', 'music', 'mic',
    'headphones', 'calendar', 'map', 'map-pin', 'globe', 'house', 'key', 'lock', 'lock-open', 'gift', 'package',
    'shopping-cart', 'tag', 'paperclip', 'pencil', 'wrench', 'settings', 'search', 'funnel', 'eye', 'link', 'mail',
    'phone', 'send', 'sun', 'moon', 'cloud', 'compass', 'rocket', 'lightbulb', 'puzzle', 'layers',
  ],
  tech: [
    'code', 'terminal', 'cpu', 'database', 'server', 'wifi', 'smartphone', 'laptop', 'monitor', 'bot', 'brain',
    'git-branch', 'bug', 'braces', 'keyboard',
  ],
  learning: [
    'graduation-cap', 'school', 'notebook-pen', 'library', 'presentation', 'calculator', 'flask-conical', 'atom',
    'microscope', 'languages', 'quote', 'list-checks', 'clipboard-list',
  ],
  business: [
    'briefcase', 'building-2', 'chart-column', 'chart-line', 'chart-pie', 'trending-up', 'trending-down',
    'dollar-sign', 'wallet', 'credit-card', 'handshake', 'users', 'user', 'megaphone',
  ],
  social: ['share-2', 'message-circle', 'message-square', 'at-sign', 'hash', 'rss', 'smile'],
} as const;

export type IconGroup = keyof typeof ICON_GROUPS;
export const ICON_GROUP_NAMES: readonly IconGroup[] = ['arrows', 'status', 'objects', 'tech', 'learning', 'business', 'social'];
export type IconName = (typeof ICON_GROUPS)[IconGroup][number];

export const ICON_NAMES: readonly IconName[] = Object.values(ICON_GROUPS).flat();

/** Friendly synonyms accepted on input; validation stores the canonical name. */
export const ICON_ALIASES: Readonly<Record<string, IconName>> = {
  'alert': 'circle-alert',
  'warning': 'triangle-alert',
  'error': 'circle-x',
  'success': 'circle-check',
  'tick': 'check',
  'close': 'x',
  'help': 'circle-help',
  'question': 'circle-help',
  'home': 'house',
  'unlock': 'lock-open',
  'filter': 'funnel',
  'gear': 'settings',
  'idea': 'lightbulb',
  'launch': 'rocket',
  'ai': 'sparkles',
  'time': 'clock',
  'location': 'map-pin',
  'email': 'mail',
  'chat': 'message-circle',
  'team': 'users',
  'money': 'dollar-sign',
  'chart': 'chart-column',
  'education': 'graduation-cap',
  'share': 'share-2',
};

export const ICON_SIZES = ['sm', 'md', 'lg', 'xl'] as const;
export type IconSize = (typeof ICON_SIZES)[number];
/** Rendered pixel size per semantic size. */
export const ICON_PIXELS: Readonly<Record<IconSize, number>> = { sm: 16, md: 24, lg: 32, xl: 48 };

export const ICON_TONES = ['default', 'muted', 'accent', 'success', 'warning', 'danger'] as const;
export type IconTone = (typeof ICON_TONES)[number];

export const ICON_ALIGNS = ['start', 'center', 'end'] as const;
export type IconAlign = (typeof ICON_ALIGNS)[number];

const CANONICAL: ReadonlySet<string> = new Set(ICON_NAMES);
const ALIAS_MAP: ReadonlyMap<string, IconName> = new Map(Object.entries(ICON_ALIASES));

export function isIconName(value: unknown): value is IconName {
  return typeof value === 'string' && CANONICAL.has(value);
}

/** Canonical icon name for a name or alias (case-insensitive), or null when it is not in the allowlist. */
export function resolveIconName(value: unknown): IconName | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (isIconName(key)) return key;
  return ALIAS_MAP.get(key) ?? null;
}

/** Group of a canonical icon name (used for picker search). */
export function iconGroup(name: IconName): IconGroup {
  return ICON_GROUP_NAMES.find(group => ICON_GROUPS[group].some(n => n === name)) ?? 'objects';
}

/** Aliases pointing at each canonical name (used for picker search). */
export function iconAliases(name: IconName): string[] {
  return Object.entries(ICON_ALIASES).filter(([, target]) => target === name).map(([alias]) => alias);
}

/** Allowlist summary for agents (MCP block_schema) and docs. */
export function iconCatalog() {
  return {
    names: ICON_NAMES,
    groups: ICON_GROUPS,
    aliases: ICON_ALIASES,
    sizes: ICON_SIZES,
    tones: ICON_TONES,
    aligns: ICON_ALIGNS,
    source: 'Lucide (ISC), https://lucide.dev/icons',
  };
}
