/**
 * Small static list of throwaway-mailbox domains. A referee on one of these is a soft fraud signal
 * (commission goes to admin review), never a block: the list is a heuristic, not a verdict.
 */
export const DISPOSABLE_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  '10minutemail.com',
  '20minutemail.com',
  'dispostable.com',
  'discard.email',
  'emailondeck.com',
  'fakeinbox.com',
  'getnada.com',
  'guerrillamail.com',
  'guerrillamail.net',
  'guerrillamailblock.com',
  'maildrop.cc',
  'mailinator.com',
  'mailnesia.com',
  'mintemail.com',
  'moakt.com',
  'mohmal.com',
  'mytemp.email',
  'sharklasers.com',
  'spamgourmet.com',
  'temp-mail.org',
  'tempail.com',
  'tempmail.com',
  'tempmailo.com',
  'tempr.email',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
  'yopmail.net',
]);

/** True when the email's domain (or a parent domain) is a known disposable-mailbox provider. */
export function isDisposableEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const at = email.lastIndexOf('@');
  if (at < 0) return false;
  const labels = email.slice(at + 1).trim().toLowerCase().split('.');
  for (let i = 0; i < labels.length - 1; i++) {
    if (DISPOSABLE_EMAIL_DOMAINS.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}
