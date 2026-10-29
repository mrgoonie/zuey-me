/**
 * Self-hosted KaTeX stylesheet (fonts are emitted next to it and fetched by the browser only for glyphs a
 * formula uses). Pages link it only when their document has math; it is not part of the global CSS.
 */
import katexStylesheet from 'katex/dist/katex.min.css?url';

export const KATEX_CSS_URL: string = katexStylesheet;
