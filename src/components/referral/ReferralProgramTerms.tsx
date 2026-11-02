import React from 'react';
import type { Locale } from '../../lib/i18n/locales';
import type { ReferralSettings } from '../../lib/referrals/config';
import { TIER_WINDOW_DAYS } from '../../lib/referrals/jobs';

export type ReferralProgramFacts = Pick<
  ReferralSettings,
  'tiers' | 'hold_days' | 'booking_rate' | 'payout_threshold_cents' | 'vn_deduction_bp' | 'paypal_deduction_bp' | 'cookie_days'
>;

const pct = (bp: number) => `${Number((bp / 100).toFixed(2))}%`;
const usd = (cents: number) => `$${Number((cents / 100).toFixed(2))}`;

/**
 * Public "how it works" and terms for /referral. Every number comes from the live referral settings,
 * so the page follows admin changes to tiers, hold, threshold and deductions without a deploy.
 */
export function ReferralProgramTerms({ program, locale }: { program: ReferralProgramFacts; locale: Locale }) {
  const vi = locale === 'vi';
  const tiers = [...program.tiers].sort((a, b) => a.min - b.min);
  const base = tiers[0]?.rate ?? 20;
  const top = tiers[tiers.length - 1]?.rate ?? base;
  const exampleRate = tiers.find(t => t.rate > base)?.rate ?? base;
  const exampleDiscount = Math.round(exampleRate / 3);
  const h2 = 'text-lg sm:text-xl font-bold font-serif text-stone-900';
  const list = 'mt-2 grid gap-1.5 text-sm text-stone-800 list-disc pl-5';

  return (
    <section id="how-it-works" aria-labelledby="referral-terms-title" className="mt-4 rounded-3xl bg-[#F5EFEB] border border-stone-200 p-4 sm:p-6 text-stone-900">
      <h2 id="referral-terms-title" className="text-xl sm:text-2xl font-bold font-serif">
        {vi ? 'Cách hoạt động & điều khoản' : 'How it works & terms'}
      </h2>

      <ol className="mt-3 grid gap-1.5 text-sm text-stone-800 list-decimal pl-5">
        {vi ? (
          <>
            <li>Thành viên có gói đang hoạt động nhận một link riêng <code>zuey.me/r/mã</code> và một mã giới thiệu.</li>
            <li>Bạn bè mở link (được ghi nhớ {program.cookie_days} ngày) hoặc nhập mã khi thanh toán. Lượt giới thiệu gắn cố định khi họ tạo tài khoản.</li>
            <li>Đơn trả tiền đầu tiên của họ (gói thành viên, khoá học hoặc tư vấn 1:1) được giảm giá, còn bạn nhận hoa hồng trên số tiền thực thu.</li>
          </>
        ) : (
          <>
            <li>Members with an active plan get one personal link, <code>zuey.me/r/code</code>, and a referral code.</li>
            <li>Friends open the link (remembered for {program.cookie_days} days) or enter the code at checkout. The referral binds permanently when they create an account.</li>
            <li>Their first paid order (membership, course or 1:1 consultation) is discounted, and you earn a commission on the amount actually collected.</li>
          </>
        )}
      </ol>

      <h3 className={`${h2} mt-5`}>{vi ? 'Tỷ lệ theo bậc' : 'Rate tiers'}</h3>
      <p className="mt-1 text-sm text-stone-700">
        {vi
          ? `Mặc định ${base}%, tăng tới ${top}% theo số lượt giới thiệu thành công trong ${TIER_WINDOW_DAYS} ngày gần nhất.`
          : `${base}% by default, rising to ${top}% with successful referrals in the last ${TIER_WINDOW_DAYS} days.`}
      </p>
      <table className="mt-2 w-full max-w-sm text-sm border-collapse">
        <thead>
          <tr className="text-left text-stone-600">
            <th className="py-1 pr-4 font-semibold">{vi ? `Lượt thành công / ${TIER_WINDOW_DAYS} ngày` : `Successes / ${TIER_WINDOW_DAYS} days`}</th>
            <th className="py-1 font-semibold">{vi ? 'Tỷ lệ' : 'Rate'}</th>
          </tr>
        </thead>
        <tbody>
          {tiers.map(t => (
            <tr key={t.min} className="border-t border-stone-300/70">
              <td className="py-1 pr-4">{t.min === 0 ? (vi ? 'Khởi đầu' : 'Start') : `${t.min}+`}</td>
              <td className="py-1 font-semibold">{t.rate}%</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3 className={`${h2} mt-5`}>{vi ? 'Tự chia ưu đãi' : 'Split it your way'}</h3>
      <ul className={list}>
        {vi ? (
          <>
            <li>Bạn chọn bao nhiêu phần trong tỷ lệ của mình dành để giảm giá cho bạn bè; phần còn lại là hoa hồng. Ví dụ tỷ lệ {exampleRate}%: giảm {exampleDiscount}% cho bạn bè, bạn nhận {exampleRate - exampleDiscount}%.</li>
            <li>Tư vấn 1:1: tổng ưu đãi là {program.booking_rate}%, chia theo cùng tỷ lệ bạn đã chọn.</li>
            <li>Không cộng dồn với mã khuyến mãi khác: hệ thống áp dụng mức giảm cao hơn.</li>
          </>
        ) : (
          <>
            <li>You choose how much of your rate goes to your friend as a discount; the rest is your commission. Example at {exampleRate}%: {exampleDiscount}% off for your friend, {exampleRate - exampleDiscount}% for you.</li>
            <li>1:1 consultations: {program.booking_rate}% in total, split in the same proportion.</li>
            <li>Not combined with other promo codes: checkout applies the larger discount.</li>
          </>
        )}
      </ul>

      <h3 className={`${h2} mt-5`}>{vi ? 'Hoa hồng & chi trả' : 'Commission & payouts'}</h3>
      <ul className={list}>
        {vi ? (
          <>
            <li>Hoa hồng chờ {program.hold_days} ngày (tư vấn: {program.hold_days} ngày sau buổi tư vấn) rồi mới được duyệt. Đơn bị hoàn tiền hoặc khiếu nại thì hoa hồng bị huỷ.</li>
            <li>Chốt sổ ngày 1 hằng tháng, chi trả từ ngày 1 đến ngày 10 khi số dư đã duyệt từ {usd(program.payout_threshold_cents)} trở lên.</li>
            <li>Chuyển khoản ngân hàng tại Việt Nam: khấu trừ {pct(program.vn_deduction_bp)} thuế TNCN. Cần thông tin ngân hàng và ảnh hai mặt CCCD; ảnh được xoá ngay sau khi hồ sơ được duyệt.</li>
            <li>PayPal (ngoài Việt Nam): khấu trừ {pct(program.paypal_deduction_bp)} phí xử lý &amp; thuế. Chỉ cần email PayPal.</li>
          </>
        ) : (
          <>
            <li>Commissions are held for {program.hold_days} days ({program.hold_days} days after the session for consultations) before approval. Refunded or disputed orders cancel the commission.</li>
            <li>Books close on the 1st of each month; payouts go out between the 1st and the 10th once your approved balance reaches {usd(program.payout_threshold_cents)}.</li>
            <li>Vietnamese bank transfer: {pct(program.vn_deduction_bp)} personal income tax withheld. Requires bank details and both sides of your national ID card; the images are deleted as soon as the profile is approved.</li>
            <li>PayPal (outside Vietnam): {pct(program.paypal_deduction_bp)} processing fees &amp; tax withheld. Only a PayPal email is needed.</li>
          </>
        )}
      </ul>

      <h3 className={`${h2} mt-5`}>{vi ? 'Quy định' : 'Rules'}</h3>
      <ul className={list}>
        {vi ? (
          <>
            <li>Chỉ tính đơn trả tiền đầu tiên của người chưa từng thanh toán trên zuey.me. Tự giới thiệu không được tính.</li>
            <li>Khi gói của bạn hết hạn, link tạm dừng; hoa hồng đã có vẫn được chi trả.</li>
            <li>Đơn có dấu hiệu bất thường được xem xét thủ công trước khi duyệt; gian lận bị huỷ hoa hồng và khoá link.</li>
            <li>Bảng xếp hạng top 10 hằng tháng hiển thị tên đã che một phần, và bạn có thể tắt hiển thị.</li>
          </>
        ) : (
          <>
            <li>Only a buyer's first paid order counts, and only if they have never paid on zuey.me before. Self-referrals do not count.</li>
            <li>If your plan lapses, your link pauses; commissions you already earned stay payable.</li>
            <li>Suspicious orders are reviewed manually before approval; fraud cancels the commission and locks the link.</li>
            <li>The monthly top-10 leaderboard shows partially masked names, and you can opt out.</li>
          </>
        )}
      </ul>
    </section>
  );
}
