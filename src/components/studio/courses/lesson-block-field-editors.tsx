import { useState } from 'react';
import type { Block } from '../../../lib/blocks/schema';
import type { AssetRecord } from '../../../lib/courses/course-types';
import type { CourseMediaBlock, GithubRepoBlock } from '../../../lib/courses/lesson-blocks';
import { GITHUB_REPO_RE } from '../../../lib/courses/lesson-blocks';
import { Area, Field, Text, inputCls, isObj } from '../knowledge-studio-kit';

/** Private media widget: pick one of this course's assets. */
export function CourseMediaFields({ block, assets, onChange }: { block: CourseMediaBlock; assets: AssetRecord[]; onChange: (b: CourseMediaBlock) => void }) {
  const known = assets.some(a => a.id === block.assetId);
  return (
    <div className="space-y-2">
      <Field label="Asset">
        <select className={inputCls} value={block.assetId} onChange={e => onChange({ ...block, assetId: e.target.value })}>
          <option value="">Choose a course asset…</option>
          {!known && block.assetId && <option value={block.assetId}>Missing asset ({block.assetId})</option>}
          {assets.map(a => <option key={a.id} value={a.id}>{a.kind} · {a.name}</option>)}
        </select>
      </Field>
      {assets.length === 0 && <p className="text-[11px] text-amber-300">This course has no assets yet: add one in the Assets tab first.</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <Text label="Title (optional)" value={block.title ?? ''} onChange={v => onChange({ ...block, title: v || undefined })} />
        <Text label="Caption (optional)" value={block.caption ?? ''} onChange={v => onChange({ ...block, caption: v || undefined })} />
      </div>
    </div>
  );
}

/** Private GitHub repository card (owners are invited as collaborators). */
export function GithubRepoFields({ block, onChange }: { block: GithubRepoBlock; onChange: (b: GithubRepoBlock) => void }) {
  const invalid = block.repo !== '' && !GITHUB_REPO_RE.test(block.repo);
  return (
    <div className="space-y-2">
      <Text label="Repository (owner/name)" value={block.repo} onChange={repo => onChange({ ...block, repo: repo.trim() })} placeholder="mrgoonie/course-starter" />
      {invalid && <p className="text-[11px] text-rose-400" role="alert">Use the form owner/name.</p>}
      <Text label="Title (optional)" value={block.title ?? ''} onChange={v => onChange({ ...block, title: v || undefined })} />
      <Area label="Description (optional)" value={block.description ?? ''} rows={2} onChange={v => onChange({ ...block, description: v || undefined })} />
    </div>
  );
}

/**
 * Article blocks inside a lesson. Paragraphs and headings get plain fields; every other article
 * block is edited as JSON (the full article editor is not reusable outside ArticleEditor).
 * `onValidity` reports JSON that does not parse so the lesson cannot be saved half-edited.
 */
export function ArticleBlockFields({ block, onChange, onValidity }: { block: Block; onChange: (b: Block) => void; onValidity: (ok: boolean) => void }) {
  const [text, setText] = useState(() => JSON.stringify(block, null, 2));
  const [error, setError] = useState<string | null>(null);

  if (block.type === 'paragraph') {
    return <Area label="Paragraph (Markdown inline: **bold**, *italic*, `code`, [link](url))" value={block.text} rows={4} onChange={t => onChange({ ...block, text: t })} />;
  }
  if (block.type === 'heading') {
    return (
      <div className="grid grid-cols-[90px_1fr] gap-2">
        <Field label="Level">
          <select className={inputCls} value={block.level} onChange={e => onChange({ ...block, level: e.target.value === '1' ? 1 : e.target.value === '3' ? 3 : 2 })}>
            <option value="1">H1</option><option value="2">H2</option><option value="3">H3</option>
          </select>
        </Field>
        <Text label="Heading" value={block.text} onChange={t => onChange({ ...block, text: t })} />
      </div>
    );
  }

  const edit = (raw: string) => {
    setText(raw);
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObj(parsed) || typeof parsed.type !== 'string') throw new Error('Block must be a JSON object with a "type"');
      if (parsed.type !== block.type) throw new Error(`Keep "type": "${block.type}" (add a new block to change type)`);
      setError(null);
      onValidity(true);
      onChange({ ...parsed, id: block.id } as unknown as Block); // full validation runs on save
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Invalid JSON');
      onValidity(false);
    }
  };

  return (
    <div>
      <Field label={`${block.type} block (JSON)`}>
        <textarea className={`${inputCls} font-mono`} rows={Math.min(16, Math.max(4, text.split('\n').length))} value={text}
          onChange={e => edit(e.target.value)} aria-invalid={error !== null} spellCheck={false} />
      </Field>
      {error && <p className="text-[11px] text-rose-400 mt-1" role="alert">{error}</p>}
    </div>
  );
}
