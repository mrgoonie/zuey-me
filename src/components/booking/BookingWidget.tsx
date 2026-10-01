import { useCallback, useEffect, useMemo, useState } from 'react';
import { isValidTimeZone, zonedDateKey } from '../../lib/booking/timezone';

// ---------------------------------------------------------------------------
// Types and API helpers (responses are validated, never blindly cast)
// ---------------------------------------------------------------------------

interface Slot { start: string; end: string; duration_min: number }

interface SepayInfo {
  bank_account: string;
  bank_code: string;
  amount: number;
  transfer_content: string;
  qr_url: string;
}

interface GuestBooking {
  id: string;
  code: string;
  status: string;
  slot_start: string;
  slot_end: string;
  hold_expires_at: string;
  guest_name: string;
  guest_timezone: string | null;
  payment_method: string;
  meet_url: string | null;
  can_reschedule: boolean;
  reschedule_blocked_reason: string | null;
  sepay: SepayInfo | null;
}

type ApiResult = { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function callApi(url: string, init?: RequestInit): Promise<ApiResult> {
  try {
    const res = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
    const body: unknown = await res.json().catch(() => null);
    if (isRecord(body) && body.success === true && isRecord(body.data)) return { ok: true, data: body.data };
    const err = isRecord(body) && isRecord(body.error) ? body.error : {};
    return {
      ok: false,
      code: typeof err.code === 'string' ? err.code : `http_${res.status}`,
      message: typeof err.message === 'string' ? err.message : 'Đã có lỗi xảy ra. Vui lòng thử lại.',
    };
  } catch {
    return { ok: false, code: 'network_error', message: 'Không kết nối được máy chủ. Kiểm tra mạng và thử lại.' };
  }
}

function str(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  return typeof v === 'string' ? v : '';
}

function parseSlots(data: Record<string, unknown>): Slot[] {
  const list = Array.isArray(data.slots) ? data.slots : [];
  return list.filter(isRecord).map(s => ({ start: str(s, 'start'), end: str(s, 'end'), duration_min: Number(s.duration_min) || 90 }))
    .filter(s => s.start && s.end);
}

function parseSepay(v: unknown): SepayInfo | null {
  if (!isRecord(v) || typeof v.qr_url !== 'string') return null;
  return {
    bank_account: str(v, 'bank_account'),
    bank_code: str(v, 'bank_code'),
    amount: typeof v.amount === 'number' ? v.amount : 0,
    transfer_content: str(v, 'transfer_content'),
    qr_url: v.qr_url,
  };
}

function parseBooking(d: Record<string, unknown>): GuestBooking {
  return {
    id: str(d, 'id'),
    code: str(d, 'code'),
    status: str(d, 'status'),
    slot_start: str(d, 'slot_start'),
    slot_end: str(d, 'slot_end'),
    hold_expires_at: str(d, 'hold_expires_at'),
    guest_name: str(d, 'guest_name'),
    guest_timezone: typeof d.guest_timezone === 'string' ? d.guest_timezone : null,
    payment_method: str(d, 'payment_method'),
    meet_url: typeof d.meet_url === 'string' ? d.meet_url : null,
    can_reschedule: d.can_reschedule === true,
    reschedule_blocked_reason: typeof d.reschedule_blocked_reason === 'string' ? d.reschedule_blocked_reason : null,
    sepay: parseSepay(d.sepay),
  };
}

function browserTimeZone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && isValidTimeZone(tz) ? tz : 'Asia/Ho_Chi_Minh';
  } catch {
    return 'Asia/Ho_Chi_Minh';
  }
}

const COMMON_ZONES = [
  'Asia/Ho_Chi_Minh', 'Asia/Bangkok', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul', 'Asia/Shanghai', 'Asia/Kolkata',
  'Asia/Dubai', 'Australia/Sydney', 'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'America/New_York',
  'America/Chicago', 'America/Los_Angeles', 'UTC',
];

