import React from 'react';
import type { PresenceSnapshot } from '../../lib/presence/contract';
import type { ActivityMonitorStrings } from './activity-monitor-i18n';

interface CategoryBarsProps {
  snapshot: PresenceSnapshot | null;
  dimmed: boolean;
  strings: ActivityMonitorStrings;
  locale: string;
}

/** Horizontal bars per activity category. Honest about why the list may be empty. */
export const CategoryBars: React.FC<CategoryBarsProps> = ({ snapshot, dimmed, strings, locale }) => {
  const rows = snapshot ? [...snapshot.categories].sort((a, b) => b.count - a.count) : [];
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);

  let empty: string | null = null;
  if (snapshot === null) empty = strings.noData;
  else if (rows.length === 0) empty = snapshot.active === 0 ? strings.categories.nobody : strings.categories.hidden;

  return (
    <section className={`am-cats${dimmed ? ' is-dimmed' : ''}`} aria-labelledby="am-cats-title">
      <h3 id="am-cats-title">{strings.categories.title}</h3>
      {empty !== null ? (
        <p className="am-empty">{empty}</p>
      ) : (
        <ul>
          {rows.map(row => (
            <li key={row.id} data-category={row.id}>
              <span className="am-cat-name">{strings.categories.names[row.id]}</span>
              <span className="am-cat-count">{row.count.toLocaleString(locale)}</span>
              <span className="am-bar" role="presentation"><span style={{ width: `${max > 0 ? Math.max(4, Math.round((row.count / max) * 100)) : 0}%` }} /></span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
