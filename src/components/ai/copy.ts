import type { Locale } from '../../lib/i18n/locales';

export interface AiCopy {
  eyebrow: string;
  intro: string;
  loading: string;
  signedOutTitle: string;
  signedOutBody: string;
  login: string;
  seePlans: string;
  noEntitlementTitle: string;
  noEntitlementBody: string;
  upgrade: string;
  unconfiguredTitle: string;
  unconfiguredBody: string;
  quotaTitle: string;
  quotaBody: (limit: number, month: string) => string;
  budgetBody: (budgetUsd: number, month: string) => string;
  quotaLeft: (remaining: number, limit: number) => string;
  unlimited: string;
  sessions: string;
  newChat: string;
  untitled: string;
  rename: string;
  renameTitle: string;
  delete: string;
  deleteTitle: string;
  deleteBody: string;
  cancel: string;
  save: string;
  exportAll: string;
  openChatPage: string;
  inputLabel: string;
  placeholder: string;
  send: string;
  stop: string;
  hint: string;
  thinking: string;
  thinkingHint: (seconds: number) => string;
  streaming: string;
  stopped: string;
  errorTitle: string;
  retry: string;
  sources: string;
  paidPreview: string;
  paid: string;
  greeting: string;
  suggestions: string[];
  privacy: string;
  you: string;
  artifact: string;
  runDemo: string;
  openFull: string;
  close: string;
  reload: string;
  sandboxNote: string;
  unresponsive: string;
  frameError: string;
  artifactRejected: string;
  loadFailed: string;
  deleted: string;
  emptySessions: string;
  errors: Record<string, string>;
}

