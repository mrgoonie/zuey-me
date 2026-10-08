import type { ArticleOgCard } from './article-og-card';
import { OG_HEIGHT, OG_WIDTH } from './article-og-card';
import { OG_SANS, OG_SANS_CJK, OG_SERIF, OG_SERIF_CJK } from './og-fonts';

/**
 * Article share card (1200×630) drawn with the site's design tokens: the ivory reading card
 * (#F5EFEB, as on /articles/[slug]) floating on the plum night background of the profile OG image,
 * Fraunces headings, Plus Jakarta Sans text and the amber Knowledges badge.
 */
const TOKENS = {
  plum950: '#1D111B',
  plum900: '#2E1C2B',
  plum800: '#3A2434',
  ivory: '#F5EFEB',
  ivoryEdge: '#EDE4DC',
  stone950: '#0C0A09',
  stone900: '#1C1917',
  stone600: '#57534E',
  stone500: '#78716C',
  amber300: '#FCD34D',
  amber400: '#FBBF24',
  coral: '#FF6B4A',
  violet: '#A855F7',
};

/** Satori accepts React-element-shaped objects; this keeps the template free of a JSX build step. */
export interface OgNode {
  type: string;
  props: Record<string, unknown> & { style?: Record<string, unknown>; children?: unknown };
}

function el(type: string, style: Record<string, unknown>, children?: unknown, extra: Record<string, unknown> = {}): OgNode {
  return { type, props: { style, children, ...extra } };
}

const CJK_RE = /[぀-ヿ㐀-鿿가-힯]/;

/** Long titles shrink so up to three lines always fit; CJK glyphs are wider, so they shrink sooner. */
export function titleFontSize(title: string): number {
  const units = Array.from(title).reduce((n, ch) => n + (CJK_RE.test(ch) ? 1.9 : 1), 0);
  if (units <= 32) return 76;
  if (units <= 56) return 64;
  if (units <= 84) return 54;
  if (units <= 120) return 46;
  return 40;
}

function pill(text: string, tone: 'dark' | 'light'): OgNode {
  const dark = tone === 'dark';
  return el('div', {
    display: 'flex',
    alignItems: 'center',
    padding: '8px 18px',
    borderRadius: 999,
    fontSize: 20,
    fontWeight: 700,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: dark ? TOKENS.amber300 : TOKENS.stone600,
    backgroundColor: dark ? TOKENS.stone900 : 'rgba(255,255,255,0.7)',
    border: dark ? 'none' : `1.5px solid ${TOKENS.ivoryEdge}`,
  }, text);
}

function tagChip(text: string): OgNode {
  return el('div', {
    display: 'flex',
    padding: '7px 16px',
    borderRadius: 999,
    fontSize: 20,
    fontWeight: 700,
    color: TOKENS.stone900,
    backgroundColor: '#FFFFFF',
    border: `1.5px solid ${TOKENS.ivoryEdge}`,
  }, `#${text}`);
}

/**
 * Text block clamped to `lines`. Korean separates words with spaces and must not break inside them,
 * but satori 0.32 ignores `word-break: keep-all` for Hangul, so each Korean word becomes its own
 * box in a wrapping row (lines then break only between words) and the height cap does the clamping.
 */
function clampedText(text: string, locale: ArticleOgCard['locale'], style: Record<string, unknown>, lines: number): OgNode {
  if (locale !== 'ko') return el('div', { ...style, display: 'block', lineClamp: lines }, text);
  const fontSize = Number(style.fontSize);
  const lineHeight = Number(style.lineHeight);
  const words = text.split(/\s+/).filter(Boolean).map(word => el('div', { display: 'flex' }, word));
  return el('div', {
    ...style,
    display: 'flex',
    flexWrap: 'wrap',
    columnGap: Math.round(fontSize * 0.28),
    maxHeight: Math.floor(fontSize * lineHeight * lines),
    overflow: 'hidden',
  }, words);
}

