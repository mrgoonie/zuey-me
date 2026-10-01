import { useEffect, useState } from 'react';
import type { SurveyBlock as SurveyBlockData } from '../../lib/blocks/schema';
import type { SurveyOptionResult, SurveyResults } from '../../lib/blocks/survey';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toOption(v: unknown): SurveyOptionResult | null {
  if (!isRecord(v) || typeof v.id !== 'string' || typeof v.label !== 'string' || typeof v.count !== 'number' || typeof v.percent !== 'number') return null;
  return { id: v.id, label: v.label, count: v.count, percent: v.percent };
}

/** Narrows an API payload to SurveyResults without casts. */
export function parseSurveyResults(v: unknown): SurveyResults | null {
  if (!isRecord(v) || typeof v.block_id !== 'string' || typeof v.total_voters !== 'number' || !Array.isArray(v.options)) return null;
  const options = v.options.map(toOption);
  if (options.some(o => o === null)) return null;
  return {
    block_id: v.block_id,
    question: typeof v.question === 'string' ? v.question : '',
    allow_multiple: v.allow_multiple === true,
    total_voters: v.total_voters,
    voted: v.voted === true,
    options: options.filter((o): o is SurveyOptionResult => o !== null),
  };
}

async function readEnvelope(res: Response): Promise<{ data: unknown; code: string; message: string; extra: Record<string, unknown> }> {
  const body: unknown = await res.json().catch(() => null);
  if (!isRecord(body)) return { data: null, code: 'bad_response', message: 'Phản hồi không hợp lệ', extra: {} };
  const err = isRecord(body.error) ? body.error : {};
  return {
    data: body.data,
    code: typeof err.code === 'string' ? err.code : '',
    message: typeof err.message === 'string' ? err.message : '',
    extra: err,
  };
}

const ERROR_TEXT: Record<string, string> = {
  rate_limited: 'Bạn bình chọn quá nhanh. Vui lòng thử lại sau ít phút.',
  survey_locked: 'Khảo sát này nằm trong phần dành cho thành viên.',
  survey_unconfigured: 'Bình chọn tạm thời chưa khả dụng.',
  invalid_options: 'Lựa chọn không hợp lệ.',
};

interface Props {
  block: SurveyBlockData;
  /** Slug of the published article; voting is disabled without it (e.g. editor preview). */
  articleSlug?: string;
  interactive?: boolean;
}

export function SurveyBlock({ block, articleSlug, interactive = true }: Props) {
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<SurveyResults | null>(null);
  const [status, setStatus] = useState<{ text: string; error: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const enabled = interactive && Boolean(articleSlug);
  const inputType = block.allowMultiple ? 'checkbox' : 'radio';

  useEffect(() => {
    if (!enabled || !articleSlug) return;
    let cancelled = false;
    fetch(`/api/v1/surveys/${encodeURIComponent(block.id)}/results?article_slug=${encodeURIComponent(articleSlug)}`, { credentials: 'same-origin' })
      .then(readEnvelope)
      .then(({ data }) => {
        const parsed = parseSurveyResults(data);
        if (!cancelled && parsed?.voted) setResults(parsed);
      })
      .catch(() => { /* results stay hidden until the reader votes */ });
    return () => { cancelled = true; };
  }, [enabled, articleSlug, block.id]);

  const toggle = (id: string) => {
    setSelected(prev => (block.allowMultiple ? (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]) : [id]));
  };

  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    if (!enabled || !articleSlug || selected.length === 0) return;
    setBusy(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/v1/surveys/${encodeURIComponent(block.id)}/vote`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ article_slug: articleSlug, option_ids: selected }),
      });
      const env = await readEnvelope(res);
      if (res.ok) {
        setResults(parseSurveyResults(env.data));
        setStatus({ text: 'Cảm ơn bạn đã bình chọn!', error: false });
      } else if (res.status === 409) {
        setResults(parseSurveyResults(env.extra.results));
        setStatus({ text: 'Bạn đã bình chọn khảo sát này rồi.', error: false });
      } else {
        setStatus({ text: ERROR_TEXT[env.code] ?? (env.message || 'Không gửi được bình chọn.'), error: true });
      }
    } catch {
      setStatus({ text: 'Không kết nối được máy chủ. Vui lòng thử lại.', error: true });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="zb-survey">
      {results ? (
        <div>
          <p style={{ fontWeight: 800, fontSize: '1.05rem', margin: 0 }}>{block.question}</p>
          {results.options.map(o => (
            <div className="zb-bar" key={o.id}>
              <div className="zb-bar-label"><span>{o.label}</span><span>{o.percent}% · {o.count}</span></div>
              <div className="zb-bar-track" role="progressbar" aria-label={o.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={o.percent}>
                <div className="zb-bar-fill" style={{ width: `${o.percent}%` }} />
              </div>
            </div>
          ))}
          <p className="zb-status" style={{ marginTop: '0.6rem' }}>{results.total_voters} người đã bình chọn</p>
        </div>
      ) : (
        <form onSubmit={submit}>
          <fieldset disabled={!enabled || busy}>
            <legend>{block.question}</legend>
            {block.options.map(o => (
              <label className="zb-survey-option" key={o.id}>
                <input type={inputType} name={`survey-${block.id}`} value={o.id} checked={selected.includes(o.id)} onChange={() => toggle(o.id)} />
                <span>{o.label}</span>
              </label>
            ))}
          </fieldset>
          <div className="zb-survey-actions">
            <button type="submit" className="zb-btn" disabled={!enabled || busy || selected.length === 0}>
              {busy ? 'Đang gửi…' : 'Bình chọn'}
            </button>
            {!enabled && <span className="zb-status">Bình chọn khả dụng sau khi bài viết được xuất bản.</span>}
          </div>
        </form>
      )}
      <p className={`zb-status${status?.error ? ' zb-status-error' : ''}`} aria-live="polite" role="status">{status?.text ?? ''}</p>
    </div>
  );
}
