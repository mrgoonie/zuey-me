import type { ActivityCategory, OwnerPublicStatus } from '../../lib/presence/contract';
import type { Locale } from '../../lib/i18n/locales';
import type { FeedConnection } from '../../lib/presence/presence-feed';

/** Copy of the Activity Monitor panel (the app title itself lives in os-i18n `apps`). */
const en = {
  heading: 'Who is on zuey.me right now',
  connection: {
    connecting: 'Connecting…',
    live: 'Live',
    reconnecting: 'Reconnecting…',
    polling: 'Periodic updates',
    offline: 'Offline',
    unavailable: 'Unavailable',
  } satisfies Record<FeedConnection, string>,
  stale: 'No recent updates',
  updated: (s: number) => (s < 5 ? 'updated just now' : s < 60 ? `updated ${s}s ago` : `updated ${Math.floor(s / 60)}m ago`),
  noUpdateYet: 'No data received yet',
  kpi: {
    active: 'Active now',
    members: 'Members',
    membersHidden: 'fewer than 3',
    membersHiddenHint: 'Hidden below 3 so no one can be singled out.',
    owner: 'Zuey (the real one)',
  },
  owner: {
    status: { online: 'Online', away: 'Away', busy: 'Busy', offline: 'Offline' } satisfies Record<OwnerPublicStatus, string>,
    onSite: 'On zuey.me right now',
    notOnSite: 'Not on zuey.me',
  },
  categories: {
    title: 'What they are doing',
    names: {
      reading: 'Reading articles',
      zueytube: 'Watching Zueytube',
      reads: 'Browsing Zuey Reads',
      ai: 'Chatting with Zuey AI',
      courses: 'Learning in courses',
      exploring: 'Exploring the site',
      other: 'Other',
    } satisfies Record<ActivityCategory, string>,
    hidden: 'Groups smaller than 3 are hidden to keep visitors anonymous, so there is no breakdown yet.',
    nobody: 'Nobody else is here right now.',
  },
  reason: {
    connecting: 'Connecting to the live feed…',
    offline: 'You appear to be offline. Retrying automatically.',
    unavailable: 'The live feed is not available right now. Retrying automatically.',
    reconnecting: 'Connection lost, retrying. The numbers below may be out of date.',
    polling: 'Live updates are paused; the numbers refresh about every 20 seconds.',
  },
  noData: 'No data yet',
  note: 'Counts are approximate and anonymous. Only a coarse activity type is shared, never pages, names or identifiers, and only for visitors who allowed analytics.',
  privacy: 'Privacy',
  announce: (n: number) => `${n} active ${n === 1 ? 'visitor' : 'visitors'}`,
};

export type ActivityMonitorStrings = typeof en;

const vi: ActivityMonitorStrings = {
  heading: 'Ai đang ở zuey.me lúc này',
  connection: {
    connecting: 'Đang kết nối…',
    live: 'Trực tiếp',
    reconnecting: 'Đang kết nối lại…',
    polling: 'Cập nhật định kỳ',
    offline: 'Ngoại tuyến',
    unavailable: 'Chưa khả dụng',
  },
  stale: 'Chưa có cập nhật mới',
  updated: (s) => (s < 5 ? 'vừa cập nhật' : s < 60 ? `cập nhật ${s}s trước` : `cập nhật ${Math.floor(s / 60)} phút trước`),
  noUpdateYet: 'Chưa nhận được dữ liệu',
  kpi: {
    active: 'Đang hoạt động',
    members: 'Thành viên',
    membersHidden: 'ít hơn 3',
    membersHiddenHint: 'Ẩn khi dưới 3 để không ai bị nhận diện riêng lẻ.',
    owner: 'Zuey (người thật)',
  },
  owner: {
    status: { online: 'Trực tuyến', away: 'Vắng mặt', busy: 'Bận', offline: 'Ngoại tuyến' },
    onSite: 'Đang ở zuey.me',
    notOnSite: 'Không ở zuey.me',
  },
  categories: {
    title: 'Mọi người đang làm gì',
    names: {
      reading: 'Đọc bài viết',
      zueytube: 'Xem Zueytube',
      reads: 'Duyệt Zuey Reads',
      ai: 'Trò chuyện với Zuey AI',
      courses: 'Học khóa học',
      exploring: 'Khám phá trang web',
      other: 'Khác',
    },
    hidden: 'Nhóm dưới 3 người được ẩn để giữ ẩn danh cho khách, nên chưa có phân loại.',
    nobody: 'Hiện chưa có ai khác ở đây.',
  },
  reason: {
    connecting: 'Đang kết nối tới luồng trực tiếp…',
    offline: 'Có vẻ bạn đang ngoại tuyến. Sẽ tự thử lại.',
    unavailable: 'Luồng trực tiếp hiện chưa khả dụng. Sẽ tự thử lại.',
    reconnecting: 'Mất kết nối, đang thử lại. Số liệu bên dưới có thể đã cũ.',
    polling: 'Cập nhật trực tiếp đang tạm dừng; số liệu được làm mới khoảng mỗi 20 giây.',
  },
  noData: 'Chưa có dữ liệu',
  note: 'Số liệu chỉ mang tính ước lượng và ẩn danh. Chỉ chia sẻ loại hoạt động chung chung, không bao giờ là trang, tên hay mã định danh, và chỉ với khách đã cho phép phân tích.',
  privacy: 'Quyền riêng tư',
  announce: (n) => `${n} người đang hoạt động`,
};

