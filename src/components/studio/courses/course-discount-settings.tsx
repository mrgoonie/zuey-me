import { useEffect, useState } from 'react';
import { Field, StatusLine, api, inputCls, isObj, primaryCls } from '../knowledge-studio-kit';
import type { StatusMsg } from '../knowledge-studio-kit';
import type { PlanId } from './courses-admin-api';
import { PLAN_IDS, errText, planDiscountsOf } from './courses-admin-api';

const SETTINGS_URL = '/api/v1/admin/course-settings';

/** Global subscriber discount table (plan → %), applied to every course without an override. */
export function CourseDiscountSettings() {
  const [values, setValues] = useState<Partial<Record<PlanId, string>>>({});
  const [defaults, setDefaults] = useState<Partial<Record<PlanId, number>>>({});
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMsg | null>(null);

  const adopt = (data: unknown) => {
    if (!isObj(data)) return;
    const table = planDiscountsOf(data.plan_discounts);
    setValues(Object.fromEntries(PLAN_IDS.map(p => [p, String(table[p] ?? 0)])));
    if (isObj(data.defaults)) setDefaults(planDiscountsOf(data.defaults));
  };

  useEffect(() => {
    void api(SETTINGS_URL).then(r => {
      if (r.ok) adopt(r.data); else setStatus({ text: errText(r), error: true });
      setLoaded(true);
    });
  }, []);

  const save = async () => {
    const table: Partial<Record<PlanId, number>> = {};
    for (const p of PLAN_IDS) {
      const n = Number(values[p]);
      if (!Number.isInteger(n) || n < 0 || n > 90) { setStatus({ text: `${p} must be an integer 0–90`, error: true }); return; }
      table[p] = n;
    }
    setBusy(true);
    setStatus(null);
    const r = await api(SETTINGS_URL, { method: 'PUT', body: { plan_discounts: table } });
    setBusy(false);
    if (!r.ok) { setStatus({ text: errText(r), error: true }); return; }
    adopt(r.data);
    setStatus({ text: 'Discount table saved.', error: false });
  };

  if (!loaded) return <p className="text-xs text-stone-400">Loading…</p>;
  return (
    <div className="space-y-3 max-w-xl">
      <p className="text-xs text-stone-400">
        Members with an active plan get this % off every course (courses can override it). The applied discount is the larger of
        this and a referral discount; they never stack.
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {PLAN_IDS.map(p => (
          <Field key={p} label={`${p} % (default ${defaults[p] ?? '—'})`}>
            <input className={inputCls} type="number" min={0} max={90} value={values[p] ?? ''} onChange={e => setValues({ ...values, [p]: e.target.value })} />
          </Field>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button type="button" className={primaryCls} disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save table'}</button>
        <StatusLine status={status} />
      </div>
    </div>
  );
}
