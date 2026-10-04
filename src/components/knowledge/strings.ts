import type { Locale } from '../../lib/i18n/locales';

/** Reader-facing UI strings for Zuey's Knowledges (article content itself is never machine-translated). */
export interface KnowledgeStrings {
  sectionTitle: string;
  sectionLead: string;
  back: string;
  searchAndFilter: string;
  searchLabel: string;
  searchPlaceholder: string;
  category: string;
  all: string;
  labelsAndFreshness: string;
  anyLabel: string;
  tags: string;
  sort: string;
  sortNew: string;
  sortOld: string;
  sortTitle: string;
  sortRelevance: string;
  apply: string;
  reset: string;
  results: (n: number) => string;
  noResults: string;
  noArticles: string;
  viewAll: string;
  membersBadge: string;
  paidAria: string;
  freeAria: string;
  minutes: (n: number) => string;
  markdown: string;
  alsoIn: string;
  fallbackNotice: (requested: string, shown: string) => string;
  draftPreview: (revision: number) => string;
  lockedTitle: string;
  lockedBody: string;
  /** Size of the withheld part: locked section count (0 when it has no headings) and reading minutes. */
  lockedMore: (sections: number, minutes: number) => string;
  /** Screen-reader note on each blurred locked heading. */
  lockedSection: string;
  seePlans: string;
  signIn: string;
  openInNewTab: string;
  share: string;
  copyMarkdown: string;
  copyMarkdownUrl: string;
  copyFullPrivate: string;
  copyFullHint: string;
  copied: string;
  copyFailed: string;
  askAi: (name: string) => string;
  aiPrompt: (url: string) => string;
  nativeShare: string;
  notFoundTitle: string;
  notFoundBody: string;
  semanticOff: string;
  loading: string;
  loadFailed: string;
}

const vi: KnowledgeStrings = {
  sectionTitle: "Zuey's Knowledges",
  sectionLead: 'Ghi chép, biểu đồ, sơ đồ và khảo sát của Duy Nguyen.',
  back: '← zuey.me',
  searchAndFilter: 'Tìm & lọc',
  searchLabel: 'Tìm bài viết',
  searchPlaceholder: 'Tìm theo chủ đề, công cụ…',
  category: 'Chuyên mục',
  all: 'Tất cả',
  labelsAndFreshness: 'Nhãn & độ cập nhật',
  anyLabel: 'Mọi nhãn',
  tags: 'Thẻ',
  sort: 'Sắp xếp',
  sortNew: 'Mới nhất',
  sortOld: 'Cũ nhất',
  sortTitle: 'A–Z',
  sortRelevance: 'Liên quan nhất',
  apply: 'Áp dụng',
  reset: 'Đặt lại',
  results: n => `${n} bài`,
  noResults: 'Không có bài nào khớp bộ lọc. Thử bỏ bớt điều kiện.',
  noArticles: 'Chưa có bài viết nào được xuất bản.',
  viewAll: 'Xem tất cả bài viết',
  membersBadge: 'Knowledges',
  paidAria: 'Bài trả phí, đọc preview khoảng một phần ba',
  freeAria: 'Bài miễn phí',
  minutes: n => `${n} phút`,
  markdown: 'Markdown',
  alsoIn: 'Cũng có bằng',
  fallbackNotice: (r, s) => `Bài này chưa có bản ${r}; đang hiển thị bản ${s}.`,
  draftPreview: r => `Bản xem trước bản nháp (revision ${r}) — chỉ quản trị viên thấy.`,
  lockedTitle: 'Phần còn lại dành cho thành viên Knowledges',
  lockedBody: 'Bạn đang đọc khoảng một phần ba đầu bài. Các gói Knowledges, Kết hợp và Cộng đồng mở toàn bộ bài viết trả phí; gói Zuey AI chỉ đọc phần preview.',
  seePlans: 'Xem các gói',
  signIn: 'Đăng nhập',
  lockedMore: (s, m) => (s > 0 ? `Còn ${s} phần nữa (khoảng ${m} phút đọc) dành cho thành viên` : `Còn khoảng ${m} phút đọc dành cho thành viên`),
  lockedSection: 'Phần bị khoá',
  openInNewTab: 'Mở trong thẻ mới',
  share: 'Chia sẻ',
  copyMarkdown: 'Sao chép Markdown',
  copyMarkdownUrl: 'Sao chép link Markdown',
  copyFullPrivate: 'Sao chép toàn văn (riêng tư)',
  copyFullHint: 'Chỉ dùng cho bạn; đừng chia sẻ phần trả phí.',
  copied: 'Đã sao chép',
  copyFailed: 'Không sao chép được',
  askAi: n => `Hỏi ${n} về bài này`,
  aiPrompt: url => `Đọc và tóm tắt bài viết công khai này, sau đó trả lời câu hỏi của tôi: ${url}`,
  nativeShare: 'Chia sẻ…',
  notFoundTitle: 'Không tìm thấy bài viết',
  notFoundBody: 'Bài viết không tồn tại hoặc chưa được xuất bản.',
  semanticOff: 'Tìm theo từ khoá',
  loading: 'Đang tải…',
  loadFailed: 'Không tải được danh sách bài.',
};