function zoneOptions(current: string): string[] {
  let zones: string[] = COMMON_ZONES;
  const intl: unknown = Intl;
  if (isRecord(intl) && typeof intl.supportedValuesOf === 'function') {
    try {
      const values: unknown = intl.supportedValuesOf('timeZone');
      if (Array.isArray(values)) zones = values.filter((z): z is string => typeof z === 'string');
    } catch {
      // keep the curated list
    }
  }
  return zones.includes(current) ? zones : [current, ...zones];
}

function formatTime(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('vi-VN', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

function formatFull(iso: string, tz: string): string {
  return new Intl.DateTimeFormat('vi-VN', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
}

function useCountdown(targetIso: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!targetIso) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [targetIso]);
  return targetIso ? Math.max(0, Date.parse(targetIso) - now) : 0;
}

function mmss(ms: number): string {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

const card = 'w-full max-w-[640px] mx-auto bg-[#F5EFEB] rounded-[28px] border border-stone-200/90 shadow-floating-card px-4 py-6 sm:p-8 text-stone-900';
const btnPrimary = 'inline-flex items-center justify-center gap-2 px-5 py-3 rounded-full bg-stone-900 text-amber-50 font-semibold text-sm hover:bg-black disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2';
const btnGhost = 'inline-flex items-center justify-center px-4 py-2.5 rounded-full border border-stone-300 bg-white/80 text-stone-800 text-sm font-medium hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500';
const input = 'w-full min-w-0 px-3.5 py-2.5 rounded-xl border border-stone-300 bg-white text-sm text-stone-900 placeholder-stone-400 focus:outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200';

// ---------------------------------------------------------------------------
// Slot picker: month calendar in the guest's time zone
// ---------------------------------------------------------------------------

const WEEKDAYS = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];

interface SlotPickerProps {
  slots: Slot[];
  tz: string;
  selected: string | null;
  onSelect: (slot: Slot) => void;
}

function SlotPicker({ slots, tz, selected, onSelect }: SlotPickerProps) {
  const byDay = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const s of slots) {
      const key = zonedDateKey(Date.parse(s.start), tz);
      const list = map.get(key) ?? [];
      list.push(s);
      map.set(key, list);
    }
    return map;
  }, [slots, tz]);

  const firstKey = useMemo(() => [...byDay.keys()].sort()[0] ?? zonedDateKey(Date.now(), tz), [byDay, tz]);
  const [month, setMonth] = useState(() => firstKey.slice(0, 7));
  const [day, setDay] = useState<string | null>(null);
  useEffect(() => {
    setMonth(firstKey.slice(0, 7));
    setDay(null);
  }, [firstKey]);

  const [y, m] = month.split('-').map(Number);
  const firstWeekday = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthLabel = new Intl.DateTimeFormat('vi-VN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, 1)));
  const shift = (delta: number) => {
    const d = new Date(Date.UTC(y, m - 1 + delta, 1));
    setMonth(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  };
  const cells: Array<string | null> = [
    ...Array.from({ length: firstWeekday }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`),
  ];
  const daySlots = day ? byDay.get(day) ?? [] : [];

  if (slots.length === 0) {
    return <p className="text-sm text-stone-700 bg-white/70 rounded-xl p-4">Hiện chưa có lịch trống trong 60 ngày tới. Vui lòng quay lại sau hoặc email hi@zuey.me.</p>;
  }

  return (
    <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,180px)]">
      <div className="min-w-0">
        <div className="flex items-center justify-between mb-2">
          <button type="button" className={btnGhost} onClick={() => shift(-1)} aria-label="Tháng trước">‹</button>
          <span className="font-semibold capitalize text-sm" aria-live="polite">{monthLabel}</span>
          <button type="button" className={btnGhost} onClick={() => shift(1)} aria-label="Tháng sau">›</button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-[11px] font-semibold text-stone-500 mb-1" aria-hidden="true">
          {WEEKDAYS.map(w => <span key={w}>{w}</span>)}
        </div>
        <div className="grid grid-cols-7 gap-1" role="group" aria-label="Chọn ngày">
          {cells.map((key, i) => {
            if (!key) return <span key={`e${i}`} />;
            const available = byDay.has(key);
            const isSelected = key === day;
            return (
              <button
                key={key}
                type="button"
                disabled={!available}
                onClick={() => setDay(key)}
                aria-pressed={isSelected}
                aria-label={`Ngày ${Number(key.slice(8))}${available ? `, ${byDay.get(key)?.length ?? 0} khung giờ trống` : ', không có lịch'}`}
                className={`aspect-square min-w-0 rounded-lg text-xs sm:text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                  isSelected ? 'bg-stone-900 text-amber-50' : available ? 'bg-white hover:bg-amber-100 text-stone-900 border border-stone-300' : 'text-stone-400 cursor-not-allowed'
                }`}
              >
                {Number(key.slice(8))}
              </button>
            );
          })}
        </div>
      </div>
      <div className="min-w-0">
        <p className="text-xs font-semibold text-stone-600 mb-2">{day ? 'Khung giờ trống' : 'Chọn một ngày có lịch'}</p>
        <div className="grid grid-cols-2 sm:grid-cols-1 gap-2">
          {daySlots.map(s => (
            <button
              key={s.start}
              type="button"
              onClick={() => onSelect(s)}
              aria-pressed={selected === s.start}
              className={`px-3 py-2 rounded-xl text-sm font-semibold border focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 ${
                selected === s.start ? 'bg-amber-400 border-amber-500 text-stone-950' : 'bg-white border-stone-300 hover:border-stone-500'
              }`}
            >
              {formatTime(s.start, tz)}–{formatTime(s.end, tz)}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function TimeZoneSelect({ tz, onChange, id }: { tz: string; onChange: (tz: string) => void; id: string }) {
  const options = useMemo(() => zoneOptions(tz), [tz]);
  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2 mb-4 min-w-0">
      <label htmlFor={id} className="text-xs font-semibold text-stone-600 shrink-0">Múi giờ hiển thị</label>
      <select id={id} value={tz} onChange={e => onChange(e.target.value)} className={`${input} sm:max-w-xs`}>
        {options.map(z => <option key={z} value={z}>{z}</option>)}
      </select>
    </div>
  );
}

function useSlots(): { slots: Slot[]; loading: boolean; error: string | null; reload: () => void } {
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setLoading(true);
    callApi('/api/v1/booking/slots?days=60').then(r => {
      if (r.ok) { setSlots(parseSlots(r.data)); setError(null); } else setError(r.message);
      setLoading(false);
    });
  }, []);
  useEffect(load, [load]);
  return { slots, loading, error, reload: load };
}

// ---------------------------------------------------------------------------
// Booking widget (public /business page)
// ---------------------------------------------------------------------------

type Step = 1 | 2 | 3 | 4;
type Method = 'polar' | 'sepay';

interface HoldState {
  booking: GuestBooking;
  manageUrl: string;
  token: string;
  polarUrl: string | null;
  sepay: SepayInfo | null;
}

const STEP_LABELS = ['Chọn giờ', 'Thông tin', 'Thanh toán', 'Xác nhận'];

const METHOD_COPY: Record<Method, [string, string]> = {
  sepay: ['Chuyển khoản VietQR (SePay)', 'Chuyển khoản VND, xác nhận tự động khi nhận tiền.'],
  polar: ['Thẻ quốc tế (Polar)', 'Thanh toán USD qua trang Polar an toàn.'],
};

export function BookingWidget({ methods }: { methods: Method[] }) {
  const [step, setStep] = useState<Step>(1);
  const [tz, setTz] = useState('Asia/Ho_Chi_Minh');
  useEffect(() => setTz(browserTimeZone()), []);
  const { slots, loading, error: slotsError, reload } = useSlots();
  const [slot, setSlot] = useState<Slot | null>(null);
  const [form, setForm] = useState({ name: '', email: '', company: '', notes: '' });
  const [method, setMethod] = useState<Method>(methods[0] ?? 'sepay');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hold, setHold] = useState<HoldState | null>(null);
  const remaining = useCountdown(hold?.booking.hold_expires_at ?? null);

  const formValid = form.name.trim().length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim());

  const submit = async () => {
    if (!slot) return;
    setBusy(true);
    setError(null);
    const held = await callApi('/api/v1/booking/hold', {
      method: 'POST',
      body: JSON.stringify({ slot_start: slot.start, ...form, timezone: tz, payment_method: method }),
    });
    if (!held.ok) {
      setBusy(false);
      if (held.code === 'slot_taken' || held.code === 'slot_unavailable') {
        setError('Khung giờ này vừa có người giữ. Vui lòng chọn giờ khác.');
        setSlot(null);
        setStep(1);
        reload();
      } else if (held.code === 'payment_unconfigured') {
        setError(`Phương thức thanh toán này chưa sẵn sàng (${held.message}). Vui lòng chọn phương thức khác hoặc email hi@zuey.me.`);
      } else setError(held.message);
      return;
    }
    const bookingData = isRecord(held.data.booking) ? held.data.booking : {};
    const booking = parseBooking(bookingData);
    const token = str(held.data, 'manage_token');
    const manageUrl = `/booking/${encodeURIComponent(booking.id)}?token=${encodeURIComponent(token)}`;
    const co = await callApi(`/api/v1/booking/${encodeURIComponent(booking.id)}/checkout`, { method: 'POST', body: JSON.stringify({ token }) });
    setBusy(false);
    setHold({
      booking,
      manageUrl,
      token,
      polarUrl: co.ok && typeof co.data.url === 'string' ? co.data.url : null,
      sepay: co.ok ? parseSepay(co.data) : null,
    });
    if (!co.ok) setError(co.code === 'payment_unconfigured' ? `Thanh toán chưa được cấu hình: ${co.message}` : co.message);
    setStep(4);
  };

  const expired = hold !== null && remaining === 0;

  return (
    <section className={card} aria-labelledby="booking-title">
      <h2 id="booking-title" className="text-xl sm:text-2xl font-bold font-serif">Đặt lịch tư vấn</h2>
      <ol className="mt-3 mb-5 grid grid-cols-4 gap-1 text-[11px] sm:text-xs" aria-label="Các bước">
        {STEP_LABELS.map((label, i) => (
          <li
            key={label}
            aria-current={step === i + 1 ? 'step' : undefined}
            className={`rounded-full px-1 py-1.5 text-center font-semibold truncate ${step === i + 1 ? 'bg-stone-900 text-amber-50' : step > i + 1 ? 'bg-amber-200 text-stone-900' : 'bg-stone-200/70 text-stone-500'}`}
          >
            {i + 1}. {label}
          </li>
        ))}
      </ol>

      <div aria-live="assertive" role="status" className="min-h-0">
        {error && <p className="mb-4 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-sm p-3">{error}</p>}
      </div>

      {step === 1 && (
        <div>
          <TimeZoneSelect tz={tz} onChange={setTz} id="booking-tz" />
          {loading && <p className="text-sm text-stone-600">Đang tải lịch trống…</p>}
          {slotsError && <p className="text-sm text-rose-700">{slotsError} <button type="button" className="underline" onClick={reload}>Thử lại</button></p>}
          {!loading && !slotsError && <SlotPicker slots={slots} tz={tz} selected={slot?.start ?? null} onSelect={s => { setSlot(s); setError(null); }} />}
          <div className="mt-5 flex justify-end">
            <button type="button" className={btnPrimary} disabled={!slot} onClick={() => setStep(2)}>Tiếp tục</button>
          </div>
        </div>
      )}

      {step === 2 && (
        <form
          className="grid gap-3"
          onSubmit={e => { e.preventDefault(); if (formValid) setStep(3); }}
        >
          {slot && <p className="text-sm font-medium">Đã chọn: {formatFull(slot.start, tz)} ({tz})</p>}
          <label className="grid gap-1 text-sm font-medium">Họ tên *
            <input className={input} required maxLength={120} value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} autoComplete="name" />
          </label>
          <label className="grid gap-1 text-sm font-medium">Email *
            <input className={input} required type="email" maxLength={254} value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} autoComplete="email" />
          </label>
          <label className="grid gap-1 text-sm font-medium">Công ty
            <input className={input} maxLength={160} value={form.company} onChange={e => setForm({ ...form, company: e.target.value })} autoComplete="organization" />
          </label>
          <label className="grid gap-1 text-sm font-medium">Bạn muốn giải quyết vấn đề gì?
            <textarea className={`${input} min-h-[96px]`} maxLength={2000} value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} />
          </label>
          <div className="mt-2 flex flex-wrap justify-between gap-2">
            <button type="button" className={btnGhost} onClick={() => setStep(1)}>Quay lại</button>
            <button type="submit" className={btnPrimary} disabled={!formValid}>Tiếp tục</button>
          </div>
        </form>
      )}

      {step === 3 && (
        <div className="grid gap-3">
          {methods.length === 0 ? (
            <p className="rounded-xl bg-amber-50 border border-amber-200 text-sm p-3">
              Thanh toán trực tuyến đang tạm đóng. Vui lòng email <a className="underline" href="mailto:hi@zuey.me">hi@zuey.me</a> để đặt lịch.
            </p>
          ) : methods.length === 1 ? (
            <div className="rounded-xl border border-stone-900 bg-white p-3">
              <p className="text-sm font-semibold">Thanh toán $1,999 — {METHOD_COPY[methods[0]][0]}</p>
              <p className="text-xs text-stone-600">{METHOD_COPY[methods[0]][1]}</p>
            </div>
          ) : (
            <fieldset className="grid gap-2">
              <legend className="text-sm font-semibold mb-1">Phương thức thanh toán — $1,999</legend>
              {methods.map(value => (
                <label key={value} className={`flex gap-3 items-start rounded-xl border p-3 cursor-pointer ${method === value ? 'border-stone-900 bg-white' : 'border-stone-300 bg-white/60'}`}>
                  <input type="radio" name="payment" value={value} checked={method === value} onChange={() => setMethod(value)} className="mt-1 accent-stone-900" />
                  <span className="min-w-0"><span className="block text-sm font-semibold">{METHOD_COPY[value][0]}</span><span className="block text-xs text-stone-600">{METHOD_COPY[value][1]}</span></span>
                </label>
              ))}
            </fieldset>
          )}
          <p className="text-xs text-stone-600">Khi bấm “Giữ chỗ”, khung giờ được giữ cho bạn trong 15 phút để hoàn tất thanh toán. Lịch chỉ được xác nhận khi hệ thống nhận được thanh toán.</p>
          <div className="mt-2 flex flex-wrap justify-between gap-2">
            <button type="button" className={btnGhost} onClick={() => setStep(2)} disabled={busy}>Quay lại</button>
            <button type="button" className={btnPrimary} onClick={submit} disabled={busy || methods.length === 0}>{busy ? 'Đang giữ chỗ…' : 'Giữ chỗ & thanh toán'}</button>
          </div>
        </div>
      )}

      {step === 4 && hold && (
        <div className="grid gap-4">
          <p className="text-sm">
            Khung giờ <strong>{formatFull(hold.booking.slot_start, tz)}</strong> ({tz}) đang được giữ. Mã đặt lịch: <strong>{hold.booking.code}</strong>
          </p>
          <p className={`text-center text-3xl font-bold tabular-nums ${expired ? 'text-rose-700' : ''}`} role="timer" aria-live="polite" aria-atomic="true">
            {expired ? 'Hết thời gian giữ chỗ' : mmss(remaining)}
          </p>
          {!expired && hold.polarUrl && (
            <a href={hold.polarUrl} className={`${btnPrimary} w-full`}>Thanh toán $1,999 qua Polar</a>
          )}
          {!expired && hold.sepay && (
            <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)] items-start">
              <img src={hold.sepay.qr_url} alt={`Mã VietQR chuyển khoản ${hold.sepay.amount.toLocaleString('vi-VN')} VND`} width={180} height={180} className="w-44 h-44 mx-auto rounded-xl bg-white p-2 border border-stone-300" />
              <dl className="text-sm grid gap-1 min-w-0 break-words">
                <div><dt className="inline font-semibold">Ngân hàng: </dt><dd className="inline">{hold.sepay.bank_code}</dd></div>
                <div><dt className="inline font-semibold">Số tài khoản: </dt><dd className="inline">{hold.sepay.bank_account}</dd></div>
                <div><dt className="inline font-semibold">Số tiền: </dt><dd className="inline">{hold.sepay.amount.toLocaleString('vi-VN')} VND</dd></div>
                <div><dt className="inline font-semibold">Nội dung: </dt><dd className="inline font-mono">{hold.sepay.transfer_content}</dd></div>
              </dl>
            </div>
          )}
          <p className="text-xs text-stone-600">
            Lưu lại đường link quản lý để theo dõi trạng thái, nhận link Google Meet và dời lịch (một lần):{' '}
            <a className="underline break-all" href={hold.manageUrl}>{`${typeof window === 'undefined' ? '' : window.location.origin}${hold.manageUrl}`}</a>
          </p>
          {expired && (
            <button type="button" className={btnGhost} onClick={() => { setHold(null); setSlot(null); setError(null); setStep(1); reload(); }}>Chọn lại giờ</button>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Manage view (/booking/[id]?token=...)
// ---------------------------------------------------------------------------

const STATUS_TEXT: Record<string, string> = {
  held: 'Đang giữ chỗ — chờ thanh toán',
  confirmed: 'Đã xác nhận',
  expired: 'Đã hết hạn giữ chỗ',
  cancelled: 'Đã huỷ',
  needs_attention: 'Đang được Zuey kiểm tra thanh toán',
};

const RESCHEDULE_REASON: Record<string, string> = {
  not_confirmed: 'Chỉ lịch đã xác nhận mới có thể dời.',
  already_rescheduled: 'Bạn đã dời lịch một lần; vui lòng email hi@zuey.me nếu cần thay đổi thêm.',
  too_close_to_start: 'Chỉ có thể dời lịch trước buổi tư vấn ít nhất 48 giờ.',
};

export function BookingManage({ bookingId }: { bookingId: string }) {
  const [token, setToken] = useState<string | null>(null);
  const [booking, setBooking] = useState<GuestBooking | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tz, setTz] = useState('Asia/Ho_Chi_Minh');
  const [showReschedule, setShowReschedule] = useState(false);
  const [newSlot, setNewSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const { slots, loading: slotsLoading, reload } = useSlots();
  const remaining = useCountdown(booking?.status === 'held' ? booking.hold_expires_at : null);

  useEffect(() => {
    setToken(new URLSearchParams(window.location.search).get('token'));
    setTz(browserTimeZone());
  }, []);

  const load = useCallback(async () => {
    if (!token) return;
    const r = await callApi(`/api/v1/booking/${encodeURIComponent(bookingId)}?token=${encodeURIComponent(token)}`);
    if (r.ok) { setBooking(parseBooking(r.data)); setError(null); } else setError(r.message);
  }, [bookingId, token]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (booking?.status !== 'held') return undefined;
    const t = setInterval(() => { void load(); }, 5000);
    return () => clearInterval(t);
  }, [booking?.status, load]);

  const rescheduleSlots = useMemo(() => {
    const cutoff = Date.now() + 48 * 3_600_000;
    return slots.filter(s => Date.parse(s.start) >= cutoff && s.start !== booking?.slot_start);
  }, [slots, booking?.slot_start]);

  const reschedule = async () => {
    if (!newSlot || !token) return;
    setBusy(true);
    const r = await callApi(`/api/v1/booking/${encodeURIComponent(bookingId)}/reschedule`, {
      method: 'POST',
      body: JSON.stringify({ token, slot_start: newSlot.start }),
    });
    setBusy(false);
    if (r.ok) {
      setBooking(parseBooking(r.data));
      setShowReschedule(false);
      setNotice('Đã dời lịch. Lời mời cập nhật đã được gửi nếu email được cấu hình.');
    } else {
      setNotice(null);
      setError(r.message);
      reload();
    }
  };

  if (token === null && booking === null && !error) {
    return <section className={card}><p className="text-sm">Đang tải…</p></section>;
  }

  return (
    <section className={card} aria-labelledby="manage-title">
      <h1 id="manage-title" className="text-xl sm:text-2xl font-bold font-serif">Lịch tư vấn Zuey for Business</h1>
      <div aria-live="assertive" role="status">
        {error && <p className="mt-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-sm p-3">{error}</p>}
        {notice && <p className="mt-3 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm p-3">{notice}</p>}
      </div>
      {!token && <p className="mt-3 text-sm">Thiếu mã quản lý trong đường link. Hãy mở đúng link bạn nhận được khi đặt lịch.</p>}
      {booking && (
        <div className="mt-4 grid gap-4">
          <TimeZoneSelect tz={tz} onChange={setTz} id="manage-tz" />
          <dl className="grid gap-2 text-sm">
            <div><dt className="inline font-semibold">Trạng thái: </dt><dd className="inline">{STATUS_TEXT[booking.status] ?? booking.status}</dd></div>
            <div><dt className="inline font-semibold">Thời gian: </dt><dd className="inline">{formatFull(booking.slot_start, tz)} – {formatTime(booking.slot_end, tz)} ({tz})</dd></div>
            <div><dt className="inline font-semibold">Mã đặt lịch: </dt><dd className="inline font-mono">{booking.code}</dd></div>
          </dl>

          {booking.status === 'held' && (
            <div className="grid gap-3">
              <p className="text-center text-2xl font-bold tabular-nums" role="timer" aria-live="polite">{mmss(remaining)}</p>
              <p className="text-xs text-stone-600">Trang tự cập nhật khi thanh toán được ghi nhận.</p>
              {booking.sepay && (
                <div className="grid gap-3 sm:grid-cols-[180px_minmax(0,1fr)] items-start">
                  <img src={booking.sepay.qr_url} alt="Mã VietQR chuyển khoản" width={180} height={180} className="w-44 h-44 mx-auto rounded-xl bg-white p-2 border border-stone-300" />
                  <dl className="text-sm grid gap-1 min-w-0 break-words">
                    <div><dt className="inline font-semibold">Số tiền: </dt><dd className="inline">{booking.sepay.amount.toLocaleString('vi-VN')} VND</dd></div>
                    <div><dt className="inline font-semibold">Nội dung: </dt><dd className="inline font-mono">{booking.sepay.transfer_content}</dd></div>
                    <div><dt className="inline font-semibold">Tài khoản: </dt><dd className="inline">{booking.sepay.bank_code} · {booking.sepay.bank_account}</dd></div>
                  </dl>
                </div>
              )}
            </div>
          )}

          {booking.status === 'confirmed' && (
            booking.meet_url
              ? <a className={`${btnPrimary} w-full`} href={booking.meet_url} target="_blank" rel="noopener noreferrer">Mở Google Meet</a>
              : <p className="text-sm text-stone-700">Link Google Meet sẽ được Zuey gửi qua email trước buổi tư vấn.</p>
          )}
          {booking.status === 'needs_attention' && (
            <p className="text-sm text-stone-700">Zuey đã nhận thông tin thanh toán và sẽ liên hệ qua email để xử lý. Bạn không cần thanh toán lại.</p>
          )}

          {booking.status === 'confirmed' && (
            booking.can_reschedule ? (
              <div className="grid gap-3">
                {!showReschedule && <button type="button" className={btnGhost} onClick={() => setShowReschedule(true)}>Dời lịch (được 1 lần)</button>}
                {showReschedule && (
                  <>
                    {slotsLoading ? <p className="text-sm">Đang tải lịch trống…</p> : <SlotPicker slots={rescheduleSlots} tz={tz} selected={newSlot?.start ?? null} onSelect={setNewSlot} />}
                    <div className="flex flex-wrap justify-between gap-2">
                      <button type="button" className={btnGhost} onClick={() => setShowReschedule(false)}>Huỷ</button>
                      <button type="button" className={btnPrimary} disabled={!newSlot || busy} onClick={reschedule}>{busy ? 'Đang dời…' : 'Xác nhận giờ mới'}</button>
                    </div>
                  </>
                )}
              </div>
            ) : (
              <p className="text-xs text-stone-600">{RESCHEDULE_REASON[booking.reschedule_blocked_reason ?? ''] ?? 'Không thể dời lịch.'}</p>
            )
          )}
          <p className="text-xs text-stone-600">Cần huỷ hoặc hoàn tiền? Email <a className="underline" href="mailto:hi@zuey.me">hi@zuey.me</a> — Zuey xử lý thủ công.</p>
        </div>
      )}
    </section>
  );
}

