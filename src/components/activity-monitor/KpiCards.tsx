import React from 'react';
import type { PresenceSnapshot } from '../../lib/presence/contract';
import type { ActivityMonitorStrings } from './activity-monitor-i18n';

interface KpiCardsProps {
  snapshot: PresenceSnapshot | null;
  /** True when the numbers are not live (reconnecting, offline, stale): they are dimmed. */
  dimmed: boolean;
  strings: ActivityMonitorStrings;
  locale: string;
}

const DASH = '—';

/** The three headline cards. Without a snapshot every value is a dash with a reason, never a zero. */
export const KpiCards: React.FC<KpiCardsProps> = ({ snapshot, dimmed, strings, locale }) => {
  const fmt = (n: number) => n.toLocaleString(locale);
  const owner = snapshot?.owner ?? null;

  return (
    <ul className={`am-kpis${dimmed ? ' is-dimmed' : ''}`}>
      <li className="am-kpi" data-kpi="active">
        <h3>{strings.kpi.active}</h3>
        <p className="am-kpi-val" aria-label={snapshot ? undefined : strings.noData}>{snapshot ? fmt(snapshot.active) : DASH}</p>
      </li>

      <li className="am-kpi" data-kpi="members">
        <h3>{strings.kpi.members}</h3>
        {snapshot === null ? (
          <p className="am-kpi-val" aria-label={strings.noData}>{DASH}</p>
        ) : snapshot.members === null ? (
          <>
            <p className="am-kpi-val am-kpi-val--text">{`< 3`}</p>
            <p className="am-kpi-sub">{strings.kpi.membersHidden}. {strings.kpi.membersHiddenHint}</p>
          </>
        ) : (
          <p className="am-kpi-val">{fmt(snapshot.members)}</p>
        )}
      </li>

      <li className="am-kpi am-kpi--owner" data-kpi="owner">
        <h3>{strings.kpi.owner}</h3>
        {owner === null ? (
          <p className="am-kpi-val" aria-label={strings.noData}>{DASH}</p>
        ) : (
          <>
            <p className="am-kpi-val am-kpi-val--text" data-owner-status={owner.status}>{strings.owner.status[owner.status]}</p>
            <p className="am-kpi-sub">{owner.onSite ? strings.owner.onSite : strings.owner.notOnSite}</p>
            {owner.text && <p className="am-owner-text">{owner.text}</p>}
          </>
        )}
      </li>
    </ul>
  );
};
