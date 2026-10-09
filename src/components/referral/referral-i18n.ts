import type { Locale } from '../../lib/i18n/locales';

/** Copy for the Referral app. Vietnamese and English; other site locales fall back to English. */
const en = {
  title: 'Refer friends',
  intro: 'Share your link: friends get a discount on their first order, you earn a commission when they pay.',
  tabs: { program: 'Program', payout: 'Get paid', leaderboard: 'Leaderboard' },
  loading: 'Loading your referral program…',
  loadFailed: 'Could not load the referral program.',
  retry: 'Retry',
  signedOut: {
    title: 'Sign in to get your referral link',
    steps: ['Members with an active plan get one personal link.', 'Friends who sign up through it get a discount on their first order.', 'You earn a commission once their payment clears the hold period.'],
    cta: 'Sign in',
  },
  notEligible: {
    title: 'Referral links are for active members',
    body: 'You need an active plan to share a link. Earned commissions stay payable while your plan is paused.',
    cta: 'See plans',
  },
  locked: 'Your referral account is paused for review. Email hi@zuey.me if you think this is a mistake.',
  tier: {
    title: 'Your rate',
    count: '{n} successful referrals in the last {days} days',
    next: '{n} more to reach {rate}%',
    top: 'You are on the top tier.',
    override: 'Special rate set by Zuey: {rate}%',
    ladder: 'Tiers',
  },
  share: { title: 'Your link', copy: 'Copy link', copied: 'Copied', qr: 'QR code', qrTitle: 'Referral QR code', qrHint: 'Friends scan this to open your referral link.' },
  split: {
    title: 'Split your {rate}%',
    label: 'You earn {mine}% · Friend saves {theirs}%',
    hint: 'Memberships: the friend’s discount applies to their first order (first month on card).',
    booking: 'Consultation booking ({total}% shared the same way): friend saves {theirs}% · you earn {mine}%',
    save: 'Save split', saving: 'Saving…', saved: 'Split saved.',
  },
  optOut: { label: 'Hide my name from the public leaderboard', saved: 'Leaderboard preference saved.' },
  balance: {
    title: 'Earnings',
    pending: 'On hold', approved: 'Approved', processing: 'Being paid', paid: 'Paid out',
    note: 'Next close {date} · minimum payout {min} · commissions are held {days} days before approval.',
  },
  commissions: { title: 'Recent commissions', empty: 'No commissions yet. Share your link to get started.', holdUntil: 'held until {date}' },
  kinds: { billing_order: 'Membership (VietQR)', card_subscription: 'Membership (card)', booking: 'Consultation', course_order: 'Course' } as Record<string, string>,
  statuses: { pending: 'On hold', review: 'Under review', approved: 'Approved', reversed: 'Reversed', blocked: 'Not eligible' } as Record<string, string>,
  payouts: {
    title: 'Payouts', empty: 'No payouts yet.', gross: 'Gross', deduction: 'Deduction', net: 'Net', ref: 'Ref',
    statuses: { pending: 'Being paid', paid: 'Paid', cancelled: 'Cancelled' } as Record<string, string>,
  },
  profile: {
    title: 'Payout details',
    intro: 'Payouts close on day 1 each month and are paid by the 10th. Details are reviewed once; any change needs a new review.',
    methods: { vn_bank: 'Vietnamese bank', paypal: 'PayPal' },
    deductionVn: 'Personal income tax (Thuế TNCN) {pct}',
    deductionPaypal: 'Processing fee & tax {pct}',
    statuses: { none: 'Not set up', draft: 'Draft: upload both ID images', submitted: 'Waiting for review', verified: 'Verified', rejected: 'Rejected' } as Record<string, string>,
    rejected: 'Reason: {reason}',
    fullName: 'Full name (as on ID)', bankName: 'Bank', bankAccount: 'Account number', nationalId: 'CCCD number', address: 'Address',
    paypalEmail: 'PayPal email',
    save: 'Save details', saving: 'Saving…', saved: 'Details saved.',
    idTitle: 'National ID (CCCD) images',
    idPrivacy: 'Stored privately and deleted as soon as Zuey approves your details.',
    front: 'Front', back: 'Back', uploaded: 'Uploaded', missing: 'Not uploaded', upload: 'Choose image', uploading: 'Uploading…',
    idNeedsSave: 'Save your bank details first, then upload both sides.',
    badFile: 'Pick a JPEG, PNG or WebP image up to 5 MB.',
    sessionOnly: 'Payout details can only be changed in the browser while signed in.',
  },
  leaderboard: { title: 'Top referrers', month: 'Month', empty: 'No referrals counted this month yet.', count: '{n} referrals', note: 'Public ranking by paid referred orders. Names are masked; amounts are never shown.' },
};

