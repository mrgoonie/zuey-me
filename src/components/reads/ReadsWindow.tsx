import React from 'react';
import type { Locale } from '../../lib/i18n/locales';
import { RemotePanelStatus, remotePanelStrings, useRemoteData } from '../os/remote-panel-data';
import { ReadsBrowser } from './ReadsBrowser';
import { parseReadsList } from './reads-api-client';

/** Reads shown in the desktop window; the full archive lives on /reads. */
export const HOME_READS_LIMIT = 60;

/** Zuey OS Reads window: loads the list when the window is first shown. */
export const ReadsWindow: React.FC<{ locale: Locale }> = ({ locale }) => {
  const { state, retry } = useRemoteData(`/api/v1/reads?limit=${HOME_READS_LIMIT}`, parseReadsList);
  if (state.status !== 'ready') return <RemotePanelStatus state={state} onRetry={retry} href="/reads" strings={remotePanelStrings(locale)} />;
  return <ReadsBrowser items={state.data.items} sources={state.data.sources} lastSyncedAt={state.data.lastSyncedAt} />;
};
