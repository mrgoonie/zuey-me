/** Public detail payload for one video: editions with transcripts plus automatically related articles. */
import type { D1DatabaseLike } from '../../db/store';
import { relatedArticlesForVideo } from './related-content';
import { getVideo } from './store';
import type { RelatedArticle, VideoItem } from './types';
import { parseYoutubeId } from './youtube-url';

export interface VideoDetail {
  video: VideoItem;
  related_articles: RelatedArticle[];
}

/** `ref` may be a video id, a YouTube id or a YouTube link. Related-article failures never fail the read. */
export async function getVideoDetail(db: D1DatabaseLike, ref: string, origin: string): Promise<VideoDetail | null> {
  const key = parseYoutubeId(ref);
  const video = (await getVideo(db, ref, { transcript: true })) ?? (key && key !== ref ? await getVideo(db, key, { transcript: true }) : null);
  if (!video) return null;
  let related: RelatedArticle[] = [];
  try {
    related = await relatedArticlesForVideo(db, video, { origin, limit: 3 });
  } catch (err) {
    console.error('Related articles failed:', err instanceof Error ? err.message : 'unknown');
  }
  return { video, related_articles: related };
}
