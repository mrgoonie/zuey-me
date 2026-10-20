import React from 'react';
import type { Locale } from '../../lib/i18n/locales';
import { RemotePanelStatus, remotePanelStrings, useRemoteData } from '../os/remote-panel-data';
import { parseLab200Snapshot } from './lab200-api-client';
import { Lab200Courses } from './Lab200Courses';

/** Zuey OS 200lab window: loads the course snapshot when the window is first shown. */
export const Lab200Window: React.FC<{ locale: Locale }> = ({ locale }) => {
  const { state, retry } = useRemoteData('/api/v1/lab200', parseLab200Snapshot);
  if (state.status !== 'ready') return <RemotePanelStatus state={state} onRetry={retry} href="/200lab" strings={remotePanelStrings(locale)} />;
  return <Lab200Courses snapshot={state.data} locale={locale} variant="window" />;
};