/** Builds the satori element tree for one card. `avatarUrl` is drawn inside the amber ring. */
export function articleOgTemplate(card: ArticleOgCard, avatarUrl: string): OgNode {
  const badges: OgNode[] = [];
  if (card.membersBadge) badges.push(pill(`★ ${card.membersBadge}`, 'dark'));
  if (card.category) badges.push(pill(card.category, 'light'));
  if (card.readingTime) badges.push(pill(card.readingTime, 'light'));

  const header = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }, [
    el('div', { display: 'flex', gap: 12, alignItems: 'center' }, badges),
    el('div', { display: 'flex', alignItems: 'center', gap: 10, fontSize: 22, fontWeight: 700, color: TOKENS.stone500 }, [
      el('div', { display: 'flex', width: 12, height: 12, borderRadius: 999, backgroundColor: TOKENS.coral }),
      card.sectionTitle,
    ]),
  ]);

  const titleSize = titleFontSize(card.title);
  const body = el('div', { display: 'flex', flexDirection: 'column', gap: 22, width: '100%' }, [
    clampedText(card.title, card.locale, {
      fontFamily: `"${OG_SERIF}", "${OG_SERIF_CJK}"`,
      fontWeight: 800,
      fontSize: titleSize,
      lineHeight: 1.08,
      letterSpacing: '-0.02em',
      color: TOKENS.stone950,
    }, 3),
    ...(card.excerpt ? [clampedText(card.excerpt, card.locale, {
      fontSize: 27,
      lineHeight: 1.4,
      color: TOKENS.stone600,
    }, 2)] : []),
  ]);

  const author = el('div', { display: 'flex', alignItems: 'center', gap: 18 }, [
    el('div', {
      display: 'flex',
      width: 72,
      height: 72,
      borderRadius: 999,
      padding: 3,
      backgroundColor: TOKENS.amber400,
    }, [el('img', { width: 66, height: 66, borderRadius: 999 }, undefined, { src: avatarUrl, width: 66, height: 66 })]),
    el('div', { display: 'flex', flexDirection: 'column', gap: 2 }, [
      el('div', { display: 'flex', fontSize: 26, fontWeight: 700, color: TOKENS.stone950 }, 'Duy Nguyen /zuey/'),
      el('div', { display: 'flex', fontSize: 21, fontWeight: 700, color: TOKENS.stone500 }, 'zuey.me/articles'),
    ]),
  ]);

  const footer = el('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }, [
    author,
    el('div', { display: 'flex', gap: 10 }, card.tags.map(tagChip)),
  ]);

  const ivoryCard = el('div', {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'space-between',
    position: 'relative',
    width: '100%',
    height: '100%',
    padding: '48px 60px 44px',
    borderRadius: 40,
    overflow: 'hidden',
    backgroundColor: TOKENS.ivory,
    // Warm amber corner light. Linear gradients only: blurred shadows and radial gradients cost resvg
    // seconds of CPU per image, linear ones a few milliseconds.
    backgroundImage: 'linear-gradient(225deg, #FBE3B6 0%, #F8ECDD 22%, #F5EFEB 45%, #F5EFEB 80%, #F8E6DF 100%)',
  }, [header, body, footer]);

  return el('div', {
    display: 'flex',
    width: OG_WIDTH,
    height: OG_HEIGHT,
    padding: 30,
    fontFamily: `"${OG_SANS}", "${OG_SANS_CJK}"`,
    backgroundColor: TOKENS.plum950,
    // Coral glow top-right, violet glow bottom-left over the plum night background.
    backgroundImage: `linear-gradient(45deg, #4A2560 0%, ${TOKENS.plum900} 30%, ${TOKENS.plum950} 50%, ${TOKENS.plum900} 68%, #6B2E2C 100%)`,
  }, [ivoryCard]);
}

/** Every string the card draws, split by font role (used to subset the downloaded fonts). */
export function articleOgText(card: ArticleOgCard): { serif: string; sans: string; sansBold: string } {
  const bold = [card.membersBadge ?? '', '★', card.category ?? '', card.readingTime ?? '', card.sectionTitle,
    'Duy Nguyen /zuey/', 'zuey.me/articles', ...card.tags.map(t => `#${t}`)].join('');
  // Pills are uppercased by CSS, so both cases are needed.
  return { serif: card.title, sans: card.excerpt, sansBold: bold + bold.toUpperCase() };
}
