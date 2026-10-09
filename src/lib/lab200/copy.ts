import type { Locale } from '../i18n/locales';

/** Interface copy for the 200lab app and /200lab.md. Course titles and summaries stay in Vietnamese. */
const vi = {
  title: '200lab',
  intro:
    'Mình hay giới thiệu các khoá học của 200lab cho anh em muốn làm chủ AI và thiết kế hệ thống: học qua bài toán thật, có checkpoint rõ ràng và dạy cách giao việc cho AI có kiểm soát.',
  discount: 'Giảm 20% khi mua qua các link dưới đây',
  featured: 'Duy gợi ý',
  all: 'Tất cả khoá học',
  lessons: (n: number) => `${n} bài học`,
  view: 'Xem khoá học',
  free: 'Miễn phí',
  empty: 'Chưa tải được danh sách khoá học. Bạn vẫn có thể xem trực tiếp trên 200lab.io.',
  openSite: 'Mở 200lab.io',
  updated: (when: string) => `Cập nhật lúc ${when}`,
  disclosure: 'Duy nhận hoa hồng giới thiệu khi bạn mua qua các link này.',
  back: '← zuey.me',
};

type Lab200Copy = typeof vi;

const en: Lab200Copy = {
  title: '200lab',
  intro:
    'I often recommend 200lab courses to people who want to master AI and system design: they teach through real problems, with clear checkpoints and a controlled way to hand work to AI.',
  discount: '20% off when you buy through the links below',
  featured: "Duy's picks",
  all: 'All courses',
  lessons: (n: number) => `${n} lessons`,
  view: 'View course',
  free: 'Free',
  empty: 'The course list could not be loaded. You can still browse it on 200lab.io.',
  openSite: 'Open 200lab.io',
  updated: (when: string) => `Updated ${when}`,
  disclosure: 'Duy earns a referral commission when you buy through these links.',
  back: '← zuey.me',
};

export function lab200Copy(locale: Locale): Lab200Copy {
  return locale === 'vi' ? vi : en;
}