const vi: AiCopy = {
  eyebrow: 'A little more Zuey',
  intro: 'Một góc nhìn khác. Từ những gì Zuey đã viết.',
  loading: 'Đang tải…',
  signedOutTitle: 'Đăng nhập để trò chuyện với Zuey AI',
  signedOutBody: 'Zuey AI trả lời dựa trên các bài Zuey đã viết. Có nguồn thì dẫn, chưa đủ nguồn thì nói rõ.',
  login: 'Đăng nhập',
  seePlans: 'Xem các gói',
  noEntitlementTitle: 'Gói hiện tại chưa gồm Zuey AI',
  noEntitlementBody: 'Zuey AI có trong gói Zuey AI ($9/tháng), Kết hợp ($19) và Cộng đồng ($29).',
  upgrade: 'Nâng cấp',
  unconfiguredTitle: 'Zuey AI đang tạm nghỉ',
  unconfiguredBody: 'Dịch vụ AI chưa được cấu hình xong trên máy chủ. Vui lòng quay lại sau.',
  quotaTitle: 'Bạn đã dùng hết lượt tháng này',
  quotaBody: (limit, month) => `Gói của bạn có ${limit} lượt hỏi mỗi tháng. Lượt sẽ được làm mới sau tháng ${month} (giờ Việt Nam).`,
  quotaLeft: (remaining, limit) => `Còn ${remaining}/${limit} lượt`,
  budgetBody: (usd, month) => `Gói của bạn có ngân sách AI $${usd} mỗi tháng và bạn đã dùng hết. Ngân sách sẽ được làm mới sau tháng ${month} (giờ Việt Nam).`,
  unlimited: 'Admin · không giới hạn',
  sessions: 'Cuộc trò chuyện',
  newChat: 'Trò chuyện mới',
  untitled: 'Chưa đặt tên',
  rename: 'Đổi tên',
  renameTitle: 'Đổi tên cuộc trò chuyện',
  delete: 'Xoá',
  deleteTitle: 'Xoá cuộc trò chuyện này?',
  deleteBody: 'Tin nhắn và khối tương tác trong cuộc trò chuyện sẽ bị xoá vĩnh viễn.',
  cancel: 'Huỷ',
  save: 'Lưu',
  exportAll: 'Tải tất cả (JSON)',
  openChatPage: 'Mở trang chat',
  inputLabel: 'Câu hỏi cho Zuey AI',
  placeholder: 'Kể tôi nghe điều bạn đang nghĩ…',
  send: 'Hỏi Zuey',
  stop: 'Dừng',
  hint: 'Enter để gửi · Shift+Enter xuống dòng · Esc để dừng',
  thinking: 'Zuey đang suy nghĩ…',
  thinkingHint: s => `${s} giây · câu chữ đầu tiên thường mất 8–11 giây`,
  streaming: 'Zuey đang trả lời…',
  stopped: 'Đã dừng câu trả lời.',
  errorTitle: 'Chưa nhận được câu trả lời',
  retry: 'Thử lại',
  sources: 'Nguồn',
  paidPreview: 'Bài trả phí · chỉ dùng phần xem trước',
  paid: 'Bài trả phí',
  greeting: 'Bạn đang mắc ở bước nào? Mình cùng tìm nguồn và mổ xẻ nhé.',
  suggestions: ['Giúp tôi chọn một cách bắt đầu với AI', 'Tìm bài về xây dựng sản phẩm'],
  privacy: 'Chat được lưu riêng cho bạn; admin chỉ truy cập khi có lý do và mọi lần truy cập đều được ghi lại.',
  you: 'Bạn',
  artifact: 'Khối tương tác',
  runDemo: 'Chạy demo',
  openFull: 'Mở toàn màn hình',
  close: 'Đóng',
  reload: 'Chạy lại',
  sandboxNote: 'Chạy trong sandbox cô lập; mạng chỉ qua proxy được duyệt.',
  unresponsive: 'Demo không phản hồi nên đã được dừng.',
  frameError: 'Demo báo lỗi',
  artifactRejected: 'Một khối tương tác không hợp lệ đã bị bỏ qua.',
  loadFailed: 'Không tải được dữ liệu. Thử lại sau.',
  deleted: 'Đã xoá cuộc trò chuyện.',
  emptySessions: 'Chưa có cuộc trò chuyện nào.',
  errors: {
    ai_unavailable: 'Zuey AI đang bận hoặc tạm gián đoạn. Thử lại sau ít phút.',
    ai_timeout: 'Zuey AI phản hồi quá lâu nên đã dừng. Thử lại nhé.',
    ai_run_failed: 'Zuey AI không hoàn thành được câu trả lời. Thử lại nhé.',
    ai_rejected: 'Yêu cầu bị từ chối, có thể do gửi quá nhanh. Đợi một chút rồi thử lại.',
    ai_auth_failed: 'Máy chủ AI từ chối kết nối. Admin đã được báo qua log.',
    ai_connection_closed: 'Kết nối tới Zuey AI bị ngắt giữa chừng. Thử lại nhé.',
    chat_run_in_progress: 'Cuộc trò chuyện này đang có một câu trả lời chạy. Dừng nó hoặc đợi xong.',
    network_error: 'Không kết nối được máy chủ. Kiểm tra mạng và thử lại.',
    internal_error: 'Đã có lỗi khi xử lý câu trả lời. Thử lại nhé.',
    csrf_rejected: 'Yêu cầu bị chặn vì không xuất phát từ zuey.me. Vui lòng tải lại trang.',
    not_found: 'Không tìm thấy cuộc trò chuyện này.',
    generic: 'Đã có lỗi xảy ra. Thử lại nhé.',
  },
};

