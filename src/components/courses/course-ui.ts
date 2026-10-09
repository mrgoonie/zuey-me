// Shared copy, formatting and a course-aware JSON client for the learner-facing course pages.
import type { ApiResult } from '../members/member-ui';
import { callApi } from '../members/member-ui';

/** Vietnamese copy for error codes the course APIs return; falls back to the member copy / server message. */
const COURSE_ERROR_COPY: Record<string, string> = {
  terms_required: 'Bạn cần đồng ý Điều khoản sử dụng và Chính sách (không hoàn tiền) để mua khoá học.',
  already_owned: 'Bạn đã sở hữu khoá học này.',
  not_for_sale: 'Khoá học này hiện chưa mở bán.',
  account_locked: 'Quyền truy cập khoá học trên tài khoản này đang tạm dừng để kiểm tra. Vui lòng email hi@zuey.me.',
  amount_too_small: 'Giá này quá nhỏ để thanh toán bằng thẻ; vui lòng chọn chuyển khoản VietQR.',
  referral_code_invalid: 'Mã giới thiệu này không áp dụng được cho đơn hàng của bạn.',
  discount_code_invalid: 'Không tìm thấy mã ưu đãi hoặc mã giới thiệu này.',
  course_not_found: 'Không tìm thấy khoá học.',
  lesson_not_found: 'Không tìm thấy bài học.',
  lesson_sign_in: 'Vui lòng đăng nhập và mua khoá học để mở bài này.',
  lesson_purchase: 'Mua khoá học để mở khoá bài này.',
  lesson_locked: 'Quyền truy cập khoá học trên tài khoản này đang tạm dừng để kiểm tra. Vui lòng email hi@zuey.me.',
  lesson_browser_only: 'Bài trả phí chỉ đọc được trong trình duyệt đã đăng nhập tại zuey.me.',
  lesson_not_published: 'Bài học chưa được xuất bản.',
  media_unconfigured: 'Nội dung media chưa sẵn sàng. Vui lòng thử lại sau.',
  asset_not_found: 'Không tìm thấy tệp media của bài học.',
  quiz_not_found: 'Không tìm thấy bài kiểm tra này.',
  purchase_required: 'Mua khoá học để truy cập kho mã nguồn.',
  rate_limited: 'Bạn thao tác quá nhanh. Vui lòng đợi một chút rồi thử lại.',
  unauthorized: 'Vui lòng đăng nhập để tiếp tục.',
};

export function courseErrorText(code: string, message: string): string {
  return COURSE_ERROR_COPY[code] ?? message;
}

/** callApi with course-specific Vietnamese error copy. */
export async function courseApi(url: string, init?: RequestInit): Promise<ApiResult> {
  const res = await callApi(url, init);
  return res.ok ? res : { ...res, message: courseErrorText(res.code, res.message) };
}

export function lessonApiBase(courseSlug: string, lessonSlug: string): string {
  return `/api/v1/courses/${encodeURIComponent(courseSlug)}/lessons/${encodeURIComponent(lessonSlug)}`;
}

export const LEVEL_LABELS: Record<string, string> = {
  beginner: 'Cơ bản',
  intermediate: 'Trung cấp',
  advanced: 'Nâng cao',
};

export function levelLabel(level: string): string {
  return LEVEL_LABELS[level] ?? level;
}

/** "1 giờ 25 phút" / "40 phút". */
export function fmtMinutes(total: number): string {
  if (total <= 0) return '—';
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} phút`;
  return m === 0 ? `${h} giờ` : `${h} giờ ${m} phút`;
}

/** Shared visual tokens of the course pages (match member-ui). */
export const pill = 'inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide';
export const focusRing = 'focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2';
export const widgetCard = 'not-prose my-6 rounded-2xl border border-stone-300 bg-white/80 p-4 sm:p-5 text-stone-900';
