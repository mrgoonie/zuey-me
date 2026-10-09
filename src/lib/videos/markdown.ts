/** Markdown renderings of Zueytube for /videos.md, llms-full.txt and agents. */
import type { VideoItem } from './types';
import { ZUEYTUBE_CHANNEL_URL } from './types';
import { formatDuration, videoPageUrl } from './youtube-url';

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const escapeLinkText = (text: string) => text.replace(/([[\]])/g, '\\$1');

/** One bullet per video, each edition with its language, duration, date and transcript status. */
export function renderVideoLines(items: VideoItem[], origin: string): string {
  return items.map(v => {
    const lines = v.editions.map(e => {
      const meta = [e.locale.toUpperCase(), formatDuration(e.duration_seconds), e.published_at?.slice(0, 10) ?? '', e.transcript_status === 'ready' ? 'transcript' : '']
        .filter(Boolean).join(' · ');
      const desc = e.description ? `: ${oneLine(e.description).slice(0, 220)}` : '';
      return `  - [${escapeLinkText(oneLine(e.title))}](${videoPageUrl(origin, e.youtube_id)}) (${meta}) — YouTube: ${e.watch_url}${desc}`;
    });
    const head = v.editions[0];
    return `- **${escapeLinkText(oneLine(head?.title ?? v.id))}**${v.featured ? ' ⭐' : ''}\n${lines.join('\n')}`;
  }).join('\n');
}

export function renderVideosMarkdown(items: VideoItem[], origin: string): string {
  return `# Zueytube

Curated videos from Zuey's YouTube channel (${ZUEYTUBE_CHANNEL_URL}), grouped by language edition (VI/EN).
Transcripts are searchable through the REST API (\`GET /api/v1/videos?q=\`), \`knowledge_search\` (MCP) and Zuey AI.

${items.length ? renderVideoLines(items, origin) : '_No videos yet._'}
`;
}
