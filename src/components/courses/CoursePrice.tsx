import type { CourseQuote } from '../../lib/courses/course-pricing';
import { fmtUsd, fmtVnd, planName } from '../members/member-ui';

/** Why the viewer gets a discount, in one short Vietnamese label. */
export function discountLabel(quote: CourseQuote): string | null {
  if (quote.applied_pct <= 0) return null;
  if (quote.discount_source === 'subscriber') {
    return `−${quote.applied_pct}% thành viên${quote.subscriber_plan ? ` ${planName(quote.subscriber_plan)}` : ''}`;
  }
  if (quote.discount_source === 'referral') return `−${quote.applied_pct}% mã giới thiệu`;
  if (quote.discount_source === 'promo') return `−${quote.applied_pct}% mã ưu đãi`;
  return `−${quote.applied_pct}%`;
}

/**
 * Personal price: the amount the viewer pays now, the list price struck through when a discount
 * applies, and the VND transfer amount. Pure markup, safe to render on the server without hydration.
 */
export function CoursePrice({ quote, size = 'md' }: { quote: CourseQuote; size?: 'md' | 'lg' }) {
  const label = discountLabel(quote);
  const free = quote.list_usd_cents <= 0;
  return (
    <div className="min-w-0">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className={`${size === 'lg' ? 'text-3xl sm:text-4xl' : 'text-2xl'} font-bold tabular-nums`}>
          {free ? 'Miễn phí' : fmtUsd(quote.amount_usd_cents)}
        </span>
        {label && (
          <>
            <s className="text-sm text-stone-500 tabular-nums" aria-label={`Giá gốc ${fmtUsd(quote.list_usd_cents)}`}>{fmtUsd(quote.list_usd_cents)}</s>
            <span className="rounded-full bg-emerald-100 border border-emerald-300 px-2 py-0.5 text-[11px] font-bold text-emerald-900">{label}</span>
          </>
        )}
      </p>
      {!free && quote.amount_vnd !== null && quote.amount_vnd > 0 && (
        <p className="mt-0.5 text-xs text-stone-600 tabular-nums">≈ {fmtVnd(quote.amount_vnd)} khi chuyển khoản VietQR</p>
      )}
    </div>
  );
}
