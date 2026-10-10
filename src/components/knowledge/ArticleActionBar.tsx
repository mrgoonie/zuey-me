import { Sparkles } from 'lucide-react';
import type { Locale } from '../../lib/i18n/locales';
import { OPEN_ARTICLE_AI_EVENT } from '../ai/article-chat-context';
import { ShareMenu } from './ShareMenu';
import { knowledgeStrings } from './strings';
import './article-action-bar.css';

interface Props {
  locale: Locale;
  title: string;
  /** Public canonical URL of this edition. */
  publicUrl: string;
  /** Public Markdown URL of this edition. */
  markdownUrl: string;
  /** True only when the signed-in reader may read this paid article in full. */
  canCopyPrivate: boolean;
}

/** AI deep links carry only the public URL in a prefilled prompt. */
const AI_TARGETS: Array<{ name: string; url: (prompt: string) => string }> = [
  { name: 'ChatGPT', url: p => `https://chatgpt.com/?q=${encodeURIComponent(p)}` },
  { name: 'Claude', url: p => `https://claude.ai/new?q=${encodeURIComponent(p)}` },
  { name: 'Gemini', url: p => `https://gemini.google.com/app?q=${encodeURIComponent(p)}` },
];

/** Sticky bottom bar on article pages: home, share (social + copy), Zuey AI, and send-to-AI shortcuts. */
export function ArticleActionBar({ locale, title, publicUrl, markdownUrl, canCopyPrivate }: Props) {
  const t = knowledgeStrings(locale);
  const prompt = t.aiPrompt(publicUrl);

  return (
    <nav className="zab" aria-label={t.articleActions}>
      <a href="/" className="zab-btn" aria-label={t.home} title={t.home}>
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h5v-6h4v6h5V9.5" />
        </svg>
        <span className="hidden sm:inline">{t.home}</span>
      </a>
      <ShareMenu locale={locale} title={title} publicUrl={publicUrl} markdownUrl={markdownUrl} canCopyPrivate={canCopyPrivate} />
      <span className="zab-sep" aria-hidden="true" />
      <button type="button" className="zab-btn zab-ai zab-zuey" onClick={() => window.dispatchEvent(new Event(OPEN_ARTICLE_AI_EVENT))}>
        <Sparkles size={14} aria-hidden="true" />Zuey AI
      </button>
      {AI_TARGETS.map(target => (
        <a key={target.name} className="zab-btn zab-ai" href={target.url(prompt)} target="_blank" rel="noopener noreferrer" aria-label={t.askAi(target.name)} title={t.askAi(target.name)}>
          {target.name}
        </a>
      ))}
    </nav>
  );
}

export default ArticleActionBar;
