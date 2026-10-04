import React from 'react';
import { BookText, Workflow } from 'lucide-react';
import type { Profile } from '../../db/types';
import type { Locale } from '../../lib/i18n/locales';
import { ContributionGraph, useContributionCalendar } from '../home/ContributionGraph';
import type { HomeStrings } from '../home/home-i18n';
import { useMediaQuery } from '../home/motion';
import { DOCK_APPS, type AppId } from './apps';
import { AppGlyph } from './AppGlyph';
import type { OsStrings } from './os-i18n';

interface MobileHomeProps {
  locale: Locale;
  profile: Profile;
  strings: OsStrings;
  homeStrings: HomeStrings;
  onOpen: (id: AppId) => void;
}

/** Phone home screen (below 768px): profile card, app grid, activity widget and an Ask bar. */
export const MobileHome: React.FC<MobileHomeProps> = ({ locale, profile, strings, homeStrings, onOpen }) => {
  const phone = useMediaQuery('(max-width: 767px)');
  const calendar = useContributionCalendar(phone);
  const intro = locale === 'vi' ? profile.intro_vi : profile.intro_en;

  return (
    <div className="os-home">
      <button type="button" className="os-home-prof" onClick={() => onOpen('about')}>
        <img src={profile.avatar_url} alt="" width={64} height={64} />
        <span>
          <b>{profile.name}</b>
          <small>{intro}</small>
        </span>
      </button>

      <ul className="os-home-apps">
        {[...DOCK_APPS, 'appearance' as const].map(id => (
          <li key={id}>
            <button type="button" onClick={() => onOpen(id)}>
              <AppGlyph id={id} avatar={profile.avatar_url} />
              <span>{strings.apps[id]}</span>
            </button>
          </li>
        ))}
        <li>
          <a href="/workflows">
            <span className="os-g os-g--flow" aria-hidden="true"><Workflow aria-hidden /></span>
            <span>{strings.links.workflows}</span>
          </a>
        </li>
        <li>
          <a href="/docs">
            <span className="os-g os-g--docs" aria-hidden="true"><BookText aria-hidden /></span>
            <span>{strings.links.docs}</span>
          </a>
        </li>
      </ul>

      <button type="button" className="os-home-widget" onClick={() => onOpen('github')}>
        <span className="os-home-wh">{strings.mobile.activity}<small>{strings.mobile.seeAll}</small></span>
        {calendar.data && calendar.data.days.length > 0 ? (
          <ContributionGraph
            days={calendar.data.days.slice(-7 * 22)}
            total={null}
            locale={locale}
            compact
            strings={homeStrings.activity.calendar}
          />
        ) : (
          <span className="os-home-skel" aria-hidden="true" />
        )}
      </button>

      <p className="os-home-foot">
        <a href="/privacy">{strings.privacy}</a>
      </p>

      <button type="button" className="os-askbar" onClick={() => onOpen('ai')}>
        <span>{strings.mobile.ask}</span>
        <b>{strings.mobile.askCta}</b>
      </button>
    </div>
  );
};
