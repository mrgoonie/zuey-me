import type { Locale } from '../i18n/locales';

/** Who writes the 200lab courses; shown under the intro with a link to NextLevelBuilder. */
export const LAB200_AUTHOR = {
  name: 'Việt Trần',
  company: 'NextLevelBuilder.io',
  companyUrl: 'https://nextlevelbuilder.io',
};

/**
 * Interface copy for the 200lab app and /200lab.md. Course and learning-path text comes from 200lab
 * in the locale its feed reports (Vietnamese today) and is never translated here.
 */
const vi = {
  title: '200lab',
  kicker: 'Duy giới thiệu',
  heading: 'Khoá học 200lab',
  tabs: 'Danh mục 200lab',
  coursesTab: 'Khóa học',
  pathsTab: 'Lộ trình',
  code: 'Mã giới thiệu',
  intro:
    'Mình hay giới thiệu các khoá học của 200lab cho anh em muốn làm chủ AI và thiết kế hệ thống: học qua bài toán thật, có checkpoint rõ ràng và dạy cách giao việc cho AI có kiểm soát.',
  author: {
    before: 'Các khoá học do ',
    after: ' soạn — Solution Architect, đồng sáng lập cùng mình tại ',
  },
  offerBadge: '−20%',
  discount: 'Giảm 20% khi mua qua các link dưới đây',
  featured: 'Duy gợi ý',
  allCourses: 'Tất cả khoá học',
  allPaths: 'Tất cả lộ trình',
  courses: (n: number) => `${n} khoá học`,
  paths: (n: number) => `${n} lộ trình`,
  lessons: (n: number) => `${n} bài học`,
  pathCourses: (n: number) => `${n} khoá học`,
  viewCourse: 'Xem khoá học',
  viewPath: 'Xem lộ trình',
  viewOnSite: 'Xem trên 200lab',
  free: 'Miễn phí',
  priceFrom: 'từ',
  compareAt: 'Giá so sánh',
  unavailable: 'Chưa mở bán',
  priceOnSite: 'Xem giá trên 200lab',
  priceNote:
    'Giá là giá 200lab đang bán; giá gạch ngang là giá so sánh do 200lab công bố. Ưu đãi của mã giới thiệu và số tiền cuối cùng do 200lab xác nhận khi thanh toán.',
  emptyCourses: 'Chưa tải được danh sách khoá học. Bạn vẫn có thể xem trực tiếp trên 200lab.io.',
  emptyPaths: 'Chưa tải được danh sách lộ trình. Bạn vẫn có thể xem trực tiếp trên 200lab.io.',
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
  tabs: '200lab catalog',
  coursesTab: 'Courses',
  pathsTab: 'Learning paths',
  code: 'Referral code',
  intro:
    'I often recommend 200lab courses to people who want to master AI and system design: they teach through real problems, with clear checkpoints and a controlled way to hand work to AI.',
  author: {
    before: 'The courses are written by ',
    after: ', Solution Architect and my co-founder at ',
  },
  offerBadge: '−20%',
  discount: '20% off when you buy through the links below',
  featured: "Duy's picks",
  allCourses: 'All courses',
  allPaths: 'All learning paths',
  courses: (n: number) => `${n} ${n === 1 ? 'course' : 'courses'}`,
  paths: (n: number) => `${n} ${n === 1 ? 'learning path' : 'learning paths'}`,
  lessons: (n: number) => `${n} ${n === 1 ? 'lesson' : 'lessons'}`,
  pathCourses: (n: number) => `${n} ${n === 1 ? 'course' : 'courses'}`,
  viewCourse: 'View course',
  viewPath: 'View path',
  viewOnSite: 'View on 200lab',
  free: 'Free',
  priceFrom: 'from',
  compareAt: 'Compare at',
  unavailable: 'Not on sale',
  priceOnSite: 'See the price on 200lab',
  priceNote:
    "Prices are 200lab's current prices; struck-through amounts are 200lab's own comparison prices. 200lab confirms the referral discount and the final amount at checkout.",
  emptyCourses: 'The course list could not be loaded. You can still browse it on 200lab.io.',
  emptyPaths: 'The learning paths could not be loaded. You can still browse them on 200lab.io.',
  openSite: 'Open 200lab.io',
  updated: (when: string) => `Updated ${when}`,
  disclosure: 'Duy earns a referral commission when you buy through these links.',
  back: '← zuey.me',
};

export function lab200Copy(locale: Locale): Lab200Copy {
  return locale === 'vi' ? vi : en;
}