const en: KnowledgeStrings = {
  sectionTitle: "Zuey's Knowledges",
  sectionLead: 'Notes, charts, diagrams and surveys by Duy Nguyen.',
  back: '← zuey.me',
  searchAndFilter: 'Search & filter',
  searchLabel: 'Search articles',
  searchPlaceholder: 'Search topics, tools…',
  category: 'Category',
  all: 'All',
  labelsAndFreshness: 'Labels & freshness',
  anyLabel: 'Any label',
  tags: 'Tags',
  sort: 'Sort',
  sortNew: 'Newest',
  sortOld: 'Oldest',
  sortTitle: 'A–Z',
  sortRelevance: 'Most relevant',
  apply: 'Apply',
  reset: 'Reset',
  results: n => `${n} ${n === 1 ? 'article' : 'articles'}`,
  noResults: 'No articles match these filters. Try removing some.',
  noArticles: 'No articles have been published yet.',
  viewAll: 'View all articles',
  membersBadge: 'Knowledges',
  paidAria: 'Paid article, about one third readable as a preview',
  freeAria: 'Free article',
  minutes: n => `${n} min`,
  markdown: 'Markdown',
  alsoIn: 'Also in',
  fallbackNotice: (r, s) => `This article is not available in ${r} yet; showing the ${s} edition.`,
  draftPreview: r => `Draft preview (revision ${r}) — visible to admins only.`,
  lockedTitle: 'The rest is for Knowledges members',
  lockedBody: 'You are reading roughly the first third. Knowledges, Combo and Community plans unlock paid articles in full; the Zuey AI plan reads previews only.',
  seePlans: 'See plans',
  signIn: 'Sign in',
  lockedMore: (s, m) => (s > 0 ? `Plus ${s} more ${s === 1 ? 'section' : 'sections'} (about ${m} min) for members` : `About ${m} more min of reading for members`),
  lockedSection: 'Locked section',
  openInNewTab: 'Open in new tab',
  share: 'Share',
  copyMarkdown: 'Copy Markdown',
  copyMarkdownUrl: 'Copy Markdown link',
  copyFullPrivate: 'Copy full text (private)',
  copyFullHint: 'For your own use; please do not share the paid part.',
  copied: 'Copied',
  copyFailed: 'Could not copy',
  askAi: n => `Ask ${n} about this`,
  aiPrompt: url => `Read and summarise this public article, then answer my questions: ${url}`,
  nativeShare: 'Share…',
  notFoundTitle: 'Article not found',
  notFoundBody: 'This article does not exist or is not published.',
  semanticOff: 'Keyword search',
  loading: 'Loading…',
  loadFailed: 'Could not load articles.',
};

