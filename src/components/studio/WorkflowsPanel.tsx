import { useCallback, useEffect, useState } from 'react';
import type { AdminWorkflow } from '../../lib/workflows/store';
import type { SecretFinding } from '../../lib/workflows/secret-scan';

const API = '/api/v1/workflows';

const TEMPLATE = {
  name: 'My workflow',
  slug: 'my-workflow',
  summary: 'What this workflow does in one sentence.',
  tools: ['Claude Code'],
  trigger: 'When does this run?',
  steps: [{ title: 'First step', detail: 'Optional detail' }],
  metrics: [],
  tags: ['ai'],
};

interface ApiFailure {
  status: number;
  code: string;
  message: string;
  findings: SecretFinding[];
  currentRevision: number | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isFinding(v: unknown): v is SecretFinding {
  return isRecord(v) && typeof v.field === 'string' && typeof v.kind === 'string' && typeof v.excerpt === 'string';
}

function isAdminWorkflow(v: unknown): v is AdminWorkflow {
  return (
    isRecord(v) &&
    typeof v.slug === 'string' &&
    typeof v.name === 'string' &&
    typeof v.revision === 'number' &&
    Array.isArray(v.findings) &&
    Array.isArray(v.steps)
  );
}

/** Calls the workflows API and returns `data` or a normalised failure (never throws). */
async function callApi(path: string, init?: RequestInit): Promise<{ ok: true; data: unknown } | { ok: false; error: ApiFailure }> {
  try {
    const res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok && isRecord(body) && body.success === true) return { ok: true, data: body.data };
    const err = isRecord(body) && isRecord(body.error) ? body.error : {};
    return {
      ok: false,
      error: {
        status: res.status,
        code: typeof err.code === 'string' ? err.code : 'http_error',
        message: typeof err.message === 'string' ? err.message : `Request failed (${res.status})`,
        findings: Array.isArray(err.findings) ? err.findings.filter(isFinding) : [],
        currentRevision: typeof err.current_revision === 'number' ? err.current_revision : null,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: { status: 0, code: 'network_error', message: e instanceof Error ? e.message : 'Network error', findings: [], currentRevision: null },
    };
  }
}

function editableJson(w: AdminWorkflow): string {
  const { name, slug, summary, tools, trigger, steps, metrics, tags } = w;
  return JSON.stringify({ name, slug, summary, tools, trigger, steps, metrics, tags }, null, 2);
}

function parseEditor(text: string): Record<string, unknown> | string {
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? v : 'JSON must be an object';
  } catch (e) {
    return e instanceof Error ? `Invalid JSON: ${e.message}` : 'Invalid JSON';
  }
}

function FindingsList({ findings }: { findings: SecretFinding[] }) {
  if (findings.length === 0) return null;
  return (
    <ul className="mt-2 space-y-1 text-xs font-mono text-red-300">
      {findings.map((f, i) => (
        <li key={`${f.field}-${i}`} className="break-all">
          {f.field}: {f.kind} <span className="text-red-400/80">({f.excerpt})</span>
        </li>
      ))}
    </ul>
  );
}

function ErrorBox({ error }: { error: ApiFailure }) {
  const title =
    error.status === 409
      ? `Revision conflict${error.currentRevision !== null ? ` — server is at revision ${error.currentRevision}. Reload before saving.` : ''}`
      : error.status === 422
        ? 'Publish blocked: secrets or personal data detected'
        : `${error.code} (${error.status || 'network'})`;
  return (
    <div role="alert" className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-200">
      <p className="font-semibold">{title}</p>
      <p className="text-xs mt-1 break-words">{error.message}</p>
      <FindingsList findings={error.findings} />
    </div>
  );
}