const en: AiCopy = {
  eyebrow: 'A little more Zuey',
  intro: 'Another angle, from what Zuey has written.',
  loading: 'Loading…',
  signedOutTitle: 'Sign in to chat with Zuey AI',
  signedOutBody: 'Zuey AI answers from Zuey\'s articles. It cites sources, and says so when it doesn\'t have enough.',
  login: 'Sign in',
  seePlans: 'See plans',
  noEntitlementTitle: 'Your plan doesn\'t include Zuey AI',
  noEntitlementBody: 'Zuey AI is part of the Zuey AI ($9/month), Combo ($19) and Community ($29) plans.',
  upgrade: 'Upgrade',
  unconfiguredTitle: 'Zuey AI is taking a break',
  unconfiguredBody: 'The AI service is not fully configured on the server yet. Please check back later.',
  quotaTitle: 'You\'ve used this month\'s requests',
  quotaBody: (limit, month) => `Your plan includes ${limit} questions per month. They renew after ${month} (Vietnam time).`,
  quotaLeft: (remaining, limit) => `${remaining}/${limit} left`,
  budgetBody: (usd, month) => `You've used your plan's $${usd} monthly AI budget. It renews after ${month} (Vietnam time).`,
  unlimited: 'Admin · unlimited',
  sessions: 'Chats',
  newChat: 'New chat',
  untitled: 'Untitled',
  rename: 'Rename',
  renameTitle: 'Rename chat',
  delete: 'Delete',
  deleteTitle: 'Delete this chat?',
  deleteBody: 'Its messages and interactive blocks will be permanently deleted.',
  cancel: 'Cancel',
  save: 'Save',
  exportAll: 'Download all (JSON)',
  openChatPage: 'Open chat page',
  inputLabel: 'Your question for Zuey AI',
  placeholder: 'Tell me what you\'re thinking about…',
  send: 'Ask Zuey',
  stop: 'Stop',
  hint: 'Enter to send · Shift+Enter for a new line · Esc to stop',
  thinking: 'Zuey is thinking…',
  thinkingHint: s => `${s}s · the first words usually take 8–11 seconds`,
  streaming: 'Zuey is answering…',
  stopped: 'Answer stopped.',
  errorTitle: 'No answer received',
  retry: 'Retry',
  sources: 'Sources',
  paidPreview: 'Paid article · preview only',
  paid: 'Paid article',
  greeting: 'Where are you stuck? Let\'s find sources and dig in together.',
  suggestions: ['Help me pick a way to start with AI', 'Find a post about building products'],
  privacy: 'Chats are stored privately for you; admins access them only with a stated reason, and every access is logged.',
  you: 'You',
  artifact: 'Interactive block',
  runDemo: 'Run demo',
  openFull: 'Open full screen',
  close: 'Close',
  reload: 'Run again',
  sandboxNote: 'Runs in an isolated sandbox; network only through the approved proxy.',
  unresponsive: 'The demo stopped responding and was halted.',
  frameError: 'The demo reported an error',
  artifactRejected: 'An invalid interactive block was skipped.',
  loadFailed: 'Could not load data. Try again later.',
  deleted: 'Chat deleted.',
  emptySessions: 'No chats yet.',
  errors: {
    ai_unavailable: 'Zuey AI is busy or briefly unavailable. Try again in a few minutes.',
    ai_timeout: 'Zuey AI took too long and was stopped. Please try again.',
    ai_run_failed: 'Zuey AI could not finish the answer. Please try again.',
    ai_rejected: 'The request was refused, possibly for sending too fast. Wait a moment and retry.',
    ai_auth_failed: 'The AI server refused the connection. The admin has been notified via logs.',
    ai_connection_closed: 'The connection to Zuey AI dropped. Please try again.',
    chat_run_in_progress: 'An answer is already running in this chat. Stop it or wait for it to finish.',
    network_error: 'Could not reach the server. Check your connection and try again.',
    internal_error: 'Something went wrong while answering. Please try again.',
    csrf_rejected: 'Request blocked because it did not come from zuey.me. Please reload the page.',
    not_found: 'This chat was not found.',
    generic: 'Something went wrong. Please try again.',
  },
};

