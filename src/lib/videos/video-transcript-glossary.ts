/**
 * Proper nouns the transcript rewrite should spell exactly. Auto-captions mangle product and people
 * names (ClaudeKit → "ClockKit", Codex → "Codax"), and the model cannot know the right spelling, so
 * the system prompt lists the canonical names plus the mis-hearings seen in real captions.
 * Extra names come from the VIDEOS_REWRITE_GLOSSARY variable (comma- or newline-separated,
 * optional "Name = heard1 | heard2" for known mis-hearings).
 */

export interface GlossaryTerm {
  term: string;
  /** Mis-heard forms seen in auto-captions; only listed when the mapping is unambiguous. */
  heardAs?: string[];
}

// Only names the captions actually get wrong. Well-known model names (Opus, GPT…) are left out on purpose:
// listing them made the model "correct" spoken versions such as "GPT 5.6" into ones it knows.
export const DEFAULT_REWRITE_GLOSSARY: GlossaryTerm[] = [
  { term: 'Zuey', heardAs: ['Zowie', 'Zui'] },
  { term: 'ClaudeKit', heardAs: ['ClockKit', 'Clock Kit', 'Clock Kid', 'Cloud Kit', 'Clockwork'] },
  { term: 'AgentKit', heardAs: ['Agent Kit', 'Agent kid'] },
  { term: 'ak CLI', heardAs: ['AKC', 'AK CLI'] },
  { term: 'Dewee', heardAs: ['Dwee'] },
  { term: 'GoClaw', heardAs: ['Go Claude'] },
  { term: 'IndieBoosting', heardAs: ['Indie Boosting'] },
  { term: 'Codex', heardAs: ['Codax', 'Cortex'] },
  { term: 'Antigravity', heardAs: ['Anti-gravity', 'antiravity'] },
  { term: 'Oh My Pi', heardAs: ['Oh my pie'] },
  { term: 'NotebookLM', heardAs: ['NotebookML'] },
  { term: 'Claude Code', heardAs: ['close code'] },
  { term: 'OpenRouter' },
]

/** Parses VIDEOS_REWRITE_GLOSSARY: "Name" or "Name = heard1 | heard2", separated by commas or newlines. */
export function parseGlossary(raw: string | null | undefined): GlossaryTerm[] {
  if (!raw) return [];
  return raw.split(/[,\n]/).flatMap(entry => {
    const [termPart, heardPart] = entry.split('=');
    const term = termPart.trim();
    if (!term) return [];
    const heardAs = (heardPart ?? '').split('|').map(s => s.trim()).filter(Boolean);
    return [heardAs.length > 0 ? { term, heardAs } : { term }];
  });
}

/** Defaults plus extras; an extra with the same name (case-insensitive) replaces the default entry. */
export function mergeGlossary(base: GlossaryTerm[], extra: GlossaryTerm[]): GlossaryTerm[] {
  const byKey = new Map(base.map(t => [t.term.toLowerCase(), t] as const));
  for (const t of extra) byKey.set(t.term.toLowerCase(), t);
  return [...byKey.values()];
}

/** One prompt line per term, e.g. `ClaudeKit (may be mis-heard as "ClockKit", "Cloud Kit")`. */
export function glossaryPromptLines(glossary: GlossaryTerm[]): string[] {
  return glossary.map(t => (t.heardAs?.length ? `${t.term} (may be mis-heard as ${t.heardAs.map(h => `"${h}"`).join(', ')})` : t.term));
}