const zh: KnowledgeStrings = {
  sectionTitle: "Zuey's Knowledges",
  sectionLead: 'Duy Nguyen 的笔记、图表、示意图和调查。',
  back: '← zuey.me',
  searchAndFilter: '搜索与筛选',
  searchLabel: '搜索文章',
  searchPlaceholder: '按主题、工具搜索…',
  category: '分类',
  all: '全部',
  labelsAndFreshness: '标签与时效',
  anyLabel: '任意标签',
  tags: '话题',
  sort: '排序',
  sortNew: '最新',
  sortOld: '最早',
  sortTitle: 'A–Z',
  sortRelevance: '最相关',
  apply: '应用',
  reset: '重置',
  results: n => `${n} 篇`,
  noResults: '没有符合筛选条件的文章，请减少条件。',
  noArticles: '还没有已发布的文章。',
  viewAll: '查看全部文章',
  membersBadge: 'Knowledges',
  paidAria: '付费文章，可预览约三分之一',
  freeAria: '免费文章',
  minutes: n => `${n} 分钟`,
  markdown: 'Markdown',
  alsoIn: '其他语言',
  fallbackNotice: (r, s) => `本文暂无${r}版本，正在显示${s}版本。`,
  draftPreview: r => `草稿预览（修订 ${r}）— 仅管理员可见。`,
  lockedTitle: '其余内容仅限 Knowledges 会员',
  lockedBody: '你正在阅读约前三分之一。Knowledges、组合和社区方案可阅读付费文章全文；Zuey AI 方案仅可阅读预览。',
  seePlans: '查看方案',
  signIn: '登录',
  lockedMore: (s, m) => (s > 0 ? `另有 ${s} 个章节（约 ${m} 分钟）仅限会员` : `另有约 ${m} 分钟的内容仅限会员`),
  lockedSection: '锁定章节',
  openInNewTab: '在新标签页中打开',
  share: '分享',
  copyMarkdown: '复制 Markdown',
  copyMarkdownUrl: '复制 Markdown 链接',
  copyFullPrivate: '复制全文（私人）',
  copyFullHint: '仅供个人使用，请勿分享付费内容。',
  copied: '已复制',
  copyFailed: '复制失败',
  askAi: n => `向 ${n} 询问本文`,
  aiPrompt: url => `请阅读并总结这篇公开文章，然后回答我的问题：${url}`,
  nativeShare: '分享…',
  notFoundTitle: '未找到文章',
  notFoundBody: '文章不存在或尚未发布。',
  semanticOff: '关键词搜索',
  loading: '加载中…',
  loadFailed: '无法加载文章列表。',
};

const ko: KnowledgeStrings = {
  sectionTitle: "Zuey's Knowledges",
  sectionLead: 'Duy Nguyen의 노트, 차트, 다이어그램, 설문.',
  back: '← zuey.me',
  searchAndFilter: '검색 및 필터',
  searchLabel: '글 검색',
  searchPlaceholder: '주제, 도구로 검색…',
  category: '카테고리',
  all: '전체',
  labelsAndFreshness: '라벨 및 최신성',
  anyLabel: '모든 라벨',
  tags: '태그',
  sort: '정렬',
  sortNew: '최신순',
  sortOld: '오래된순',
  sortTitle: 'A–Z',
  sortRelevance: '관련도순',
  apply: '적용',
  reset: '초기화',
  results: n => `${n}개 글`,
  noResults: '필터에 맞는 글이 없습니다. 조건을 줄여 보세요.',
  noArticles: '아직 게시된 글이 없습니다.',
  viewAll: '모든 글 보기',
  membersBadge: 'Knowledges',
  paidAria: '유료 글, 약 3분의 1 미리보기 가능',
  freeAria: '무료 글',
  minutes: n => `${n}분`,
  markdown: 'Markdown',
  alsoIn: '다른 언어',
  fallbackNotice: (r, s) => `이 글은 아직 ${r} 버전이 없어 ${s} 버전을 보여 줍니다.`,
  draftPreview: r => `초안 미리보기(리비전 ${r}) — 관리자만 볼 수 있습니다.`,
  lockedTitle: '나머지는 Knowledges 회원 전용입니다',
  lockedBody: '현재 앞부분 약 3분의 1을 읽고 있습니다. Knowledges, 콤보, 커뮤니티 플랜은 유료 글 전체를 열고, Zuey AI 플랜은 미리보기만 읽습니다.',
  seePlans: '플랜 보기',
  signIn: '로그인',
  lockedMore: (s, m) => (s > 0 ? `회원 전용 섹션 ${s}개 더(약 ${m}분)` : `회원 전용 내용 약 ${m}분 더`),
  lockedSection: '잠긴 섹션',
  openInNewTab: '새 탭에서 열기',
  share: '공유',
  copyMarkdown: 'Markdown 복사',
  copyMarkdownUrl: 'Markdown 링크 복사',
  copyFullPrivate: '전문 복사(개인용)',
  copyFullHint: '개인 용도로만 사용하고 유료 부분은 공유하지 마세요.',
  copied: '복사됨',
  copyFailed: '복사할 수 없습니다',
  askAi: n => `${n}에게 이 글 묻기`,
  aiPrompt: url => `이 공개 글을 읽고 요약한 뒤 제 질문에 답해 주세요: ${url}`,
  nativeShare: '공유…',
  notFoundTitle: '글을 찾을 수 없습니다',
  notFoundBody: '글이 없거나 아직 게시되지 않았습니다.',
  semanticOff: '키워드 검색',
  loading: '불러오는 중…',
  loadFailed: '글 목록을 불러오지 못했습니다.',
};

