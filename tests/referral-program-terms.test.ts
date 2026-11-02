import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReferralProgramTerms } from '../src/components/referral/ReferralProgramTerms';
import { DEFAULT_REFERRAL_SETTINGS } from '../src/lib/referrals/config';

const render = (program: typeof DEFAULT_REFERRAL_SETTINGS, locale: 'vi' | 'en') =>
  renderToStaticMarkup(createElement(ReferralProgramTerms, { program, locale }));

describe('public referral terms', () => {
  test('renders every tier and the payout terms from settings (vi)', () => {
    const html = render(DEFAULT_REFERRAL_SETTINGS, 'vi');
    for (const rate of ['20%', '25%', '30%', '40%', '50%']) expect(html).toContain(rate);
    expect(html).toContain('id="how-it-works"');
    expect(html).toContain('$50');
    expect(html).toContain('10% thuế TNCN');
    expect(html).toContain('18% phí xử lý');
    expect(html).toContain('chờ 30 ngày');
  });

  test('follows admin changes without code edits (en)', () => {
    const html = render({ ...DEFAULT_REFERRAL_SETTINGS, payout_threshold_cents: 2500, vn_deduction_bp: 750, hold_days: 45,
      tiers: [{ min: 0, rate: 15 }, { min: 5, rate: 35 }] }, 'en');
    expect(html).toContain('$25');
    expect(html).toContain('7.5% personal income tax');
    expect(html).toContain('held for 45 days');
    expect(html).toContain('15% by default, rising to 35%');
    expect(html).not.toContain('50%');
  });
});
