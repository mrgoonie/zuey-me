import React from 'react';
import type { Locale } from '../../lib/i18n/locales';
import { RemotePanel, remotePanelStrings, useRemoteData } from '../os/remote-panel-data';
import { parseLab200Catalog } from './lab200-api-client';
import { Lab200Catalog } from './Lab200Catalog';

/** Zuey OS 200lab window: loads both catalogs when the window is first shown. */
export const Lab200Window: React.FC<{ locale: Locale }> = ({ locale }) => {
  const { state, retry } = useRemoteData('/api/v1/lab200', parseLab200Catalog);
  return (
    <RemotePanel state={state} onRetry={retry} href="/200lab" strings={remotePanelStrings(locale)}>
      {data => <Lab200Catalog catalog={data} locale={locale} variant="window" />}
    </RemotePanel>
  );
};