export type ReferralStrings = typeof en;

const vi: ReferralStrings = {
  title: 'Giới thiệu bạn bè',
  intro: 'Chia sẻ link của bạn: bạn bè được giảm giá đơn đầu tiên, bạn nhận hoa hồng khi họ thanh toán.',
  tabs: { program: 'Chương trình', payout: 'Nhận tiền', leaderboard: 'Bảng xếp hạng' },
  loading: 'Đang tải chương trình giới thiệu…',
  loadFailed: 'Không tải được chương trình giới thiệu.',
  retry: 'Thử lại',
  signedOut: {
    title: 'Đăng nhập để lấy link giới thiệu',
    steps: ['Thành viên có gói đang hoạt động nhận một link riêng.', 'Bạn bè đăng ký qua link được giảm giá đơn đầu tiên.', 'Bạn nhận hoa hồng khi khoản thanh toán qua thời gian giữ.'],
    cta: 'Đăng nhập',
  },
  notEligible: {
    title: 'Link giới thiệu dành cho thành viên đang hoạt động',
    body: 'Bạn cần một gói đang hoạt động để chia sẻ link. Hoa hồng đã có vẫn được chi trả khi gói tạm dừng.',
    cta: 'Xem các gói',
  },
  locked: 'Tài khoản giới thiệu của bạn đang tạm khoá để kiểm tra. Email hi@zuey.me nếu bạn cho rằng có nhầm lẫn.',
  tier: {
    title: 'Mức hoa hồng',
    count: '{n} lượt giới thiệu thành công trong {days} ngày qua',
    next: 'Thêm {n} lượt để lên {rate}%',
    top: 'Bạn đang ở mức cao nhất.',
    override: 'Mức riêng do Zuey đặt: {rate}%',
    ladder: 'Các mức',
  },
  share: { title: 'Link của bạn', copy: 'Sao chép link', copied: 'Đã sao chép', qr: 'Mã QR', qrTitle: 'Mã QR giới thiệu', qrHint: 'Bạn bè quét mã để mở link giới thiệu của bạn.' },
  split: {
    title: 'Chia {rate}% của bạn',
    label: 'Bạn nhận {mine}% · Bạn bè giảm {theirs}%',
    hint: 'Gói thành viên: bạn bè được giảm ở đơn đầu tiên (tháng đầu nếu trả bằng thẻ).',
    booking: 'Đặt lịch tư vấn ({total}% chia theo cùng tỉ lệ): bạn bè giảm {theirs}% · bạn nhận {mine}%',
    save: 'Lưu tỉ lệ', saving: 'Đang lưu…', saved: 'Đã lưu tỉ lệ.',
  },
  optOut: { label: 'Ẩn tên tôi khỏi bảng xếp hạng công khai', saved: 'Đã lưu lựa chọn bảng xếp hạng.' },
  balance: {
    title: 'Thu nhập',
    pending: 'Đang giữ', approved: 'Đã duyệt', processing: 'Đang chi trả', paid: 'Đã nhận',
    note: 'Kỳ chốt tiếp theo {date} · chi trả tối thiểu {min} · hoa hồng được giữ {days} ngày trước khi duyệt.',
  },
  commissions: { title: 'Hoa hồng gần đây', empty: 'Chưa có hoa hồng. Hãy chia sẻ link để bắt đầu.', holdUntil: 'giữ đến {date}' },
  kinds: { billing_order: 'Gói thành viên (VietQR)', card_subscription: 'Gói thành viên (thẻ)', booking: 'Tư vấn', course_order: 'Khoá học' },
  statuses: { pending: 'Đang giữ', review: 'Đang kiểm tra', approved: 'Đã duyệt', reversed: 'Đã hoàn', blocked: 'Không hợp lệ' },
  payouts: {
    title: 'Chi trả', empty: 'Chưa có kỳ chi trả nào.', gross: 'Tổng', deduction: 'Khấu trừ', net: 'Thực nhận', ref: 'Mã GD',
    statuses: { pending: 'Đang chi trả', paid: 'Đã chi trả', cancelled: 'Đã huỷ' },
  },
  profile: {
    title: 'Thông tin nhận tiền',
    intro: 'Kỳ chi trả chốt ngày 1 hằng tháng và được thanh toán trước ngày 10. Thông tin được duyệt một lần; mọi thay đổi cần duyệt lại.',
    methods: { vn_bank: 'Ngân hàng Việt Nam', paypal: 'PayPal' },
    deductionVn: 'Thuế TNCN {pct}',
    deductionPaypal: 'Phí xử lý & thuế {pct}',
    statuses: { none: 'Chưa thiết lập', draft: 'Bản nháp: cần tải đủ 2 mặt CCCD', submitted: 'Đang chờ duyệt', verified: 'Đã xác minh', rejected: 'Bị từ chối' },
    rejected: 'Lý do: {reason}',
    fullName: 'Họ tên (theo CCCD)', bankName: 'Ngân hàng', bankAccount: 'Số tài khoản', nationalId: 'Số CCCD', address: 'Địa chỉ',
    paypalEmail: 'Email PayPal',
    save: 'Lưu thông tin', saving: 'Đang lưu…', saved: 'Đã lưu thông tin.',
    idTitle: 'Ảnh CCCD',
    idPrivacy: 'Lưu riêng tư và bị xoá ngay khi Zuey duyệt thông tin của bạn.',
    front: 'Mặt trước', back: 'Mặt sau', uploaded: 'Đã tải lên', missing: 'Chưa tải lên', upload: 'Chọn ảnh', uploading: 'Đang tải lên…',
    idNeedsSave: 'Lưu thông tin ngân hàng trước, sau đó tải lên cả hai mặt.',
    badFile: 'Hãy chọn ảnh JPEG, PNG hoặc WebP tối đa 5 MB.',
    sessionOnly: 'Chỉ đổi được thông tin nhận tiền trên trình duyệt khi đã đăng nhập.',
  },
  leaderboard: { title: 'Top người giới thiệu', month: 'Tháng', empty: 'Tháng này chưa có lượt giới thiệu nào được tính.', count: '{n} lượt', note: 'Xếp hạng công khai theo số đơn đã thanh toán qua giới thiệu. Tên được che bớt; không hiển thị số tiền.' },
};

export function referralStrings(locale: Locale): ReferralStrings {
  return locale === 'vi' ? vi : en;
}

/** `{name}` placeholder substitution. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in values ? String(values[k]) : m));
}

/** Locale-aware date (Asia/Saigon) for referral lists. */
export function fmtDay(value: string | null, locale: Locale): string {
  if (!value) return '—';
  const d = new Date(value.length === 10 ? `${value}T00:00:00+07:00` : value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'vi' ? 'vi-VN' : 'en-GB', { timeZone: 'Asia/Ho_Chi_Minh', dateStyle: 'medium' }).format(d);
}
