/**
 * An auto-renewing card subscription keeps access this long past the provider's billing date, so the
 * minutes between the renewal charge and its webhook never lock a paying member out. Its own module so the
 * analytics expiry sweep can match card access ends without importing the subscription code (an import cycle).
 */
export const CARD_RENEWAL_GRACE_MS = 24 * 60 * 60 * 1000;
