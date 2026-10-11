/** Id of the `<meta>` element the layout renders with the PostHog key/host for the browser boot. */
export const CONFIG_ELEMENT_ID = 'zuey-analytics';

/** Hostnames that send analytics; previews, localhost and other hosts stay silent unless debug is on. */
export const PRODUCTION_HOSTNAMES: readonly string[] = ['zuey.me', 'www.zuey.me'];
