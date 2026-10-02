import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Cloud, CloudFog, CloudLightning, CloudRain, CloudSnow, CloudSun, LocateFixed, Moon, Sun, X } from 'lucide-react';
import type { WeatherCondition, WeatherReport } from '../../lib/experience/weather';
import type { Locale } from '../../lib/i18n/locales';
import type { HomeStrings } from './home-i18n';
import { fmt } from './home-i18n';
import { apiFetch, parseWeather } from './api-client';
import { STORAGE_KEYS, isRecord, readStored, writeStored } from './storage';

/** Stored only in this browser. Coordinates are rounded to one decimal (~11 km) before storage. */
type WeatherPreference =
  | { mode: 'off' }
  | { mode: 'city'; city: string }
  | { mode: 'geo'; lat: number; lon: number };

type Status = 'idle' | 'loading' | 'denied' | 'unsupported' | 'offline' | 'notFound' | 'failed';

const REFRESH_MS = 30 * 60 * 1000;
const round1 = (n: number) => Math.round(n * 10) / 10;

function readPreference(): WeatherPreference {
  const raw = readStored(STORAGE_KEYS.weather);
  if (!isRecord(raw)) return { mode: 'off' };
  if (raw.mode === 'city' && typeof raw.city === 'string' && raw.city.trim().length > 0 && raw.city.length <= 80) {
    return { mode: 'city', city: raw.city.trim() };
  }
  if (raw.mode === 'geo' && typeof raw.lat === 'number' && typeof raw.lon === 'number'
    && Math.abs(raw.lat) <= 90 && Math.abs(raw.lon) <= 180) {
    return { mode: 'geo', lat: round1(raw.lat), lon: round1(raw.lon) };
  }
  return { mode: 'off' };
}

export function WeatherIcon({ condition, isDay, className = 'w-4 h-4' }: { condition: WeatherCondition | null; isDay: boolean; className?: string }) {
  const props = { className, 'aria-hidden': true } as const;
  switch (condition) {
    case 'clear': return isDay ? <Sun {...props} /> : <Moon {...props} />;
    case 'clouds': return <Cloud {...props} />;
    case 'fog': return <CloudFog {...props} />;
    case 'rain': return <CloudRain {...props} />;
    case 'snow': return <CloudSnow {...props} />;
    case 'storm': return <CloudLightning {...props} />;
    default: return <CloudSun {...props} />;
  }
}

interface WeatherControlProps {
  strings: HomeStrings['weather'];
  locale: Locale;
  onReport: (report: WeatherReport | null) => void;
}

/**
 * Opt-in weather: nothing is requested until the visitor picks a city or allows an approximate
 * location. The choice lives in localStorage only; the server sees just the city or rounded coords.
 */
