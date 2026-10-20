import React from 'react';

interface SkeletonProps {
  /** Announced to screen readers while the content loads. */
  label: string;
  /** Placeholder bar heights in px (one bar per entry); defaults to a card-list shape. */
  rows?: readonly number[];
  className?: string;
}

const DEFAULT_ROWS = [80, 80, 80] as const;

/**
 * The shared loading placeholder for Zuey OS panels: shimmering bars (`.home-skeleton`, static
 * under reduced motion) inside a busy status region, so every panel loads the same way. A span
 * wrapper keeps it valid inside buttons (the phone activity widget is one).
 */
export const Skeleton: React.FC<SkeletonProps> = ({ label, rows = DEFAULT_ROWS, className }) => (
  <span className={`zf-skel${className ? ` ${className}` : ''}`} role="status" aria-busy="true" aria-label={label}>
    {rows.map((h, i) => (
      <span key={i} className="home-skeleton zf-skel-bar" style={{ height: h }} aria-hidden="true" />
    ))}
    <span className="sr-only">{label}</span>
  </span>
);
