import React from 'react';

interface SkeletonProps {
  /** Announced to screen readers while the content loads. */
  label: string;
  /** Placeholder bar heights in px (one bar per entry); defaults to a card-list shape. */
  rows?: readonly number[];
  className?: string;
  /**
   * Bars only, hidden from assistive tech: for a placeholder inside a control (the phone activity
   * widget button), where a status label would become part of the control's name.
   */
  decorative?: boolean;
}

const DEFAULT_ROWS = [80, 80, 80] as const;

/**
 * The shared loading placeholder for Zuey OS panels: shimmering bars (`.home-skeleton`, static
 * under reduced motion) in a status region whose one label is its visually hidden text, so every
 * panel loads the same way. A span wrapper keeps it valid inside buttons.
 */
export const Skeleton: React.FC<SkeletonProps> = ({ label, rows = DEFAULT_ROWS, className, decorative = false }) => {
  const bars = rows.map((h, i) => (
    <span key={i} className="home-skeleton zf-skel-bar" style={{ height: h }} aria-hidden="true" />
  ));
  const cls = `zf-skel${className ? ` ${className}` : ''}`;
  if (decorative) return <span className={cls} aria-hidden="true">{bars}</span>;
  return (
    <span className={cls} role="status">
      {bars}
      <span className="sr-only">{label}</span>
    </span>
  );
};