const ja: KnowledgeStrings = {
  sectionTitle: "Zuey's Knowledges",
  sectionLead: 'Duy Nguyen のノート、チャート、図、アンケート。',
  back: '← zuey.me',
  searchAndFilter: '検索と絞り込み',
  searchLabel: '記事を検索',
  searchPlaceholder: 'トピックやツールで検索…',
  category: 'カテゴリ',
  all: 'すべて',
  labelsAndFreshness: 'ラベルと鮮度',
  anyLabel: 'すべてのラベル',
  tags: 'タグ',
  sort: '並び替え',
  sortNew: '新しい順',
  sortOld: '古い順',
  sortTitle: 'A–Z',
  sortRelevance: '関連度順',
  apply: '適用',
  reset: 'リセット',
  results: n => `${n} 件`,
  noResults: '条件に合う記事がありません。条件を減らしてください。',
  noArticles: '公開済みの記事はまだありません。',
  viewAll: 'すべての記事を見る',
  membersBadge: 'Knowledges',
  paidAria: '有料記事、約3分の1をプレビューで読めます',
  freeAria: '無料記事',
  minutes: n => `${n} 分`,
  markdown: 'Markdown',
  alsoIn: '他の言語',
  fallbackNotice: (r, s) => `この記事の${r}版はまだありません。${s}版を表示しています。`,
  draftPreview: r => `下書きプレビュー（リビジョン ${r}）— 管理者のみ表示。`,
  lockedTitle: '続きは Knowledges 会員向けです',
  lockedBody: '現在、冒頭の約3分の1を読んでいます。Knowledges・コンボ・コミュニティプランで有料記事を全文読めます。Zuey AI プランはプレビューのみです。',
  seePlans: 'プランを見る',
  signIn: 'ログイン',
  lockedMore: (s, m) => (s > 0 ? `会員向けにあと ${s} セクション（約 ${m} 分）` : `会員向けにあと約 ${m} 分の内容`),
  lockedSection: 'ロックされたセクション',
  openInNewTab: '新しいタブで開く',
  share: '共有',
  copyMarkdown: 'Markdown をコピー',
  copyMarkdownUrl: 'Markdown のリンクをコピー',
  copyFullPrivate: '全文をコピー（個人用）',
  copyFullHint: '個人利用に限り、有料部分は共有しないでください。',
  copied: 'コピーしました',
  copyFailed: 'コピーできませんでした',
  askAi: n => `${n} にこの記事を質問`,
  aiPrompt: url => `この公開記事を読んで要約し、私の質問に答えてください: ${url}`,
  nativeShare: '共有…',
  notFoundTitle: '記事が見つかりません',
  notFoundBody: '記事が存在しないか、まだ公開されていません。',
  semanticOff: 'キーワード検索',
  loading: '読み込み中…',
  loadFailed: '記事一覧を読み込めませんでした。',
};

export const KNOWLEDGE_STRINGS: Record<Locale, KnowledgeStrings> = { vi, en, zh, ko, ja };

export function knowledgeStrings(locale: Locale): KnowledgeStrings {
  return KNOWLEDGE_STRINGS[locale];
}

/** Date in Asia/Saigon for the reader's locale. */
export function formatKnowledgeDate(iso: string | null, locale: Locale): string {
  if (!iso) return '';
  const tag = { vi: 'vi-VN', en: 'en-US', zh: 'zh-CN', ko: 'ko-KR', ja: 'ja-JP' }[locale];
  return new Date(iso).toLocaleDateString(tag, { timeZone: 'Asia/Saigon', year: 'numeric', month: 'short', day: 'numeric' });
}