const zh: ActivityMonitorStrings = {
  heading: '此刻谁在 zuey.me',
  connection: { connecting: '连接中…', live: '实时', reconnecting: '正在重新连接…', polling: '定期更新', offline: '离线', unavailable: '暂不可用' },
  stale: '近期无更新',
  updated: (s) => (s < 5 ? '刚刚更新' : s < 60 ? `${s} 秒前更新` : `${Math.floor(s / 60)} 分钟前更新`),
  noUpdateYet: '尚未收到数据',
  kpi: {
    active: '当前活跃',
    members: '会员',
    membersHidden: '少于 3',
    membersHiddenHint: '少于 3 时隐藏，避免识别到个人。',
    owner: 'Zuey（本人）',
  },
  owner: {
    status: { online: '在线', away: '离开', busy: '忙碌', offline: '离线' },
    onSite: '正在 zuey.me',
    notOnSite: '不在 zuey.me',
  },
  categories: {
    title: '大家在做什么',
    names: {
      reading: '阅读文章',
      zueytube: '观看 Zueytube',
      reads: '浏览 Zuey 阅读',
      ai: '与 Zuey AI 聊天',
      courses: '学习课程',
      exploring: '浏览网站',
      other: '其他',
    },
    hidden: '少于 3 人的分组会被隐藏以保护访客匿名，因此暂无分类。',
    nobody: '目前没有其他人。',
  },
  reason: {
    connecting: '正在连接实时数据…',
    offline: '你似乎已离线，将自动重试。',
    unavailable: '实时数据暂不可用，将自动重试。',
    reconnecting: '连接中断，正在重试。下方数字可能已过期。',
    polling: '实时更新已暂停，数字约每 20 秒刷新一次。',
  },
  noData: '暂无数据',
  note: '数字为近似值且匿名。仅共享粗略的活动类型，绝不包含页面、姓名或标识符，且仅限允许分析的访客。',
  privacy: '隐私',
  announce: (n) => `${n} 位活跃访客`,
};

