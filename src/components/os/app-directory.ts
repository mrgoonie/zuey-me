/**
 * Agent- and crawler-facing directory of Zuey OS apps: localized name (from os-i18n), a one-line
 * summary, the standalone route and the `#app` deep link. Shared by the no-JS index on `/`,
 * llms.txt / index.md and the WebMCP tools, so every agent surface lists the same apps.
 */
import type { Locale } from '../../lib/i18n/locales';
import { APPS, DOCK_APPS, type AppId } from './apps';
import { osStrings } from './os-i18n';

export const SITE_ORIGIN = 'https://zuey.me';

/** One-line summaries; locales without their own copy fall back to English. */
const SUMMARIES: { en: Record<AppId, string> } & Partial<Record<Locale, Record<AppId, string>>> = {
  en: {
    about: 'Who Duy Nguyen (Zuey) is: bio, ventures, products and social links.',
    ai: 'Chat with Zuey AI, an assistant grounded in Duy’s articles and notes.',
    knowledges: 'Articles and guides by Duy on AI, building products and business.',
    reads: 'Curated reading list of articles Duy recommends from around the web.',
    zueytube: 'Curated YouTube videos with transcripts.',
    github: 'Duy’s recent GitHub activity and open-source work.',
    pricing: 'Membership plans that unlock full articles, courses and the community.',
    business: 'Book a 1:1 consultation with Duy for your business.',
    mcp: 'Connect AI agents through the MCP server and the REST API.',
    account: 'Sign in to manage your membership, API keys and connected apps.',
    referral: 'Refer friends and earn commission on their memberships.',
    '200lab': '200lab courses Duy recommends, with a 20% referral discount.',
    appearance: 'Change the Zuey OS theme, accent colour and wallpaper.',
  },
  vi: {
    about: 'Duy Nguyễn (Zuey) là ai: tiểu sử, công ty, sản phẩm và mạng xã hội.',
    ai: 'Trò chuyện với Zuey AI, trợ lý trả lời dựa trên bài viết và ghi chú của Duy.',
    knowledges: 'Bài viết và hướng dẫn của Duy về AI, làm sản phẩm và kinh doanh.',
    reads: 'Danh sách bài đọc hay Duy chọn lọc từ khắp nơi.',
    zueytube: 'Video YouTube chọn lọc kèm bản chép lời.',
    github: 'Hoạt động GitHub gần đây và các dự án mã nguồn mở của Duy.',
    pricing: 'Các gói thành viên mở khoá toàn bộ bài viết, khoá học và cộng đồng.',
    business: 'Đặt lịch tư vấn 1:1 với Duy cho doanh nghiệp của bạn.',
    mcp: 'Kết nối AI agent qua MCP server và REST API.',
    account: 'Đăng nhập để quản lý gói thành viên, API key và ứng dụng đã kết nối.',
    referral: 'Giới thiệu bạn bè và nhận hoa hồng từ gói thành viên của họ.',
    '200lab': 'Khoá học 200lab Duy giới thiệu, giảm 20% qua mã giới thiệu.',
    appearance: 'Đổi giao diện, màu nhấn và hình nền của Zuey OS.',
  },
};

export interface DirectoryApp {
  id: AppId;
  name: string;
  summary: string;
  /** Standalone route (path, may itself be a `/#app` deep link when the app has no page). */
  route: string;
  /** Hash that opens the app window on `/`. */
  deepLink: string;
}

/** Dock order first, then apps that live outside the dock (Appearance). */
export const DIRECTORY_APP_IDS: AppId[] = [...DOCK_APPS, ...(Object.keys(APPS) as AppId[]).filter(id => !DOCK_APPS.includes(id))];

export function appDirectory(locale: Locale): DirectoryApp[] {
  const names = osStrings(locale).apps;
  const summaries = SUMMARIES[locale] ?? SUMMARIES.en;
  return DIRECTORY_APP_IDS.map(id => ({
    id,
    name: names[id],
    summary: summaries[id],
    route: APPS[id].href,
    deepLink: `/#${id}`,
  }));
}

export const absoluteUrl = (path: string): string => `${SITE_ORIGIN}${path}`;