export function WorkflowsPanel() {
  const [items, setItems] = useState<AdminWorkflow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [editor, setEditor] = useState('');
  const [error, setError] = useState<ApiFailure | null>(null);
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState<AdminWorkflow | null>(null);

  const current = items.find(w => w.slug === selected) ?? null;

  const load = useCallback(async (focus?: string | null) => {
    setLoading(true);
    const res = await callApi(`${API}?include_drafts=1`);
    setLoading(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const list = Array.isArray(res.data) ? res.data.filter(isAdminWorkflow) : [];
    setItems(list);
    const next = focus === undefined ? null : list.find(w => w.slug === focus) ?? null;
    if (next) {
      setSelected(next.slug);
      setEditor(editableJson(next));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const select = (w: AdminWorkflow | null) => {
    setError(null);
    setNotice('');
    setSelected(w ? w.slug : null);
    setEditor(w ? editableJson(w) : JSON.stringify(TEMPLATE, null, 2));
  };

  const save = async () => {
    const parsed = parseEditor(editor);
    if (typeof parsed === 'string') {
      setError({ status: 400, code: 'invalid_json', message: parsed, findings: [], currentRevision: null });
      return;
    }
    setBusy(true);
    setError(null);
    const res = current
      ? await callApi(`${API}/${current.slug}`, { method: 'PUT', body: JSON.stringify({ ...parsed, expected_revision: current.revision }) })
      : await callApi(API, { method: 'POST', body: JSON.stringify({ ...parsed, expected_revision: 0 }) });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    const saved = isAdminWorkflow(res.data) ? res.data : null;
    setNotice(saved && saved.findings.length > 0 ? 'Draft saved, but it contains findings that will block publishing.' : 'Draft saved.');
    await load(saved?.slug ?? null);
  };

  const publish = async (w: AdminWorkflow) => {
    setConfirmPublish(null);
    setBusy(true);
    setError(null);
    const res = await callApi(`${API}/${w.slug}/publish`, {
      method: 'POST',
      body: JSON.stringify({ expected_revision: w.revision, confirm: true }),
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice(`Published "${w.name}".`);
    await load(w.slug);
  };

  const remove = async (w: AdminWorkflow) => {
    if (!window.confirm(`Delete "${w.name}"? It disappears from the public site.`)) return;
    setBusy(true);
    setError(null);
    const res = await callApi(`${API}/${w.slug}?expected_revision=${w.revision}`, { method: 'DELETE' });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setNotice(`Deleted "${w.name}".`);
    setSelected(null);
    setEditor('');
    await load();
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr] gap-4 text-stone-100">
      <aside className="rounded-2xl border border-stone-800 bg-stone-900/60 p-3 min-w-0">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-sm font-bold">AI Workflows</h2>
          <button
            type="button"
            onClick={() => select(null)}
            className="px-2.5 py-1 text-xs font-bold bg-amber-400 hover:bg-amber-300 text-stone-950 rounded-lg"
          >
            New
          </button>
        </div>
        {loading && <p className="text-xs text-stone-500">Loading…</p>}
        {!loading && items.length === 0 && <p className="text-xs text-stone-500">No workflows yet.</p>}
        <ul className="space-y-1">
          {items.map(w => (
            <li key={w.slug}>
              <button
                type="button"
                onClick={() => select(w)}
                className={`w-full text-left rounded-xl px-3 py-2 border text-xs transition-colors ${
                  w.slug === selected ? 'border-amber-400/60 bg-stone-800' : 'border-stone-800 hover:bg-stone-800/60'
                }`}
              >
                <span className="block font-semibold truncate">{w.name}</span>
                <span className="flex flex-wrap gap-1 mt-1 font-mono text-[10px]">
                  <span className={w.published ? 'text-emerald-400' : 'text-stone-400'}>{w.published ? 'published' : 'draft'}</span>
                  {w.published && w.has_unpublished_changes && <span className="text-amber-300">• unpublished changes</span>}
                  <span className="text-stone-500">rev {w.revision}</span>
                  {w.findings.length > 0 && <span className="text-red-400">• {w.findings.length} findings</span>}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <section className="rounded-2xl border border-stone-800 bg-stone-900/60 p-4 min-w-0 space-y-3">
        {notice && <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-2 text-xs text-emerald-300">{notice}</p>}
        {error && <ErrorBox error={error} />}
        {editor === '' ? (
          <p className="text-sm text-stone-400">Select a workflow or create a new draft. Drafts are never public until you publish.</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold">{current ? `Editing draft: ${current.slug} (rev ${current.revision})` : 'New draft'}</h3>
              {current && current.published_at && (
                <a href={`/workflows/${current.slug}`} target="_blank" rel="noreferrer" className="text-xs text-amber-300 hover:underline">
                  View public version
                </a>
              )}
            </div>
            {current && current.findings.length > 0 && (
              <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-200">
                Findings in current draft (publishing is blocked):
                <FindingsList findings={current.findings} />
              </div>
            )}
            <textarea
              value={editor}
              onChange={e => setEditor(e.target.value)}
              spellCheck={false}
              aria-label="Workflow JSON"
              className="w-full min-h-[360px] px-3 py-2 bg-stone-950 border border-stone-700 rounded-xl text-xs font-mono text-stone-100 focus:outline-none focus:border-amber-400"
            />
            <p className="text-[11px] text-stone-500">
              Fields: name, slug (kebab-case, fixed after create), summary, tools[], trigger, steps[{'{'}title, detail{'}'}] (1–30), metrics[{'{'}label, value{'}'}], tags[].
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => void save()}
                className="px-3 py-2 text-xs font-bold bg-stone-100 hover:bg-white text-stone-950 rounded-lg disabled:opacity-50"
              >
                Save draft
              </button>
              {current && (
                <>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => setConfirmPublish(current)}
                    className="px-3 py-2 text-xs font-bold bg-amber-400 hover:bg-amber-300 text-stone-950 rounded-lg disabled:opacity-50"
                  >
                    Publish…
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void remove(current)}
                    className="px-3 py-2 text-xs font-bold bg-stone-800 hover:bg-red-900 text-red-200 rounded-lg border border-stone-700 disabled:opacity-50"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          </>
        )}
      </section>

      {confirmPublish && (
        <div role="dialog" aria-modal="true" aria-labelledby="wf-publish-title" className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm rounded-2xl border border-stone-700 bg-stone-950 p-5 space-y-3">
            <h4 id="wf-publish-title" className="font-bold">Publish "{confirmPublish.name}"?</h4>
            <p className="text-xs text-stone-400">
              Revision {confirmPublish.revision} of the saved draft becomes public at /workflows/{confirmPublish.slug}. Unsaved editor changes are not included.
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setConfirmPublish(null)} className="px-3 py-2 text-xs rounded-lg bg-stone-800 text-stone-200">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void publish(confirmPublish)}
                className="px-3 py-2 text-xs font-bold rounded-lg bg-amber-400 hover:bg-amber-300 text-stone-950"
              >
                Yes, publish
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
