/**
 * `?ref=CODE` on any page → `/r/CODE?next=<same page without ref>`. Only the no-store `/r/{code}` route may
 * set the attribution cookie (cached pages must never Set-Cookie), so the client just hands over to it.
 *
 * The function must stay self-contained (no outer bindings, no nested functions): its source is inlined
 * into `REF_REDIRECT_SCRIPT` and runs before any bundle loads.
 */
export function refRedirectTarget(href: string): string | null {
  const url = new URL(href);
  if (url.pathname.indexOf('/r/') === 0 || url.pathname.indexOf('/api/') === 0) return null;
  const code = (url.searchParams.get('ref') || '').trim().toLowerCase();
  if (!/^[a-z0-9]{6,16}$/.test(code)) return null;
  url.searchParams.delete('ref');
  const next = url.pathname + url.search + url.hash;
  return '/r/' + code + '?next=' + encodeURIComponent(next);
}

/** Inline boot script for the base layout; failures never block the page. */
export const REF_REDIRECT_SCRIPT = `(function(){try{var t=(${refRedirectTarget.toString()})(location.href);if(t)location.replace(t);}catch(e){}})();`;
