import { describe, expect, test } from 'bun:test';
import { APPS, DOCK_APPS, SLOT_APPS, appFromHash } from '../src/components/os/apps';
import { osStrings } from '../src/components/os/os-i18n';
import { REF_REDIRECT_SCRIPT, refRedirectTarget } from '../src/components/referral/ref-redirect';
import {
  fmtBp, fmtCents, parseLeaderboard, parsePayoutProfile, parseReferralMe, recentMonths, tierProgress,
} from '../src/components/referral/referral-api';
import { fill, referralStrings } from '../src/components/referral/referral-i18n';
import { applyOutcome, normalizeCodeInput, parseReferralQuote, type ReferralQuoteView } from '../src/components/referral/referral-quote';
import { DEFAULT_TIERS } from '../src/lib/referrals/config';

const ME = {
  eligible: true, locked: false, code: 'abc234xy', link: 'https://zuey.me/r/abc234xy', rate: 25, admin_rate_override: null,
  tier: { count_90d: 4, rate: 25, window_days: 90, next: { min: 10, rate: 30, remaining: 6 } },
  discount_percent: 10, membership_split: { discount_percent: 10, commission_percent: 15 }, booking_split: { discount_percent: 4, commission_percent: 6 },
  leaderboard_opt_out: false,
  balance: { pending_cents: 1200, approved_cents: -300, processing_cents: 0, paid_cents: 5000 },
  commissions: [{ id: 'c1', source_kind: 'billing_order', referee: 'la***@x.com', base_amount_cents: 1900, commission_percent: 15, commission_cents: 285, status: 'pending', paid_at: '2026-10-01T00:00:00Z', hold_until: '2026-10-31T00:00:00Z', approved_at: null, reversed_at: null }],
  payouts: [{ id: 'p1', period: '2026-09', method: 'vn_bank', gross_cents: 5000, deduction_bp: 1000, deduction_cents: 500, net_cents: 4500, net_vnd: 1185750, status: 'paid', transaction_ref: 'FT123', paid_at: '2026-10-05T00:00:00Z' }],
  payout_profile: { status: 'verified', method: 'vn_bank' },
  next_close_date: '2026-11-01',
  program: { tiers: DEFAULT_TIERS, hold_days: 30, booking_rate: 10, payout_threshold_cents: 5000, vn_deduction_bp: 1000, paypal_deduction_bp: 1800 },
};

describe('Referral app registration in Zuey OS', () => {
  test('referral is a stage slot app in the dock with its own route and labels', () => {
    expect(APPS.referral).toMatchObject({ id: 'referral', surface: 'stage', href: '/referral' });
    expect(DOCK_APPS).toContain('referral');
    expect(SLOT_APPS).toContain('referral');
    expect(appFromHash('#referral')).toBe('referral');
    expect(osStrings('en').apps.referral).toBe('Referral');
    // Distinct from About ("Giới thiệu") so the Vietnamese dock never shows two identical labels.
    expect(osStrings('vi').apps.referral).not.toBe(osStrings('vi').apps.about);
  });
});

describe('Referral member view parsing', () => {
  test('parses the me view and keeps negative balances', () => {
    const me = parseReferralMe(ME);
    expect(me?.membership_split).toEqual({ discount: 10, commission: 15 });
    expect(me?.tier.next).toEqual({ min: 10, rate: 30, remaining: 6 });
    expect(me?.balance.approved_cents).toBe(-300);
    expect(me?.commissions[0]).toMatchObject({ referee: 'la***@x.com', commission_cents: 285, status: 'pending' });
    expect(me?.payouts[0]).toMatchObject({ net_vnd: 1185750, transaction_ref: 'FT123' });
    expect(me?.program.tiers).toHaveLength(5);
  });

  test('rejects payloads that are not a referral view', () => {
    expect(parseReferralMe(null)).toBeNull();
    expect(parseReferralMe({ eligible: 'yes' })).toBeNull();
    expect(parseReferralMe({ ...ME, balance: null })).toBeNull();
  });

  test('tier progress runs from the current tier threshold to the next', () => {
    expect(tierProgress(0, DEFAULT_TIERS)).toBe(0);
    expect(tierProgress(4, DEFAULT_TIERS)).toBeCloseTo(1 / 7);
    expect(tierProgress(10, DEFAULT_TIERS)).toBe(0);
    expect(tierProgress(80, DEFAULT_TIERS)).toBe(1);
  });

  test('money and basis-point labels', () => {
    expect(fmtCents(5000)).toBe('$50');
    expect(fmtCents(285)).toBe('$2.85');
    expect(fmtCents(-300)).toBe('−$3');
    expect(fmtBp(1000)).toBe('10%');
    expect(fmtBp(1250)).toBe('12.5%');
  });

  test('payout profile and leaderboard envelopes', () => {
    expect(parsePayoutProfile({ profile: null })).toBeNull();
    expect(parsePayoutProfile({ profile: { method: 'paypal', status: 'submitted', paypal_email: 'a@b.co', has_id_front: false } }))
      .toMatchObject({ method: 'paypal', status: 'submitted', paypal_email: 'a@b.co', has_id_front: false, full_name: '' });
    expect(parseLeaderboard({ month: '2026-10', entries: [{ rank: 1, name: 'Duy N.', referrals: 3 }] })).toEqual([{ rank: 1, name: 'Duy N.', referrals: 3 }]);
    expect(parseLeaderboard({ month: '2026-10' })).toBeNull();
  });

  test('recent months are Asia/Saigon local and roll over the year', () => {
    // 2026-12-31T18:00Z is already 1 January 2027 in Saigon.
    expect(recentMonths(Date.parse('2026-12-31T18:00:00Z'), 3)).toEqual(['2027-01', '2026-12', '2026-11']);
  });

  test('both locales carry the deduction labels and fill placeholders', () => {
    expect(fill(referralStrings('vi').profile.deductionVn, { pct: '10%' })).toBe('Thuế TNCN 10%');
    expect(fill(referralStrings('vi').profile.deductionPaypal, { pct: '18%' })).toBe('Phí xử lý & thuế 18%');
    expect(fill(referralStrings('vi').split.label, { mine: 15, theirs: 10 })).toBe('Bạn nhận 15% · Bạn bè giảm 10%');
    expect(referralStrings('ja')).toBe(referralStrings('en'));
  });
});

