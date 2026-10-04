import React, { useId, useRef } from 'react';
import { ImagePlus, Video } from 'lucide-react';
import { ACCENTS, ACCENT_IDS, THEME_MODES, WALLPAPERS, type Look } from './look';
import type { OsStrings } from './os-i18n';

interface AppearancePanelProps {
  look: Look;
  hasImage: boolean;
  message: string;
  strings: OsStrings['look'];
  onChange: (patch: Partial<Look>) => void;
  onImage: (file: File) => void;
  onReset: () => void;
}

/** Appearance window: theme mode, accent colour, wallpaper presets, photo upload and dim. */
export const AppearancePanel: React.FC<AppearancePanelProps> = ({ look, hasImage, message, strings, onChange, onImage, onReset }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const dimId = useId();
  const modeId = useId();
  const accentId = useId();
  const wallId = useId();

  const pickImage = () => fileRef.current?.click();

  return (
    <div className="os-ap">
      <p className="os-ap-intro">{strings.intro}</p>

      <section className="os-ap-sec" aria-labelledby={modeId}>
        <h3 id={modeId}>{strings.mode}</h3>
        <div className="os-ap-modes" role="radiogroup" aria-labelledby={modeId}>
          {THEME_MODES.map(m => (
            <button key={m} type="button" role="radio" aria-checked={look.mode === m} onClick={() => onChange({ mode: m })}>
              <span className={`os-ap-prev ${m}`} aria-hidden="true"><i /><b /><em /></span>
              {strings.modes[m]}
            </button>
          ))}
        </div>
      </section>

      <section className="os-ap-sec" aria-labelledby={accentId}>
        <h3 id={accentId}>{strings.accent}</h3>
        <div className="os-ap-acc" role="radiogroup" aria-labelledby={accentId}>
          {ACCENT_IDS.map(a => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={look.accent === a}
              aria-label={strings.accents[a]}
              title={strings.accents[a]}
              style={{ ['--sw' as string]: ACCENTS[a][0], ['--sw2' as string]: ACCENTS[a][2] }}
              onClick={() => onChange({ accent: a })}
            />
          ))}
        </div>
      </section>

      <section className="os-ap-sec" aria-labelledby={wallId}>
        <h3 id={wallId}>{strings.wallpaper}</h3>
        <div className="os-ap-wps" role="radiogroup" aria-labelledby={wallId}>
          {WALLPAPERS.map(w => (
            <button
              key={w}
              type="button"
              role="radio"
              aria-checked={look.wallpaper === w}
              onClick={() => (w === 'image' && !hasImage ? pickImage() : onChange({ wallpaper: w }))}
            >
              <span className="os-wp-th" data-wp={w} aria-hidden="true">
                {w === 'video' && <Video aria-hidden />}
                {w === 'image' && !hasImage && <ImagePlus aria-hidden />}
              </span>
              {strings.wallpapers[w]}
            </button>
          ))}
        </div>
        <div className="os-ap-row">
          <button type="button" className="os-btn" onClick={pickImage}>
            <ImagePlus aria-hidden className="w-4 h-4" />{hasImage ? strings.replace : strings.upload}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={e => {
              const f = e.currentTarget.files?.[0];
              e.currentTarget.value = '';
              if (f) onImage(f);
            }}
          />
          <button type="button" className="os-btn os-btn--ghost" onClick={onReset}>{strings.reset}</button>
        </div>
        <p className="os-ap-hint">{strings.uploadHint}</p>
        <p className="os-ap-msg" role="status" aria-live="polite">{message}</p>
        {(look.wallpaper === 'image' || look.wallpaper === 'video') && (
          <label className="os-ap-dim" htmlFor={dimId}>
            <span>{strings.dim}<output htmlFor={dimId}>{look.dim}%</output></span>
            <input id={dimId} type="range" min={0} max={80} step={5} value={look.dim} onChange={e => onChange({ dim: Number(e.currentTarget.value) })} />
          </label>
        )}
      </section>
    </div>
  );
};
