/**
 * Shared article block document schema (version 1).
 * Used by the Studio editor, the React renderer, the Markdown serializer, REST and MCP.
 * Inline text fields accept a tiny safe Markdown subset (see ./inline.ts); raw HTML is never rendered.
 */

export const DOCUMENT_VERSION = 1;

export const LIMITS = {
  totalBlocks: 500,
  text: 20_000,
  shortText: 500,
  code: 50_000,
  mermaid: 20_000,
  url: 2_048,
  listItems: 200,
  tableColumns: 20,
  tableRows: 200,
  chartSeries: 12,
  chartLabels: 100,
  surveyOptionsMin: 2,
  surveyOptionsMax: 10,
  layoutChildren: 12,
  layoutColsMax: 5,
  layoutRowSpanMax: 4,
  /** A layout may contain a layout, but not a third level. */
  layoutDepth: 2,
  /** Interactive (sandboxed HTML/CSS/JS) blocks: per-field and combined source size. */
  interactiveField: 60_000,
  interactiveTotal: 100_000,
  interactiveHeightMin: 120,
  interactiveHeightMax: 1_200,
  math: 10_000,
  galleryImages: 24,
  toggleChildren: 50,
} as const;

export const BLOCK_TYPES = [
  'paragraph', 'heading', 'list', 'checklist', 'quote', 'callout', 'code', 'divider',
  'image', 'embed', 'table', 'chart', 'diagram', 'survey', 'layout', 'interactive',
  // Knowledge media blocks
  'math', 'gallery', 'audio', 'video', 'file', 'bookmark', 'toggle',
] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];

export const EMBED_PROVIDERS = [
  'youtube', 'vimeo', 'soundcloud', 'spotify', 'x', 'facebook', 'instagram', 'tiktok', 'linkedin', 'generic',
] as const;
export type EmbedProvider = (typeof EMBED_PROVIDERS)[number];

export const CALLOUT_TONES = ['info', 'warn', 'tip'] as const;
export const CHART_KINDS = ['bar', 'line', 'pie', 'doughnut'] as const;
export const LAYOUT_VARIANTS = ['columns', 'grid', 'bento'] as const;
export const LAYOUT_GAPS = ['sm', 'md', 'lg'] as const;
export const BREAKPOINTS = ['base', 'md', 'lg'] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

interface BlockBase { id: string }

export interface ParagraphBlock extends BlockBase { type: 'paragraph'; text: string }
export interface HeadingBlock extends BlockBase { type: 'heading'; level: 1 | 2 | 3; text: string }
export interface ListBlock extends BlockBase { type: 'list'; style: 'bullet' | 'number'; items: string[] }
export interface ChecklistItem { text: string; checked: boolean }
export interface ChecklistBlock extends BlockBase { type: 'checklist'; items: ChecklistItem[] }
export interface QuoteBlock extends BlockBase { type: 'quote'; text: string; cite?: string }
export interface CalloutBlock extends BlockBase { type: 'callout'; tone: (typeof CALLOUT_TONES)[number]; text: string }
export interface CodeBlock extends BlockBase { type: 'code'; language: string; code: string }
export interface DividerBlock extends BlockBase { type: 'divider' }
export interface ImageBlock extends BlockBase { type: 'image'; url: string; alt: string; caption?: string }
export interface EmbedBlock extends BlockBase { type: 'embed'; url: string; provider: EmbedProvider; caption?: string }
export interface TableBlock extends BlockBase { type: 'table'; headers: string[]; rows: string[][] }
export interface ChartSeries { name: string; data: number[] }
export interface ChartBlock extends BlockBase {
  type: 'chart';
  kind: (typeof CHART_KINDS)[number];
  title?: string;
  labels: string[];
  series: ChartSeries[];
}
export interface DiagramBlock extends BlockBase { type: 'diagram'; syntax: 'mermaid'; source: string; caption?: string }
export interface SurveyOption { id: string; label: string }
export interface SurveyBlock extends BlockBase { type: 'survey'; question: string; options: SurveyOption[]; allowMultiple?: boolean }

/**
 * Self-contained HTML/CSS/JS demo. Rendered only inside an `<iframe sandbox="allow-scripts">`
 * (opaque origin) with a strict CSP; network access goes through the server fetch proxy.
 */
