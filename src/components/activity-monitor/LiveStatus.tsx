import React from 'react';
import { isFeedStale, type FeedState } from '../../lib/presence/presence-feed';
import type { ActivityMonitorStrings } from './activity-monitor-i18n';

interface LiveStatusProps {
  feed: FeedState;
  now: number;
  strings: ActivityMonitorStrings;
}

/** Connection indicator: a dot plus a text label (never colour alone) and how fresh the numbers are. */
export const LiveStatus: React.FC<LiveStatusProps> = ({ feed, now, strings }) => {
  const stale = isFeedStale(feed, now);
  const tone = feed.connection === 'live' && !stale ? 'live' : feed.connection === 'connecting' || feed.connection === 'reconnecting' || feed.connection === 'polling' || stale
      ? 'wait'
      : 'down';
  const label = stale ? strings.stale : strings.connection[feed.connection];
  const seconds = feed.updatedAt === null ? null : Math.max(0, Math.round((now - feed.updatedAt) / 1000));

  return (
    <p className="am-status" data-tone={tone}>
      <span className="am-dot" aria-hidden="true" />
      <b className="am-status-label">{label}</b>
      <span className="am-fresh">{seconds === null ? strings.noUpdateYet : strings.updated(seconds)}</span>
    </p>
  );
};