const zh: AiCopy = {
  eyebrow: 'A little more Zuey',
  intro: '换个角度，来自 Zuey 写过的内容。',
  loading: '加载中…',
  signedOutTitle: '登录后与 Zuey AI 对话',
  signedOutBody: 'Zuey AI 根据 Zuey 的文章作答，有来源就引用，来源不足会直说。',
  login: '登录',
  seePlans: '查看方案',
  noEntitlementTitle: '当前方案不含 Zuey AI',
  noEntitlementBody: 'Zuey AI 包含在 Zuey AI（$9/月）、组合（$19）和社区（$29）方案中。',
  upgrade: '升级',
  unconfiguredTitle: 'Zuey AI 暂时休息中',
  unconfiguredBody: '服务器上的 AI 服务尚未配置完成，请稍后再来。',
  quotaTitle: '本月次数已用完',
  quotaBody: (limit, month) => `你的方案每月可提问 ${limit} 次，将在 ${month} 之后（越南时间）重置。`,
  quotaLeft: (remaining, limit) => `剩余 ${remaining}/${limit} 次`,
  budgetBody: (usd, month) => `你的方案每月 AI 预算为 $${usd}，本月已用完，将在 ${month} 之后（越南时间）重置。`,
  unlimited: '管理员 · 不限次数',
  sessions: '对话',
  newChat: '新对话',
  untitled: '未命名',
  rename: '重命名',
  renameTitle: '重命名对话',
  delete: '删除',
  deleteTitle: '删除此对话？',
  deleteBody: '其中的消息和交互模块将被永久删除。',
  cancel: '取消',
  save: '保存',
  exportAll: '全部下载（JSON）',
  openChatPage: '打开对话页',
  inputLabel: '给 Zuey AI 的问题',
  placeholder: '说说你在想什么…',
  send: '问 Zuey',
  stop: '停止',
  hint: 'Enter 发送 · Shift+Enter 换行 · Esc 停止',
  thinking: 'Zuey 正在思考…',
  thinkingHint: s => `${s} 秒 · 第一句话通常需要 8–11 秒`,
  streaming: 'Zuey 正在回答…',
  stopped: '已停止回答。',
  errorTitle: '未收到回答',
  retry: '重试',
  sources: '来源',
  paidPreview: '付费文章 · 仅使用预览部分',
  paid: '付费文章',
  greeting: '你卡在哪一步？我们一起找资料、拆解问题。',
  suggestions: ['帮我选一个开始使用 AI 的方式', '找一篇关于打造产品的文章'],
  privacy: '对话仅为你保存；管理员只有在说明理由时才能访问，且每次访问都会记录。',
  you: '你',
  artifact: '交互模块',
  runDemo: '运行演示',
  openFull: '全屏打开',
  close: '关闭',
  reload: '重新运行',
  sandboxNote: '在隔离沙箱中运行；网络只能经由已批准的代理。',
  unresponsive: '演示无响应，已停止。',
  frameError: '演示报告了错误',
  artifactRejected: '已跳过一个无效的交互模块。',
  loadFailed: '无法加载数据，请稍后重试。',
  deleted: '对话已删除。',
  emptySessions: '还没有对话。',
  errors: {
    ai_unavailable: 'Zuey AI 正忙或暂时不可用，请几分钟后重试。',
    ai_timeout: 'Zuey AI 响应过久已停止，请重试。',
    ai_run_failed: 'Zuey AI 未能完成回答，请重试。',
    ai_rejected: '请求被拒绝，可能是发送过快。请稍等后重试。',
    ai_auth_failed: 'AI 服务器拒绝了连接，管理员已通过日志获知。',
    ai_connection_closed: '与 Zuey AI 的连接中断，请重试。',
    chat_run_in_progress: '此对话中已有回答在进行，请停止或等待完成。',
    network_error: '无法连接服务器，请检查网络后重试。',
    internal_error: '回答处理出错，请重试。',
    csrf_rejected: '请求被拦截，因为它不是来自 zuey.me。请刷新页面。',
    not_found: '找不到此对话。',
    generic: '出了点问题，请重试。',
  },
};

