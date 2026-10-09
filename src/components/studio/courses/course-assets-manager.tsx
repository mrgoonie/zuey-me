import { useState } from 'react';
import type { FormEvent } from 'react';
import { Trash2 } from 'lucide-react';
import type { AssetRecord } from '../../../lib/courses/course-types';
import { Field, StatusLine, api, btnCls, dangerCls, inputCls, primaryCls } from '../knowledge-studio-kit';
import type { ApiResult, StatusMsg } from '../knowledge-studio-kit';
import { bytes, coursePath, errText, uploadForm } from './courses-admin-api';

function AssetRow({ asset, busy, onRename, onDelete }: { asset: AssetRecord; busy: boolean; onRename: (name: string) => void; onDelete: () => void }) {
  const [name, setName] = useState(asset.name);
  return (
    <li className="py-2 flex flex-wrap items-center gap-2 min-w-0">
      <span className="px-1.5 py-0.5 rounded-md text-[10px] font-bold bg-stone-800 text-stone-300">{asset.kind} · {asset.provider}</span>
      <input className={`${inputCls} flex-1`} value={name} onChange={e => setName(e.target.value)} aria-label={`Name of asset ${asset.id}`} />
      <button type="button" className={btnCls} disabled={busy || !name.trim() || name.trim() === asset.name} onClick={() => onRename(name.trim())}>Rename</button>
      <button type="button" className={dangerCls} disabled={busy} onClick={onDelete} aria-label={`Delete asset ${asset.name}`}><Trash2 size={12} /></button>
      <span className="basis-full text-[11px] text-stone-500 font-mono break-all">
        {asset.id} · {asset.ref} · {bytes(asset.size_bytes)}{asset.duration_seconds !== null ? ` · ${asset.duration_seconds}s` : ''}{asset.mime ? ` · ${asset.mime}` : ''}
      </span>
    </li>
  );
}

/** Course media: register Stream videos, upload audio/files to private R2, rename, delete. */
export function CourseAssetsManager({ courseId, assets, onChanged }: { courseId: string; assets: AssetRecord[]; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMsg | null>(null);
  const [uid, setUid] = useState('');
  const [videoName, setVideoName] = useState('');
  const [videoDuration, setVideoDuration] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileKind, setFileKind] = useState<'audio' | 'file'>('file');
  const [fileName, setFileName] = useState('');
  const [fileDuration, setFileDuration] = useState('');
  const [fileInputKey, setFileInputKey] = useState(0);
  const base = `${coursePath(courseId)}/assets`;

  const run = async (fn: () => Promise<ApiResult>, done: string): Promise<boolean> => {
    setBusy(true);
    setStatus(null);
    const r = await fn();
    setStatus(r.ok ? { text: done, error: false } : { text: errText(r), error: true });
    if (r.ok) await onChanged();
    setBusy(false);
    return r.ok;
  };

  const duration = (raw: string): number | undefined => {
    const n = Number(raw);
    return raw.trim() && Number.isInteger(n) && n > 0 ? n : undefined;
  };

  const registerVideo = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await run(() => api(base, { method: 'POST', body: { kind: 'video', stream_uid: uid.trim(), name: videoName.trim(), duration_seconds: duration(videoDuration) } }), 'Video registered.');
    if (ok) { setUid(''); setVideoName(''); setVideoDuration(''); }
  };

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file) return;
    const form = new FormData();
    form.set('file', file);
    form.set('kind', fileKind);
    if (fileName.trim()) form.set('name', fileName.trim());
    const d = duration(fileDuration);
    if (d) form.set('duration_seconds', String(d));
    const ok = await run(() => uploadForm(base, form), 'Uploaded.');
    if (ok) { setFile(null); setFileName(''); setFileDuration(''); setFileInputKey(k => k + 1); }
  };

  const remove = (a: AssetRecord) => {
    const note = a.provider === 'stream' ? ' The Stream video itself stays in Cloudflare Stream.' : ' The file is removed from storage.';
    if (!window.confirm(`Delete asset "${a.name}"?${note} Lessons that use it will show a missing media block.`)) return;
    void run(() => api(`${base}/${encodeURIComponent(a.id)}`, { method: 'DELETE' }), 'Asset deleted.');
  };

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <form onSubmit={e => void registerVideo(e)} className="rounded-xl border border-stone-800 p-3 space-y-2">
          <h4 className="text-xs font-bold text-white">Register a Cloudflare Stream video</h4>
          <p className="text-[11px] text-stone-500">Upload in the Stream dashboard with "Require signed URLs", then paste the 32-character video UID.</p>
          <Field label="Stream UID"><input className={`${inputCls} font-mono`} value={uid} onChange={e => setUid(e.target.value)} required pattern="[a-fA-F0-9]{32}" /></Field>
          <div className="grid grid-cols-[1fr_120px] gap-2">
            <Field label="Name"><input className={inputCls} value={videoName} onChange={e => setVideoName(e.target.value)} required /></Field>
            <Field label="Duration (s)"><input className={inputCls} type="number" min={1} value={videoDuration} onChange={e => setVideoDuration(e.target.value)} /></Field>
          </div>
          <button type="submit" className={primaryCls} disabled={busy}>Register video</button>
        </form>
        <form onSubmit={e => void upload(e)} className="rounded-xl border border-stone-800 p-3 space-y-2">
          <h4 className="text-xs font-bold text-white">Upload audio or a file (private R2, max 95 MB)</h4>
          <Field label="File"><input key={fileInputKey} type="file" className="text-xs text-stone-300" onChange={e => setFile(e.target.files?.[0] ?? null)} required /></Field>
          <div className="grid grid-cols-[110px_1fr_110px] gap-2">
            <Field label="Kind">
              <select className={inputCls} value={fileKind} onChange={e => setFileKind(e.target.value === 'audio' ? 'audio' : 'file')}>
                <option value="file">file</option><option value="audio">audio</option>
              </select>
            </Field>
            <Field label="Name (optional)"><input className={inputCls} value={fileName} onChange={e => setFileName(e.target.value)} /></Field>
            <Field label="Duration (s)"><input className={inputCls} type="number" min={1} value={fileDuration} onChange={e => setFileDuration(e.target.value)} /></Field>
          </div>
          <button type="submit" className={primaryCls} disabled={busy || !file}>{busy ? 'Working…' : 'Upload'}</button>
        </form>
      </div>
      <StatusLine status={status} />
      {assets.length === 0 ? <p className="text-xs text-stone-500">No assets yet.</p> : (
        <ul className="divide-y divide-stone-800">
          {assets.map(a => (
            <AssetRow key={`${a.id}:${a.name}`} asset={a} busy={busy} onDelete={() => remove(a)}
              onRename={name => void run(() => api(`${base}/${encodeURIComponent(a.id)}`, { method: 'PATCH', body: { name } }), 'Renamed.')} />
          ))}
        </ul>
      )}
    </div>
  );
}
