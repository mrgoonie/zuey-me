/** Small deterministic hash (FNV-1a) so the same article always gets the same artwork. */
export function thumbnailSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const PALETTES: Array<{ bg: string; ink: string; accent: string }> = [
  { bg: '#e8dac9', ink: '#925629', accent: '#f5efeb' },
  { bg: '#dfe4d6', ink: '#4d6339', accent: '#f3f5ee' },
  { bg: '#d9e1ea', ink: '#3b5878', accent: '#f1f4f8' },
  { bg: '#ead6d3', ink: '#8a3f37', accent: '#f8efed' },
  { bg: '#e6dff0', ink: '#5b4685', accent: '#f4f1f8' },
  { bg: '#efe3c4', ink: '#7c5a12', accent: '#faf5e8' },
];

interface Props {
  /** Stable key (article slug). */
  seed: string;
  /** Optional cover image of the public part; the branded artwork is used when absent. */
  coverUrl?: string | null;
  width?: number;
  height?: number;
  className?: string;
}

/**
 * Portrait thumbnail: the article's cover image when it has one, otherwise a branded SVG whose palette
 * and ornament are derived from the slug (never random). Decorative: the row title carries the meaning.
 */
export function BrandedThumbnail({ seed, coverUrl, width = 80, height = 92, className }: Props) {
  if (coverUrl) {
    return (
      <img
        src={coverUrl} alt="" width={width} height={height} loading="lazy" decoding="async" className={className}
        style={{ width, height, objectFit: 'cover', borderRadius: 14, flex: 'none', background: '#e8dac9' }}
      />
    );
  }
  const h = thumbnailSeed(seed);
  const p = PALETTES[h % PALETTES.length];
  const angle = (h >>> 3) % 360;
  const ring = 13 + ((h >>> 9) % 6);
  return (
    <svg
      viewBox="0 0 80 92" width={width} height={height} aria-hidden="true" focusable="false" className={className}
      style={{ flex: 'none', display: 'block' }}
    >
      <rect width="80" height="92" rx="14" fill={p.bg} />
      <circle cx="40" cy="46" r={ring + 6} fill="none" stroke={p.ink} strokeOpacity="0.18" strokeWidth="1.5"
        strokeDasharray="6 5" transform={`rotate(${angle} 40 46)`} />
      <text x="40" y="17" textAnchor="middle" fontFamily="ui-serif, Georgia, serif" fontSize="9" fontWeight="700" fill={p.ink}>/zuey/</text>
      <circle cx="40" cy="46" r={ring} fill={p.accent} />
      <g transform="translate(32 37)" fill="none" stroke={p.ink} strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round">
        <path d="M2 1h8l4 4v12H2z" />
        <path d="M10 1v4h4M5 9h6M5 12h6" />
      </g>
      <text x="40" y="83" textAnchor="middle" fontFamily="ui-sans-serif, system-ui, sans-serif" fontSize="6" fontWeight="800" letterSpacing="0.8" fill={p.ink}>KNOWLEDGES</text>
    </svg>
  );
}

export default BrandedThumbnail;