const ko: AiCopy = {
  eyebrow: 'A little more Zuey',
  intro: 'Zuey가 쓴 글에서 나온 또 다른 시각.',
  loading: '불러오는 중…',
  signedOutTitle: '로그인하고 Zuey AI와 대화하세요',
  signedOutBody: 'Zuey AI는 Zuey의 글을 바탕으로 답합니다. 출처가 있으면 인용하고, 부족하면 솔직히 말합니다.',
  login: '로그인',
  seePlans: '요금제 보기',
  noEntitlementTitle: '현재 요금제에는 Zuey AI가 없습니다',
  noEntitlementBody: 'Zuey AI는 Zuey AI($9/월), 결합($19), 커뮤니티($29) 요금제에 포함됩니다.',
  upgrade: '업그레이드',
  unconfiguredTitle: 'Zuey AI가 잠시 쉬고 있어요',
  unconfiguredBody: '서버의 AI 서비스 설정이 아직 끝나지 않았습니다. 나중에 다시 와 주세요.',
  quotaTitle: '이번 달 사용량을 모두 썼어요',
  quotaBody: (limit, month) => `요금제에 매월 ${limit}회 질문이 포함됩니다. ${month} 이후(베트남 시간) 초기화됩니다.`,
  quotaLeft: (remaining, limit) => `${remaining}/${limit}회 남음`,
  budgetBody: (usd, month) => `요금제의 월 AI 예산 $${usd}을(를) 모두 사용했어요. ${month} 이후(베트남 시간) 초기화됩니다.`,
  unlimited: '관리자 · 무제한',
  sessions: '대화',
  newChat: '새 대화',
  untitled: '제목 없음',
  rename: '이름 변경',
  renameTitle: '대화 이름 변경',
  delete: '삭제',
  deleteTitle: '이 대화를 삭제할까요?',
  deleteBody: '대화의 메시지와 인터랙티브 블록이 영구 삭제됩니다.',
  cancel: '취소',
  save: '저장',
  exportAll: '전체 다운로드(JSON)',
  openChatPage: '채팅 페이지 열기',
  inputLabel: 'Zuey AI에게 질문',
  placeholder: '지금 무슨 생각을 하고 있나요…',
  send: 'Zuey에게 묻기',
  stop: '중지',
  hint: 'Enter 보내기 · Shift+Enter 줄바꿈 · Esc 중지',
  thinking: 'Zuey가 생각 중…',
  thinkingHint: s => `${s}초 · 첫 문장은 보통 8–11초 걸려요`,
  streaming: 'Zuey가 답하는 중…',
  stopped: '답변을 중지했습니다.',
  errorTitle: '답변을 받지 못했습니다',
  retry: '다시 시도',
  sources: '출처',
  paidPreview: '유료 글 · 미리보기만 사용',
  paid: '유료 글',
  greeting: '어느 단계에서 막혔나요? 함께 출처를 찾고 파헤쳐 봐요.',
  suggestions: ['AI를 시작하는 방법을 골라 주세요', '제품 만들기에 관한 글 찾기'],
  privacy: '대화는 본인용으로 저장되며, 관리자는 사유가 있을 때만 접근하고 모든 접근은 기록됩니다.',
  you: '나',
  artifact: '인터랙티브 블록',
  runDemo: '데모 실행',
  openFull: '전체 화면',
  close: '닫기',
  reload: '다시 실행',
  sandboxNote: '격리된 샌드박스에서 실행되며, 네트워크는 승인된 프록시로만 가능합니다.',
  unresponsive: '데모가 응답하지 않아 중지했습니다.',
  frameError: '데모에서 오류가 발생했습니다',
  artifactRejected: '유효하지 않은 인터랙티브 블록을 건너뛰었습니다.',
  loadFailed: '데이터를 불러오지 못했습니다. 나중에 다시 시도하세요.',
  deleted: '대화를 삭제했습니다.',
  emptySessions: '아직 대화가 없습니다.',
  errors: {
    ai_unavailable: 'Zuey AI가 바쁘거나 잠시 이용할 수 없습니다. 몇 분 후 다시 시도하세요.',
    ai_timeout: 'Zuey AI 응답이 너무 오래 걸려 중지했습니다. 다시 시도하세요.',
    ai_run_failed: 'Zuey AI가 답변을 마치지 못했습니다. 다시 시도하세요.',
    ai_rejected: '요청이 거부되었습니다. 너무 빠르게 보냈을 수 있어요. 잠시 후 다시 시도하세요.',
    ai_auth_failed: 'AI 서버가 연결을 거부했습니다. 관리자에게 로그로 전달되었습니다.',
    ai_connection_closed: 'Zuey AI와의 연결이 끊겼습니다. 다시 시도하세요.',
    chat_run_in_progress: '이 대화에서 이미 답변이 진행 중입니다. 중지하거나 끝날 때까지 기다리세요.',
    network_error: '서버에 연결할 수 없습니다. 네트워크를 확인하고 다시 시도하세요.',
    internal_error: '답변 처리 중 오류가 발생했습니다. 다시 시도하세요.',
    csrf_rejected: 'zuey.me에서 온 요청이 아니어서 차단되었습니다. 페이지를 새로고침하세요.',
    not_found: '이 대화를 찾을 수 없습니다.',
    generic: '문제가 발생했습니다. 다시 시도하세요.',
  },
};

