import type { Locale } from '../../lib/i18n/locales';

/** Copy of the Activity Monitor's 24h history chart (kept apart from the live panel strings). */
const en = {
  title: 'Last 24 hours',
  subtitle: 'Peak visitors per 5 minutes, in your local time',
  loading: 'Loading the last 24 hours…',
  unavailable: 'History unavailable right now. The live numbers above are not affected.',
  empty: 'No visitors in the last 24 hours.',
  peak: (n: string) => `Peak: ${n}`,
  noBucket: 'No data for this slot',
  chartLabel: (max: string, at: string) => `Peak visitors over the last 24 hours. Highest: ${max} at ${at}.`,
  keyboardHint: 'Use the arrow keys, Home and End to move through the day.',
  breakdown: 'During this slot',
};

export type ActivityHistoryStrings = typeof en;

const vi: ActivityHistoryStrings = {
  title: '24 giờ qua',
  subtitle: 'Số khách cao nhất mỗi 5 phút, theo giờ địa phương của bạn',
  loading: 'Đang tải dữ liệu 24 giờ qua…',
  unavailable: 'Chưa xem được lịch sử lúc này. Số liệu trực tiếp phía trên không bị ảnh hưởng.',
  empty: 'Không có khách nào trong 24 giờ qua.',
  peak: (n) => `Cao nhất: ${n}`,
  noBucket: 'Không có dữ liệu cho khoảng này',
  chartLabel: (max, at) => `Số khách cao nhất trong 24 giờ qua. Đỉnh: ${max} lúc ${at}.`,
  keyboardHint: 'Dùng phím mũi tên, Home và End để di chuyển trong ngày.',
  breakdown: 'Trong khoảng này',
};

const zh: ActivityHistoryStrings = {
  title: '过去 24 小时',
  subtitle: '每 5 分钟的访客峰值，按你的本地时间显示',
  loading: '正在加载过去 24 小时…',
  unavailable: '暂时无法查看历史。上方的实时数字不受影响。',
  empty: '过去 24 小时没有访客。',
  peak: (n) => `峰值：${n}`,
  noBucket: '此时段没有数据',
  chartLabel: (max, at) => `过去 24 小时的访客峰值。最高：${at} 时 ${max} 人。`,
  keyboardHint: '使用方向键、Home 和 End 在一天中移动。',
  breakdown: '此时段内',
};

const ko: ActivityHistoryStrings = {
  title: '지난 24시간',
  subtitle: '5분 단위 최대 방문자 수, 사용자의 현지 시간 기준',
  loading: '지난 24시간 기록을 불러오는 중…',
  unavailable: '지금은 기록을 볼 수 없습니다. 위의 실시간 수치에는 영향이 없습니다.',
  empty: '지난 24시간 동안 방문자가 없었습니다.',
  peak: (n) => `최대: ${n}`,
  noBucket: '이 구간의 데이터가 없습니다',
  chartLabel: (max, at) => `지난 24시간 최대 방문자 수. 최고: ${at}에 ${max}명.`,
  keyboardHint: '화살표 키, Home, End로 하루를 이동하세요.',
  breakdown: '이 구간 동안',
};

const ja: ActivityHistoryStrings = {
  title: '過去 24 時間',
  subtitle: '5 分ごとの最大訪問者数（あなたの現地時間）',
  loading: '過去 24 時間を読み込み中…',
  unavailable: '現在は履歴を表示できません。上のライブの数値には影響しません。',
  empty: '過去 24 時間に訪問者はいませんでした。',
  peak: (n) => `最大：${n}`,
  noBucket: 'この時間帯のデータはありません',
  chartLabel: (max, at) => `過去 24 時間の最大訪問者数。最高：${at} に ${max} 人。`,
  keyboardHint: '矢印キー、Home、End で一日の中を移動できます。',
  breakdown: 'この時間帯',
};

const STRINGS: Record<Locale, ActivityHistoryStrings> = { en, vi, zh, ko, ja };

export const activityHistoryStrings = (locale: Locale): ActivityHistoryStrings => STRINGS[locale];
