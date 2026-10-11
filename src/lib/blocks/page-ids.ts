/**
 * Element ids the reader pages render around a block document. A section anchor becomes an element id
 * on the same page, so it may never take one of these over.
 */
import { CONFIG_ELEMENT_ID } from '../analytics/constants';

/** Heading of the paywall lock box (article and lesson pages). */
export const LOCKED_TITLE_ID = 'locked-title';
/** Heading of the related-videos list under an article. */
export const RELATED_VIDEOS_ID = 'related-videos';

export const RESERVED_ANCHORS: readonly string[] = [LOCKED_TITLE_ID, RELATED_VIDEOS_ID, CONFIG_ELEMENT_ID, 'main', 'content', 'top'];