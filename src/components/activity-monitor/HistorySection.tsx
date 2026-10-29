import React, { useMemo } from 'react';
import type { Locale } from '../../lib/i18n/locales';
import type { ActivityCategory } from '../../lib/presence/contract';
import { buildHistorySeries } from '../../lib/presence/presence-history-chart';
import { activityHistoryStrings } from './activity-history-i18n';
import { HistoryChart } from './HistoryChart';
import { usePresenceHistory } from './use-presence-history';

interface HistorySectionProps {
  locale: Locale;
  /** False while the window is closed or minimized: nothing is fetched. */
  active: boolean;
  categoryNames: Record<ActivityCategory, string>;
}

/**
 * The 24h chart under the live numbers. It has its own loading, empty and error states and its own fetches,
 * so a missing history never changes the live panel above it.
 */
export const HistorySection: React.FC<HistorySectionProps> = ({ locale, active, categoryNames }) => {
  const strings = activityHistoryStrings(locale);
  const { history, loading, error } = usePresenceHistory(active);
  const series = useMemo(() => (history ? buildHistorySeries(history) : null), [history]);

  let body: React.ReactNode;
  if (series === null) {
    body = error !== null && !loading
      ? <p className="am-empty" data-history-state="error">{strings.unavailable}</p>
      : <p className="am-empty" data-history-state="loading" aria-busy="true">{strings.loading}</p>;
  } else if (series.empty) {
    body = <p className="am-empty" data-history-state="empty">{strings.empty}</p>;
  } else {
    body = <HistoryChart series={series} strings={strings} categoryNames={categoryNames} locale={locale} />;
  }

  return (
    <section className="am-hist" aria-labelledby="am-hist-title" data-history-stale={series !== null && error !== null ? '' : undefined}>
      <div className="am-hist-head">
        <h3 id="am-hist-title">{strings.title}</h3>
        <p>{strings.subtitle}</p>
      </div>
      {body}
      {series !== null && error !== null && <p className="am-hist-note" data-history-state="error">{strings.unavailable}</p>}
    </section>
  );
};
