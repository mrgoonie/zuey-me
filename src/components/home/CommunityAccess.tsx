import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Send, Users } from 'lucide-react';
import type { CommunityChat, CommunityStatus, MembershipView } from '../../lib/experience/community';
import type { Locale } from '../../lib/i18n/locales';
import { LOCALE_LABELS } from '../../lib/i18n/locales';
import { fmt } from './home-i18n';
import { apiFetch, parseCommunity, parseMembership } from './api-client';

const STRINGS = {
  en: {
    title: 'Private community', intro: 'Telegram groups with Duy, in English and Vietnamese. Invite links are single-use and expire after one hour.',
    loading: 'Checking your community access…', signIn: 'Sign in to join the community.', signInCta: 'Sign in',
    upgrade: 'The private groups are part of the Community plan.', upgradeCta: 'See the Community plan',
    unconfigured: 'The community groups are not open yet. Your access is kept and will appear here once they are.',
    chats: { en: 'English group', vi: 'Vietnamese group' }, get: 'Get invite link', getting: 'Creating link…',
    open: 'Open in Telegram', expires: 'Link expires at {time}', joined: 'You are a member.',
    alreadyJoined: 'You are already in this group.', rateLimited: 'Too many invite links today. Try again tomorrow.',
    failed: 'Could not create an invite link. Please try again.', loadFailed: 'Could not load community status.', retry: 'Retry',
  },
  vi: {
    title: 'Cộng đồng riêng', intro: 'Nhóm Telegram cùng Duy, tiếng Anh và tiếng Việt. Link mời chỉ dùng được một lần và hết hạn sau một giờ.',
    loading: 'Đang kiểm tra quyền vào cộng đồng…', signIn: 'Đăng nhập để tham gia cộng đồng.', signInCta: 'Đăng nhập',
    upgrade: 'Nhóm kín thuộc gói Cộng đồng.', upgradeCta: 'Xem gói Cộng đồng',
    unconfigured: 'Nhóm cộng đồng chưa mở. Quyền của bạn vẫn được giữ và sẽ hiện ở đây khi nhóm sẵn sàng.',
    chats: { en: 'Nhóm tiếng Anh', vi: 'Nhóm tiếng Việt' }, get: 'Lấy link mời', getting: 'Đang tạo link…',
    open: 'Mở trong Telegram', expires: 'Link hết hạn lúc {time}', joined: 'Bạn đã là thành viên.',
    alreadyJoined: 'Bạn đã ở trong nhóm này.', rateLimited: 'Hôm nay bạn đã tạo quá nhiều link. Hãy thử lại vào ngày mai.',
    failed: 'Không tạo được link mời. Vui lòng thử lại.', loadFailed: 'Không tải được trạng thái cộng đồng.', retry: 'Thử lại',
  },
  zh: {
    title: '私密社群', intro: '与 Duy 的 Telegram 群组，英语和越南语。邀请链接仅限使用一次，一小时后失效。',
    loading: '正在检查社群权限…', signIn: '登录后加入社群。', signInCta: '登录',
    upgrade: '私密群组属于社群方案。', upgradeCta: '查看社群方案',
    unconfigured: '社群群组尚未开放。你的权限会保留，开放后会显示在这里。',
    chats: { en: '英语群', vi: '越南语群' }, get: '获取邀请链接', getting: '正在创建链接…',
    open: '在 Telegram 中打开', expires: '链接于 {time} 失效', joined: '你已是成员。',
    alreadyJoined: '你已在该群组中。', rateLimited: '今天创建的链接过多，请明天再试。',
    failed: '无法创建邀请链接，请重试。', loadFailed: '无法加载社群状态。', retry: '重试',
  },
  ko: {
    title: '비공개 커뮤니티', intro: 'Duy와 함께하는 영어·베트남어 텔레그램 그룹입니다. 초대 링크는 한 번만 쓸 수 있고 1시간 뒤 만료됩니다.',
    loading: '커뮤니티 권한을 확인하는 중…', signIn: '커뮤니티에 참여하려면 로그인하세요.', signInCta: '로그인',
    upgrade: '비공개 그룹은 커뮤니티 플랜에 포함됩니다.', upgradeCta: '커뮤니티 플랜 보기',
    unconfigured: '커뮤니티 그룹이 아직 열리지 않았습니다. 권한은 유지되며 열리면 여기에 표시됩니다.',
    chats: { en: '영어 그룹', vi: '베트남어 그룹' }, get: '초대 링크 받기', getting: '링크 만드는 중…',
    open: '텔레그램에서 열기', expires: '링크 만료: {time}', joined: '이미 멤버입니다.',
    alreadyJoined: '이미 이 그룹에 있습니다.', rateLimited: '오늘 링크를 너무 많이 만들었습니다. 내일 다시 시도하세요.',
    failed: '초대 링크를 만들 수 없습니다. 다시 시도하세요.', loadFailed: '커뮤니티 상태를 불러올 수 없습니다.', retry: '다시 시도',
  },
  ja: {
    title: '非公開コミュニティ', intro: 'Duy と参加する英語・ベトナム語の Telegram グループです。招待リンクは 1 回限りで、1 時間で失効します。',
    loading: 'コミュニティの権限を確認中…', signIn: 'コミュニティに参加するにはログインしてください。', signInCta: 'ログイン',
    upgrade: '非公開グループはコミュニティプランに含まれます。', upgradeCta: 'コミュニティプランを見る',
    unconfigured: 'コミュニティグループはまだ開設されていません。権限は保持され、開設後にここに表示されます。',
    chats: { en: '英語グループ', vi: 'ベトナム語グループ' }, get: '招待リンクを取得', getting: 'リンクを作成中…',
    open: 'Telegram で開く', expires: 'リンクの有効期限：{time}', joined: 'メンバーです。',
    alreadyJoined: 'すでにこのグループに参加しています。', rateLimited: '本日の招待リンク作成数が上限に達しました。明日お試しください。',
    failed: '招待リンクを作成できませんでした。もう一度お試しください。', loadFailed: 'コミュニティの状態を読み込めませんでした。', retry: '再試行',
  },
} satisfies Record<Locale, unknown>;