describe('Referral checkout quote', () => {
  const quote = (referral: ReferralQuoteView['referral']): ReferralQuoteView => ({
    referral, plans: [], card_first_month: [], booking: { amount_usd_cents: 199_900, discounted_usd_cents: 199_900, amount_vnd: null, discounted_vnd: null },
  });

  test('parses the quote and treats a missing referral as none', () => {
    const q = parseReferralQuote({
      referral: { code: 'abc234xy', discount_percent: 10, booking_discount_percent: 4, source: 'cookie', provisional: true },
      plans: [{ plan: 'combo', months: 12, prepay_discount_percent: 15, amount_usd_cents: 19380, amount_vnd: 5_107_000, discounted_usd_cents: 17442, discounted_vnd: 4_597_000 }],
      card_first_month: [{ plan: 'combo', amount_usd_cents: 1900, discounted_usd_cents: 1710 }],
      booking: { amount_usd_cents: 199_900, discounted_usd_cents: 191_904, amount_vnd: null, discounted_vnd: null },
    });
    expect(q?.referral).toMatchObject({ code: 'abc234xy', provisional: true });
    expect(q?.plans[0]).toMatchObject({ plan: 'combo', months: 12, discounted_vnd: 4_597_000 });
    expect(q?.card_first_month[0].discounted_usd_cents).toBe(1710);
    expect(parseReferralQuote({ referral: null, plans: [], booking: {} })?.referral).toBeNull();
    expect(parseReferralQuote({ plans: 'x' })).toBeNull();
  });

  test('typed code outcome: applied, kept account binding, or not applicable', () => {
    const r = { code: 'abc234xy', discount_percent: 10, booking_discount_percent: 4, provisional: false };
    expect(applyOutcome('abc234xy', quote({ ...r, source: 'entered' }))).toBe('applied');
    expect(applyOutcome('zzz999zz', quote({ ...r, source: 'bound' }))).toBe('bound_elsewhere');
    expect(applyOutcome('zzz999zz', quote({ ...r, source: 'cookie' }))).toBe('not_applicable');
    expect(applyOutcome('zzz999zz', quote(null))).toBe('not_applicable');
  });

  test('code input follows the server code shape', () => {
    expect(normalizeCodeInput('  ABC234xy ')).toBe('abc234xy');
    expect(normalizeCodeInput('ab-12')).toBeNull();
    expect(normalizeCodeInput('a'.repeat(17))).toBeNull();
  });
});

describe('?ref= redirect', () => {
  test('hands a valid code to /r/{code} and keeps the rest of the URL as next', () => {
    expect(refRedirectTarget('https://zuey.me/pricing?plan=combo&ref=ABC234xy#x')).toBe(`/r/abc234xy?next=${encodeURIComponent('/pricing?plan=combo#x')}`);
    expect(refRedirectTarget('https://zuey.me/?ref=abc234xy')).toBe(`/r/abc234xy?next=${encodeURIComponent('/')}`);
  });

  test('ignores malformed codes, pages without ref and the /r/ route itself', () => {
    expect(refRedirectTarget('https://zuey.me/pricing')).toBeNull();
    expect(refRedirectTarget('https://zuey.me/?ref=<script>')).toBeNull();
    expect(refRedirectTarget('https://zuey.me/r/abc234xy?ref=abc234xy')).toBeNull();
  });

  test('the inline script is self-contained and replaces the location', () => {
    const replaced: string[] = [];
    const location = { href: 'https://zuey.me/business?ref=abc234xy', replace: (u: string) => { replaced.push(u); } };
    new Function('location', REF_REDIRECT_SCRIPT)(location);
    expect(replaced).toEqual([`/r/abc234xy?next=${encodeURIComponent('/business')}`]);
    const untouched = { href: 'https://zuey.me/', replace: (u: string) => { replaced.push(u); } };
    new Function('location', REF_REDIRECT_SCRIPT)(untouched);
    expect(replaced).toHaveLength(1);
  });
});
