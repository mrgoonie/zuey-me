import React from 'react';
import type { Locale } from '../../lib/i18n/locales';
import { isFeedStale } from '../../lib/presence/presence-feed';
import { activityMonitorStrings } from './activity-monitor-i18n';
import { CategoryBars } from './CategoryBars';
import { KpiCards } from './KpiCards';
import { LiveStatus } from './LiveStatus';
import { useActivityFeed, useNow, useThrottled } from './use-activity-feed';
import './activity-monitor.css';

interface ActivityMonitorPanelProps {
  locale: Locale;
  /** False while the window is closed or minimized: the panel then holds no connection. */
  active: boolean;
}

/** Activity Monitor: anonymous, approximate live presence on zuey.me, fed by the shared presence feed. */
export const ActivityMonitorPanel: React.FC<ActivityMonitorPanelProps> = ({ locale, active }) => {
  const strings = activityMonitorStrings(locale);
  const feed = useActivityFeed(active);
  const now = useNow(active);
  const { snapshot, connection } = feed;
  const dimmed = connection !== 'live' || isFeedStale(feed, now);
  const reason = connection === 'live' ? null : strings.reason[connection];
  // Screen readers hear a count change at most every 10 s; the visible number still updates live.
  const announced = useThrottled(snapshot ? snapshot.active : null, 10_000);

  return (
    <div className="am" lang={locale}>
      <header className="am-head">
        <h2>{strings.heading}</h2>
        <LiveStatus feed={feed} now={now} strings={strings} />
      </header>

      {reason !== null && (
        <p className="am-reason" role="status" data-reason={connection}>{reason}</p>
      )}

      <KpiCards snapshot={snapshot} dimmed={dimmed} strings={strings} locale={locale} />
      <CategoryBars snapshot={snapshot} dimmed={dimmed} strings={strings} locale={locale} />

      <p className="am-sr" aria-live="polite" aria-atomic="true">{announced === null ? '' : strings.announce(announced)}</p>

      <p className="am-note">
        {strings.note} <a href="/privacy">{strings.privacy}</a>
      </p>
    </div>
  );
};