const ko: ActivityMonitorStrings = {
  heading: '지금 zuey.me에 있는 사람',
  connection: { connecting: '연결 중…', live: '실시간', reconnecting: '다시 연결 중…', polling: '주기적 업데이트', offline: '오프라인', unavailable: '사용 불가' },
  stale: '최근 업데이트 없음',
  updated: (s) => (s < 5 ? '방금 업데이트됨' : s < 60 ? `${s}초 전 업데이트` : `${Math.floor(s / 60)}분 전 업데이트`),
  noUpdateYet: '아직 받은 데이터가 없습니다',
  kpi: {
    active: '현재 활동 중',
    members: '회원',
    membersHidden: '3명 미만',
    membersHiddenHint: '3명 미만이면 개인이 특정되지 않도록 숨깁니다.',
    owner: 'Zuey (본인)',
  },
  owner: {
    status: { online: '온라인', away: '자리 비움', busy: '바쁨', offline: '오프라인' },
    onSite: '지금 zuey.me에 있음',
    notOnSite: 'zuey.me에 없음',
  },
  categories: {
    title: '무엇을 하고 있나요',
    names: {
      reading: '글 읽는 중',
      zueytube: 'Zueytube 시청 중',
      reads: 'Zuey 리즈 둘러보는 중',
      ai: 'Zuey AI와 대화 중',
      courses: '강의 수강 중',
      exploring: '사이트 둘러보는 중',
      other: '기타',
    },
    hidden: '3명 미만의 그룹은 방문자 익명성을 위해 숨겨지므로 아직 분류가 없습니다.',
    nobody: '지금은 다른 사람이 없습니다.',
  },
  reason: {
    connecting: '실시간 피드에 연결하는 중…',
    offline: '오프라인 상태로 보입니다. 자동으로 다시 시도합니다.',
    unavailable: '실시간 피드를 지금 사용할 수 없습니다. 자동으로 다시 시도합니다.',
    reconnecting: '연결이 끊어져 다시 시도 중입니다. 아래 수치는 오래된 것일 수 있습니다.',
    polling: '실시간 업데이트가 일시 중지되었습니다. 수치는 약 20초마다 새로 고쳐집니다.',
  },
  noData: '아직 데이터 없음',
  note: '수치는 대략적이며 익명입니다. 대략적인 활동 유형만 공유하며 페이지, 이름, 식별자는 절대 공유하지 않고 분석을 허용한 방문자에게만 해당합니다.',
  privacy: '개인정보',
  announce: (n) => `활동 중인 방문자 ${n}명`,
};

const ja: ActivityMonitorStrings = {
  heading: '今 zuey.me にいる人',
  connection: { connecting: '接続中…', live: 'ライブ', reconnecting: '再接続中…', polling: '定期更新', offline: 'オフライン', unavailable: '利用不可' },
  stale: '最近の更新なし',
  updated: (s) => (s < 5 ? 'たった今更新' : s < 60 ? `${s}秒前に更新` : `${Math.floor(s / 60)}分前に更新`),
  noUpdateYet: 'まだデータを受信していません',
  kpi: {
    active: '現在アクティブ',
    members: 'メンバー',
    membersHidden: '3 人未満',
    membersHiddenHint: '個人が特定されないよう、3 人未満は表示しません。',
    owner: 'Zuey（本人）',
  },
  owner: {
    status: { online: 'オンライン', away: '離席中', busy: '取り込み中', offline: 'オフライン' },
    onSite: '今 zuey.me にいます',
    notOnSite: 'zuey.me にいません',
  },
  categories: {
    title: '何をしているか',
    names: {
      reading: '記事を読んでいる',
      zueytube: 'Zueytube を視聴中',
      reads: 'Zuey Reads を閲覧中',
      ai: 'Zuey AI とチャット中',
      courses: 'コースで学習中',
      exploring: 'サイトを見て回っている',
      other: 'その他',
    },
    hidden: '3 人未満のグループは訪問者の匿名性を守るため非表示のため、内訳はまだありません。',
    nobody: '今は他に誰もいません。',
  },
  reason: {
    connecting: 'ライブフィードに接続しています…',
    offline: 'オフラインのようです。自動的に再試行します。',
    unavailable: 'ライブフィードは現在利用できません。自動的に再試行します。',
    reconnecting: '接続が切れました。再試行中です。以下の数値は古い可能性があります。',
    polling: 'リアルタイム更新は一時停止中です。数値は約20秒ごとに更新されます。',
  },
  noData: 'データなし',
  note: '数値は概算で匿名です。共有されるのは大まかな活動の種類のみで、ページ・名前・識別子は一切含まれず、分析を許可した訪問者のみが対象です。',
  privacy: 'プライバシー',
  announce: (n) => `アクティブな訪問者 ${n} 人`,
};

const STRINGS: Record<Locale, ActivityMonitorStrings> = { en, vi, zh, ko, ja };

export const activityMonitorStrings = (locale: Locale): ActivityMonitorStrings => STRINGS[locale];