type View =
  | { kind: 'loading' }
  | { kind: 'signedOut' }
  | { kind: 'error' }
  | { kind: 'ready'; status: CommunityStatus };

interface CommunityAccessProps {
  locale: Locale;
}

function latestFor(memberships: MembershipView[], chat: CommunityChat): MembershipView | null {
  return memberships
    .filter(m => m.chat === chat)
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

/**
 * Account-page card for the $29 Community plan: one-hour, single-use Telegram invite links for
 * the English and Vietnamese groups. Honest states for signed-out, unentitled and unconfigured.
 */
export const CommunityAccess: React.FC<CommunityAccessProps> = ({ locale }) => {
  const s = STRINGS[locale];
  const [view, setView] = useState<View>({ kind: 'loading' });
  const [pending, setPending] = useState<CommunityChat | null>(null);
  const [messages, setMessages] = useState<Partial<Record<CommunityChat, string>>>({});
  const timeFmt = new Intl.DateTimeFormat(LOCALE_LABELS[locale].htmlLang, { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });

  const load = useCallback(async () => {
    setView({ kind: 'loading' });
    const res = await apiFetch('/api/v1/community', parseCommunity);
    if (res.ok) setView(res.data.signed_in ? { kind: 'ready', status: res.data } : { kind: 'signedOut' });
    else setView(res.status === 401 ? { kind: 'signedOut' } : { kind: 'error' });
  }, []);

  useEffect(() => { void load(); }, [load]);

  const requestInvite = async (chat: CommunityChat) => {
    setPending(chat);
    setMessages(m => ({ ...m, [chat]: undefined }));
    const res = await apiFetch('/api/v1/community/invite', parseMembership, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat }),
    });
    setPending(null);
    if (res.ok) {
      const invite = res.data;
      setView(v => (v.kind === 'ready'
        ? { kind: 'ready', status: { ...v.status, memberships: [invite, ...v.status.memberships.filter(m => m.id !== invite.id)] } }
        : v));
      return;
    }
    const message = res.code === 'already_joined' ? s.alreadyJoined
      : res.code === 'rate_limited' || res.code === 'telegram_rate_limited' ? s.rateLimited
        : res.code === 'community_unconfigured' ? s.unconfigured
          : res.status === 401 ? s.signIn : s.failed;
    setMessages(m => ({ ...m, [chat]: message }));
    if (res.code === 'already_joined') void load();
  };

  return (
    <section className="rounded-3xl border border-stone-200 bg-white/90 p-5 sm:p-6 text-stone-900" aria-labelledby="community-access-title">
      <h2 id="community-access-title" className="flex items-center gap-2 font-serif text-xl font-extrabold">
        <Users aria-hidden="true" className="w-5 h-5" />{s.title}
      </h2>
      <p className="mt-1.5 text-sm leading-relaxed text-stone-600">{s.intro}</p>

      <div className="mt-4" aria-live="polite">
        {view.kind === 'loading' && <p className="text-sm text-stone-600" role="status">{s.loading}</p>}
        {view.kind === 'error' && (
          <p className="flex flex-wrap items-center gap-3 text-sm text-red-800">
            {s.loadFailed}
            <button type="button" className="rounded-full border border-stone-300 px-3 py-1.5 font-semibold text-stone-900 hover:bg-stone-100" onClick={() => void load()}>{s.retry}</button>
          </p>
        )}
        {view.kind === 'signedOut' && (
          <p className="flex flex-wrap items-center gap-3 text-sm">
            {s.signIn}
            <a className="rounded-full bg-stone-900 px-4 py-2 font-semibold text-white hover:bg-stone-700" href="/login?next=%2Faccount">{s.signInCta}</a>
          </p>
        )}
        {view.kind === 'ready' && !view.status.entitled && (
          <p className="flex flex-wrap items-center gap-3 text-sm">
            {s.upgrade}
            <a className="rounded-full bg-stone-900 px-4 py-2 font-semibold text-white hover:bg-stone-700" href="/pricing?plan=community">{s.upgradeCta}</a>
          </p>
        )}
        {view.kind === 'ready' && view.status.entitled && !view.status.configured && (
          <p className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">{s.unconfigured}</p>
        )}
        {view.kind === 'ready' && view.status.entitled && view.status.configured && (
          <ul className="grid gap-3 sm:grid-cols-2">
            {view.status.chats.filter(c => c.available).map(({ chat }) => {
              const latest = latestFor(view.status.memberships, chat);
              const link = latest?.status === 'invited' ? latest.invite_link : null;
              return (
                <li key={chat} className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
                  <p className="font-bold">{s.chats[chat]}</p>
                  {latest?.status === 'joined' ? (
                    <p className="mt-1 text-sm text-emerald-800">{s.joined}</p>
                  ) : link ? (
                    <div className="mt-2 grid gap-1.5">
                      <a className="inline-flex items-center justify-center gap-2 rounded-full bg-sky-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-sky-800" href={link} target="_blank" rel="noopener noreferrer">
                        <Send aria-hidden="true" className="w-4 h-4" />{s.open}<ExternalLink aria-hidden="true" className="w-3.5 h-3.5" />
                      </a>
                      <p className="text-xs text-stone-600">{fmt(s.expires, { time: timeFmt.format(new Date(latest?.invite_expires_at ?? Date.now())) })}</p>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="mt-2 w-full rounded-full bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-stone-700 disabled:opacity-60"
                      disabled={pending !== null}
                      aria-busy={pending === chat}
                      onClick={() => void requestInvite(chat)}
                    >
                      {pending === chat ? s.getting : s.get}
                    </button>
                  )}
                  {messages[chat] && <p className="mt-2 text-xs text-red-800" role="alert">{messages[chat]}</p>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
};

export default CommunityAccess;
