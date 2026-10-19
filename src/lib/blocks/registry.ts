/**
 * Block registry: the single server-side source of truth for every block type — validation, Markdown,
 * search and AI text, paywall weight and the OpenAPI / MCP `block_schema` JSON Schema.
 *
 * Adding a block type: add it to `BLOCK_TYPES` and the `Block` union (./schema.ts), write its definition
 * under ./definitions, and list it here (the mapped type below fails to compile until every type has
 * one). Rendering lives in the React renderer (src/components/blocks), the member email renderer
 * (src/lib/notifications/article-email-render.ts) and the Studio editor; this module never imports
 * React. Reader islands never load it: the article renderer does not import it, and the lazy Zuey AI panel
 * validates artifacts through ./validator-core with the interactive definition alone. Only the Studio
 * editor, which validates drafts in the browser, ships it to the client.
 */
import type { BlockDefinition, BlockOf } from './block-definition';
import type { Block, BlockType } from './schema';
import { BLOCK_TYPES } from './schema';
import { callout, checklist, code, divider, heading, icon, list, paragraph, quote } from './definitions/text';
import { audio, bookmark, embed, file, gallery, image, math, video } from './definitions/media';
import { chart, diagram, survey, table } from './definitions/data';
import { interactive } from './definitions/interactive';
import { card, layout, section, toggle } from './definitions/containers';

type BlockRegistry = { readonly [K in BlockType]: BlockDefinition<BlockOf<K>> };

export const BLOCK_REGISTRY: BlockRegistry = {
  paragraph, heading, list, checklist, quote, callout, code, divider,
  image, embed, table, chart, diagram, survey, layout, interactive,
  math, gallery, audio, video, file, bookmark, toggle,
  icon,
  section, card,
};

/** Definition for a block type (callers pass blocks of that same type). */
export function blockDefinition(type: BlockType): BlockDefinition<Block> {
  return BLOCK_REGISTRY[type];
}

/** Every definition in `BLOCK_TYPES` order. */
export function blockDefinitions(): BlockDefinition<Block>[] {
  return BLOCK_TYPES.map(blockDefinition);
}
