/** JSON Schema fragments shared by block definitions (OpenAPI 3.1 dialect). */
import { LIMITS } from '../schema';
import { ICON_ALIASES, ICON_NAMES } from '../icons';

export const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
export const inline = { type: 'string', maxLength: LIMITS.text, description: 'Inline text: **bold**, *italic*, ~~strike~~, ==highlight==, `code`, [label](https://...) — no HTML' };
export const short = { type: 'string', maxLength: LIMITS.shortText };
export const blockId = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Unique within the document; generated when omitted' };
export const httpsUrl = { type: 'string', format: 'uri', pattern: '^https://', maxLength: LIMITS.url };
export const colsInt = { type: 'integer', minimum: 1, maximum: LIMITS.layoutColsMax };
/** Natural pixel size; send both or neither. Readers reserve the box before the image loads (no layout shift). */
export const imageSize = {
  width: { type: 'integer', minimum: 1, maximum: LIMITS.imagePixels, description: 'Natural width in pixels; requires height' },
  height: { type: 'integer', minimum: 1, maximum: LIMITS.imagePixels, description: 'Natural height in pixels; requires width' },
};
export const imageSizeTogether = { width: ['height'], height: ['width'] };
export const iconName = {
  type: 'string',
  enum: [...ICON_NAMES, ...Object.keys(ICON_ALIASES)],
  description: 'Curated Lucide icon name (https://lucide.dev/icons). Aliases are accepted and stored as the canonical name; anything else is rejected.',
};
