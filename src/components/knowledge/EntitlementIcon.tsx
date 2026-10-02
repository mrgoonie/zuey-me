import type { ArticleAccess } from '../../lib/blocks/schema';

interface Props {
  access: ArticleAccess;
  /** Accessible names, localized by the caller. */
  paidLabel: string;
  freeLabel: string;
  size?: number;
}

/** Lock (members) or open book (free) icon with an accessible name; never colour-only. */
export function EntitlementIcon({ access, paidLabel, freeLabel, size = 16 }: Props) {
  const paid = access === 'knowledges';
  const label = paid ? paidLabel : freeLabel;
  return (
    <span role="img" aria-label={label} title={label} style={{ display: 'inline-flex', flex: 'none', color: paid ? '#925629' : '#57534e' }}>
      <svg viewBox="0 0 16 16" width={size} height={size} aria-hidden="true" focusable="false" fill="none" stroke="currentColor"
        strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {paid ? (
          <>
            <rect x="3" y="7" width="10" height="7" rx="1.5" />
            <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
          </>
        ) : (
          <>
            <path d="M8 4.5C6.5 3.5 4.5 3 2 3v9c2.5 0 4.5.5 6 1.5 1.5-1 3.5-1.5 6-1.5V3c-2.5 0-4.5.5-6 1.5z" />
            <path d="M8 4.5v9" />
          </>
        )}
      </svg>
    </span>
  );
}

export default EntitlementIcon;
