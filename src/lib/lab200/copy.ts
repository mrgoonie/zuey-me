import type { Locale } from '../i18n/locales';

/** Who writes the 200lab courses; shown under the intro with a link to NextLevelBuilder. */
export const LAB200_AUTHOR = {
  name: 'Việt Trần',
  company: 'NextLevelBuilder.io',
  companyUrl: 'https://nextlevelbuilder.io',
};

/** Interface copy for the 200lab app and /200lab.md. Course titles and summaries stay in Vietnamese. */
const vi = {
  title: '200lab',
  kicker: 'Duy giới thiệu',
  heading: 'Khoá học 200lab',
  results: (n: number) => `${n} khoá học`,
  code: 'Mã giới thiệu',
  intro:
    'Mình hay giới thiệu các khoá học của 200lab cho anh em muốn làm chủ AI và thiết kế hệ thống: học qua bài toán thật, có checkpoint rõ ràng và dạy cách giao việc cho AI có kiểm soát.',
  author: {
    before: 'Các khoá học do ',
    after: ' soạn — Solution Architect, đồng sáng lập cùng mình tại ',
  },
  discount: 'Giảm 20% khi mua qua các link dưới đây',
  featured: 'Duy gợi ý',
  all: 'Tất cả khoá học',
  lessons: (n: number) => `${n} bài học`,
  view: 'Xem khoá học',
  free: 'Miễn phí',
  basePrice: 'Giá gốc',
  refPrice: 'Qua link này',
  priceFrom: 'từ',
  priceNote: 'Giá qua link đã trừ 20% trên giá 200lab đang bán; số tiền cuối cùng hiển thị khi thanh toán trên 200lab.',
  empty: 'Chưa tải được danh sách khoá học. Bạn vẫn có thể xem trực tiếp trên 200lab.io.',
  openSite: 'Mở 200lab.io',
  updated: (when: string) => `Cập nhật lúc ${when}`,
  disclosure: 'Duy nhận hoa hồng giới thiệu khi bạn mua qua các link này.',
  back: '← zuey.me',
};

type Lab200Copy = typeof vi;

const en: Lab200Copy = {
  title: '200lab',
  kicker: 'Recommended by Duy',
  heading: '200lab courses',
  results: (n: number) => `${n} courses`,
  code: 'Referral code',
  intro:
    'I often recommend 200lab courses to people who want to master AI and system design: they teach through real problems, with clear checkpoints and a controlled way to hand work to AI.',
  author: {
    before: 'The courses are written by ',
    after: ', Solution Architect and my co-founder at ',
  },
  discount: '20% off when you buy through the links below',
  featured: "Duy's picks",
  all: 'All courses',
  lessons: (n: number) => `${n} lessons`,
  view: 'View course',
  free: 'Free',
  basePrice: 'Regular price',
  refPrice: 'Through this link',
  priceFrom: 'from',
  priceNote: "Link prices take 20% off 200lab's current price; 200lab shows the final amount at checkout.",
  empty: 'The course list could not be loaded. You can still browse it on 200lab.io.',
  openSite: 'Open 200lab.io',
  updated: (when: string) => `Updated ${when}`,
  disclosure: 'Duy earns a referral commission when you buy through these links.',
  back: '← zuey.me',
};

export function lab200Copy(locale: Locale): Lab200Copy {
  return locale === 'vi' ? vi : en;
}