export const WeatherControl: React.FC<WeatherControlProps> = ({ strings, locale, onReport }) => {
  const [open, setOpen] = useState(false);
  const [pref, setPref] = useState<WeatherPreference>({ mode: 'off' });
  const [report, setReport] = useState<WeatherReport | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [city, setCity] = useState('');
  const panelId = useId();
  const inputId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const requestRef = useRef(0);

  const publish = useCallback((next: WeatherReport | null) => {
    setReport(next);
    onReport(next);
  }, [onReport]);

  const load = useCallback(async (p: WeatherPreference) => {
    const ticket = ++requestRef.current;
    if (p.mode === 'off') {
      setStatus('idle');
      publish(null);
      return;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      setStatus('offline');
      publish(null);
      return;
    }
    setStatus('loading');
    const qs = p.mode === 'city'
      ? `city=${encodeURIComponent(p.city)}&lang=${locale}`
      : `lat=${p.lat}&lon=${p.lon}`;
    const res = await apiFetch(`/api/v1/weather?${qs}`, parseWeather);
    if (ticket !== requestRef.current) return;
    if (res.ok) {
      setStatus('idle');
      publish(res.data);
      return;
    }
    publish(null);
    setStatus(res.status === 0 ? 'offline' : res.code === 'city_not_found' ? 'notFound' : 'failed');
  }, [locale, publish]);

  // Restore the stored choice, refresh periodically, and follow connectivity changes.
  useEffect(() => {
    const stored = readPreference();
    setPref(stored);
    if (stored.mode === 'city') setCity(stored.city);
    void load(stored);
  }, [load]);

  useEffect(() => {
    if (pref.mode === 'off') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load(pref);
    }, REFRESH_MS);
    const onOnline = () => void load(pref);
    const onOffline = () => { setStatus('offline'); publish(null); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [pref, load, publish]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (e.target instanceof Node && !rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (next: WeatherPreference) => {
    setPref(next);
    writeStored(STORAGE_KEYS.weather, next);
    void load(next);
  };

  const submitCity = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const value = city.trim().slice(0, 80);
    if (value) choose({ mode: 'city', city: value });
  };

  const useLocation = () => {
    if (typeof navigator === 'undefined' || !('geolocation' in navigator)) {
      setStatus('unsupported');
      return;
    }
    setStatus('loading');
    navigator.geolocation.getCurrentPosition(
      pos => choose({ mode: 'geo', lat: round1(pos.coords.latitude), lon: round1(pos.coords.longitude) }),
      err => setStatus(err.code === err.PERMISSION_DENIED ? 'denied' : 'failed'),
      { enableHighAccuracy: false, maximumAge: 30 * 60 * 1000, timeout: 10000 },
    );
  };

  const conditionLabel = report ? (!report.is_day && report.condition === 'clear' ? strings.conditions.night : strings.conditions[report.condition]) : '';
  const place = report ? (pref.mode === 'geo' ? strings.nearYou : report.place?.name ?? strings.nearYou) : '';
  const summary = report
    ? fmt(strings.now, { condition: conditionLabel, temp: report.temperature_c === null ? '–' : Math.round(report.temperature_c), place })
    : '';
  const statusText: Record<Status, string> = {
    idle: '', loading: strings.loading, denied: strings.denied, unsupported: strings.unsupported,
    offline: strings.offline, notFound: strings.notFound, failed: strings.failed,
  };

  return (
    <div ref={rootRef} className="home-popover-anchor">
      <button
        ref={triggerRef}
        type="button"
        className="home-chip"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={report ? `${strings.button}: ${summary}` : strings.button}
        onClick={() => setOpen(v => !v)}
        data-press
      >
        <WeatherIcon condition={report?.condition ?? null} isDay={report?.is_day ?? true} />
        <span className="home-chip-label">
          {report && report.temperature_c !== null ? `${Math.round(report.temperature_c)}°` : strings.button}
        </span>
      </button>
      {open && (
        <div className="home-popover" id={panelId} role="group" aria-label={strings.title}>
          <div className="flex items-start justify-between gap-2">
            <h2 className="font-serif text-lg font-extrabold leading-tight">{strings.title}</h2>
            <button type="button" className="home-icon-btn -mt-2 -mr-2" aria-label={strings.close} onClick={() => { setOpen(false); triggerRef.current?.focus(); }}>
              <X aria-hidden="true" className="w-4 h-4" />
            </button>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-stone-600">{strings.intro}</p>

          <form className="mt-3 flex gap-2" onSubmit={submitCity}>
            <label htmlFor={inputId} className="sr-only">{strings.city}</label>
            <input
              id={inputId}
              type="text"
              inputMode="text"
              autoComplete="address-level2"
              maxLength={80}
              value={city}
              onChange={e => setCity(e.target.value)}
              placeholder={strings.cityPlaceholder}
              className="min-w-0 flex-1 h-11 rounded-xl border border-stone-300 bg-white px-3 text-[15px] text-stone-900 placeholder:text-stone-400 focus:outline-none focus-visible:outline focus-visible:outline-[3px] focus-visible:outline-amber-500"
            />
            <button type="submit" className="home-cta shrink-0" data-press>{strings.useCity}</button>
          </form>

          <button type="button" className="home-cta home-cta--ghost mt-2 w-full" onClick={useLocation} data-press>
            <LocateFixed aria-hidden="true" className="w-4 h-4" />{strings.geo}
          </button>
          <p className="mt-1.5 text-[12px] text-stone-500">{strings.geoNote}</p>

          <p className="mt-3 min-h-[20px] text-[13px] font-semibold text-stone-800" role="status" aria-live="polite">
            {statusText[status] || summary}
          </p>

          <div className="mt-2 flex items-center justify-between gap-2">
            <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer" className="text-[12px] text-stone-500 underline underline-offset-2 hover:text-stone-900">
              {strings.attribution}
            </a>
            {pref.mode !== 'off' && (
              <button type="button" className="home-cta home-cta--ghost !min-h-[36px] !px-3 text-[13px]" onClick={() => choose({ mode: 'off' })} data-press>
                {strings.off}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