export interface InteractiveBlock extends BlockBase {
  type: 'interactive';
  title: string;
  html: string;
  css: string;
  js: string;
  /** Initial frame height in CSS pixels. */
  height?: number;
  caption?: string;
}

export interface ResponsiveCols { base: number; md: number; lg: number }
export interface ResponsiveSpan { base?: number; md?: number; lg?: number }
export interface LayoutChild {
  /** Object form is validated per breakpoint; numeric shorthand is clamped to each breakpoint's cols. */
  span?: ResponsiveSpan | number;
  rowSpan?: number;
  blocks: Block[];
}
export interface LayoutBlock extends BlockBase {
  type: 'layout';
  variant: (typeof LAYOUT_VARIANTS)[number];
  cols: ResponsiveCols;
  gap?: (typeof LAYOUT_GAPS)[number];
  children: LayoutChild[];
}

/** TeX source; rendered as accessible source text (no math engine is bundled). */
export interface MathBlock extends BlockBase { type: 'math'; tex: string; caption?: string }
export interface GalleryImage { url: string; alt: string; caption?: string }
export interface GalleryBlock extends BlockBase { type: 'gallery'; images: GalleryImage[]; caption?: string }
/** Direct https audio file (hosted players such as SoundCloud/Spotify use `embed`). */
export interface AudioBlock extends BlockBase { type: 'audio'; url: string; title?: string; caption?: string }
/** Direct https video file (hosted players such as YouTube/Vimeo use `embed`). */
export interface VideoBlock extends BlockBase { type: 'video'; url: string; poster?: string; title?: string; caption?: string }
export interface FileBlock extends BlockBase { type: 'file'; url: string; name: string; sizeBytes?: number; caption?: string }
/** Link preview card; metadata is stored with the block, never fetched while reading. */
export interface BookmarkBlock extends BlockBase {
  type: 'bookmark'; url: string; title?: string; description?: string; image?: string; siteName?: string;
}
/** Collapsible section. Children may not contain toggles or layouts. */
export interface ToggleBlock extends BlockBase { type: 'toggle'; summary: string; open?: boolean; blocks: Block[] }

export type KnowledgeMediaBlock = MathBlock | GalleryBlock | AudioBlock | VideoBlock | FileBlock | BookmarkBlock | ToggleBlock;

export type Block =
  | ParagraphBlock | HeadingBlock | ListBlock | ChecklistBlock | QuoteBlock | CalloutBlock | CodeBlock
  | DividerBlock | ImageBlock | EmbedBlock | TableBlock | ChartBlock | DiagramBlock | SurveyBlock | LayoutBlock
  | InteractiveBlock
  | KnowledgeMediaBlock;

export interface ArticleDocument { version: 1; blocks: Block[] }

export type ArticleAccess = 'free' | 'knowledges';
export type ArticleStatus = 'draft' | 'published';

/** Resolved span per breakpoint, clamped to that breakpoint's column count. */
export function resolveSpan(span: LayoutChild['span'], cols: ResponsiveCols): ResponsiveCols {
  const pick = (bp: Breakpoint): number => {
    const raw = typeof span === 'number' ? span : span?.[bp] ?? 1;
    return Math.max(1, Math.min(raw, cols[bp]));
  };
  return { base: pick('base'), md: pick('md'), lg: pick('lg') };
}

/** Depth-first walk over every block, including blocks nested in layouts and toggles. */
export function walkBlocks(blocks: Block[], visit: (block: Block) => void): void {
  for (const block of blocks) {
    visit(block);
    if (block.type === 'layout') for (const child of block.children) walkBlocks(child.blocks, visit);
    if (block.type === 'toggle') walkBlocks(block.blocks, visit);
  }
}

/** True for a PDF link (by path extension); readers may open those inline on request. */
export function isPdfUrl(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase().endsWith('.pdf');
  } catch {
    return false;
  }
}

export function findBlock(blocks: Block[], id: string): Block | null {
  let found: Block | null = null;
  walkBlocks(blocks, b => { if (!found && b.id === id) found = b; });
  return found;
}

export function emptyDocument(): ArticleDocument {
  return { version: 1, blocks: [] };
}
