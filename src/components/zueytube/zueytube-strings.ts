/** UI strings for the Zueytube window/page. Vietnamese and English; other locales use English. */
import type { Locale } from '../../lib/i18n/locales';

const vi = {
  title: 'Zueytube',
  subtitle: 'Video tuyển chọn từ kênh YouTube của Zuey — xem ngay tại đây, kèm transcript và bài viết liên quan.',
  subscribe: 'Đăng ký kênh',
  channel: 'Kênh YouTube',
  search: 'Tìm video, kể cả nội dung trong transcript…',
  searchLabel: 'Tìm video',
  empty: 'Chưa có video nào. Quay lại sau nhé!',
  noMatch: 'Không có video phù hợp.',
  transcriptMatches: 'Khớp trong transcript',
  back: '← Tất cả video',
  watchOnYoutube: 'Xem trên YouTube',
  transcript: 'Transcript',
  transcriptFilter: 'Lọc transcript…',
  transcriptPending: 'Transcript đang được lấy.',
  transcriptUnavailable: 'Video này chưa có phụ đề nên chưa có transcript.',
  transcriptFailed: 'Chưa lấy được transcript cho video này.',
  related: 'Bài viết liên quan',
  noRelated: 'Chưa có bài viết liên quan.',
  loading: 'Đang tải…',
  loadFailed: 'Không tải được video. Thử lại sau.',
  showMore: 'Xem thêm',
  showLess: 'Thu gọn',
  language: 'Ngôn ngữ',
  members: 'Thành viên',
  jumpTo: 'Tua tới',
};

export type ZueytubeStrings = typeof vi;

const en: ZueytubeStrings = {
  title: 'Zueytube',
  subtitle: "Curated videos from Zuey's YouTube channel — watch here, with transcripts and related articles.",
  subscribe: 'Subscribe',
  channel: 'YouTube channel',
  search: 'Search videos, including what is said in them…',
  searchLabel: 'Search videos',
  empty: 'No videos yet — check back soon.',
  noMatch: 'No matching videos.',
  transcriptMatches: 'Transcript matches',
  back: '← All videos',
  watchOnYoutube: 'Watch on YouTube',
  transcript: 'Transcript',
  transcriptFilter: 'Filter transcript…',
  transcriptPending: 'The transcript is being fetched.',
  transcriptUnavailable: 'This video has no captions yet, so there is no transcript.',
  transcriptFailed: 'The transcript could not be fetched yet.',
  related: 'Related articles',
  noRelated: 'No related articles yet.',
  loading: 'Loading…',
  loadFailed: 'Could not load the video. Try again later.',
  showMore: 'Show more',
  showLess: 'Show less',
  language: 'Language',
  members: 'Members',
  jumpTo: 'Jump to',
};

export function zueytubeStrings(locale: Locale | string): ZueytubeStrings {
  return locale === 'vi' ? vi : en;
}

export function formatVideoDate(value: string | null, locale: string): string {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-US', { timeZone: 'Asia/Saigon', year: 'numeric', month: 'short', day: 'numeric' });
}
