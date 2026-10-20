import React from 'react';
import type { Locale } from '../../lib/i18n/locales';
import { RemotePanelStatus, remotePanelStrings, useRemoteData } from '../os/remote-panel-data';
import { parseVideoList } from './zueytube-api-client';
import { ZueytubeBrowser } from './ZueytubeBrowser';

/**
 * Zuey OS Zueytube window: loads the curated list when the window is first shown. A `?v=` deep
 * link still works because ZueytubeBrowser reads it when it mounts with the loaded list.
 */
export const ZueytubeWindow: React.FC<{ locale: Locale }> = ({ locale }) => {
  const { state, retry } = useRemoteData('/api/v1/videos?limit=200', parseVideoList);
  if (state.status !== 'ready') return <RemotePanelStatus state={state} onRetry={retry} href="/videos" strings={remotePanelStrings(locale)} />;
  return <ZueytubeBrowser items={state.data.items} locale={locale} />;
};