const ja: AiCopy = {
  eyebrow: 'A little more Zuey',
  intro: 'Zuey が書いてきたことからの、もうひとつの視点。',
  loading: '読み込み中…',
  signedOutTitle: 'ログインして Zuey AI と話す',
  signedOutBody: 'Zuey AI は Zuey の記事をもとに答えます。出典があれば示し、足りなければそう伝えます。',
  login: 'ログイン',
  seePlans: 'プランを見る',
  noEntitlementTitle: '現在のプランには Zuey AI が含まれていません',
  noEntitlementBody: 'Zuey AI は Zuey AI（月 $9）、セット（$19）、コミュニティ（$29）プランに含まれます。',
  upgrade: 'アップグレード',
  unconfiguredTitle: 'Zuey AI は休憩中です',
  unconfiguredBody: 'サーバーの AI サービスの設定がまだ完了していません。しばらくしてからお試しください。',
  quotaTitle: '今月の利用回数を使い切りました',
  quotaBody: (limit, month) => `プランには毎月 ${limit} 回の質問が含まれます。${month} の後（ベトナム時間）にリセットされます。`,
  quotaLeft: (remaining, limit) => `残り ${remaining}/${limit} 回`,
  budgetBody: (usd, month) => `プランの月間 AI 予算 $${usd} を使い切りました。${month} の後（ベトナム時間）にリセットされます。`,
  unlimited: '管理者 · 無制限',
  sessions: 'チャット',
  newChat: '新しいチャット',
  untitled: '無題',
  rename: '名前を変更',
  renameTitle: 'チャット名を変更',
  delete: '削除',
  deleteTitle: 'このチャットを削除しますか？',
  deleteBody: 'メッセージとインタラクティブブロックは完全に削除されます。',
  cancel: 'キャンセル',
  save: '保存',
  exportAll: 'すべてダウンロード（JSON）',
  openChatPage: 'チャットページを開く',
  inputLabel: 'Zuey AI への質問',
  placeholder: 'いま考えていることを聞かせてください…',
  send: 'Zuey に聞く',
  stop: '停止',
  hint: 'Enter で送信 · Shift+Enter で改行 · Esc で停止',
  thinking: 'Zuey が考えています…',
  thinkingHint: s => `${s} 秒 · 最初の言葉まで通常 8〜11 秒かかります`,
  streaming: 'Zuey が回答中…',
  stopped: '回答を停止しました。',
  errorTitle: '回答を受け取れませんでした',
  retry: '再試行',
  sources: '出典',
  paidPreview: '有料記事 · プレビュー部分のみ使用',
  paid: '有料記事',
  greeting: 'どこでつまずいていますか？一緒に出典を探して掘り下げましょう。',
  suggestions: ['AI の始め方を選ぶのを手伝って', 'プロダクトづくりの記事を探して'],
  privacy: 'チャットはあなた専用に保存されます。管理者は理由がある場合のみアクセスし、すべて記録されます。',
  you: 'あなた',
  artifact: 'インタラクティブブロック',
  runDemo: 'デモを実行',
  openFull: '全画面で開く',
  close: '閉じる',
  reload: '再実行',
  sandboxNote: '隔離されたサンドボックスで実行。ネットワークは承認済みプロキシ経由のみ。',
  unresponsive: 'デモが応答しないため停止しました。',
  frameError: 'デモでエラーが発生しました',
  artifactRejected: '無効なインタラクティブブロックをスキップしました。',
  loadFailed: 'データを読み込めませんでした。後でもう一度お試しください。',
  deleted: 'チャットを削除しました。',
  emptySessions: 'まだチャットはありません。',
  errors: {
    ai_unavailable: 'Zuey AI は混雑中か一時的に利用できません。数分後にお試しください。',
    ai_timeout: 'Zuey AI の応答に時間がかかりすぎたため停止しました。もう一度お試しください。',
    ai_run_failed: 'Zuey AI は回答を完了できませんでした。もう一度お試しください。',
    ai_rejected: 'リクエストが拒否されました。送信が速すぎた可能性があります。少し待ってからお試しください。',
    ai_auth_failed: 'AI サーバーが接続を拒否しました。管理者にはログで通知されています。',
    ai_connection_closed: 'Zuey AI との接続が切れました。もう一度お試しください。',
    chat_run_in_progress: 'このチャットではすでに回答が進行中です。停止するか完了を待ってください。',
    network_error: 'サーバーに接続できません。ネットワークを確認してお試しください。',
    internal_error: '回答の処理中にエラーが発生しました。もう一度お試しください。',
    csrf_rejected: 'zuey.me からのリクエストではないためブロックされました。ページを再読み込みしてください。',
    not_found: 'このチャットは見つかりません。',
    generic: '問題が発生しました。もう一度お試しください。',
  },
};

export const AI_COPY: Record<Locale, AiCopy> = { vi, en, zh, ko, ja };

export function errorCopy(copy: AiCopy, code: string): string {
  return copy.errors[code] ?? copy.errors.generic;
}
