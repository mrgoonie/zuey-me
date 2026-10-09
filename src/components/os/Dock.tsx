import React, { useRef } from 'react';
import { GraduationCap } from 'lucide-react';
import { DOCK_APPS, type AppId } from './apps';
import { AppGlyph } from './AppGlyph';
import type { OsStrings } from './os-i18n';
import type { WinMap } from './window-store';

interface DockProps {
  wins: WinMap;
  avatar: string;
  expoOn: boolean;
  reduced: boolean;
  strings: OsStrings;
  onLaunch: (id: AppId) => void;
  onExpo: () => void;
}

const MAX_SCALE = 1.55;
const REACH = 150;

/**
 * Desktop dock: apps (Alt+1…9), Exposé and Appearance, then the standalone Courses page.
 * A running app shows a dot (dimmed when minimized). Icons magnify near the pointer.
 */
export const Dock: React.FC<DockProps> = ({ wins, avatar, expoOn, reduced, strings, onLaunch, onExpo }) => {
  const ref = useRef<HTMLElement>(null);

  const magnify = (e: React.PointerEvent<HTMLElement>) => {
    const dock = ref.current;
    if (!dock || reduced || e.pointerType !== 'mouse') return;
    dock.classList.add('is-fish');
    for (const item of Array.from(dock.querySelectorAll<HTMLElement>('.os-di'))) {
      const r = item.getBoundingClientRect();
      const d = Math.abs(e.clientX - (r.left + r.width / 2));
      const s = d >= REACH ? 1 : 1 + (MAX_SCALE - 1) * Math.cos((d / REACH) * (Math.PI / 2));
      item.style.setProperty('--s', s.toFixed(3));
    }
  };
  const reset = () => {
    const dock = ref.current;
    if (!dock) return;
    dock.classList.remove('is-fish');
    for (const item of Array.from(dock.querySelectorAll<HTMLElement>('.os-di'))) item.style.removeProperty('--s');
  };

  const item = (id: AppId, i: number | null) => {
    const w = wins[id];
    const running = w.open;
    const label = strings.apps[id];
    const key = i !== null && i < 9 ? `Alt ${i + 1}` : null;
    return (
      <li key={id}>
        <button
          type="button"
          className={`os-di${running ? ' is-run' : ''}${running && w.min ? ' is-min' : ''}`}
          data-dock-app={id}
          aria-label={running && w.min ? `${label} (${strings.expo.minimized})` : label}
          aria-current={running && !w.min ? 'true' : undefined}
          aria-keyshortcuts={key ? `Alt+${(i ?? 0) + 1}` : undefined}
          onClick={() => onLaunch(id)}
        >
          <AppGlyph id={id} avatar={avatar} />
          <span className="os-tip" aria-hidden="true">{label}{key && <kbd>{key}</kbd>}</span>
        </button>
      </li>
    );
  };

  return (
    <nav ref={ref} className="os-dock" aria-label={strings.dock} onPointerMove={magnify} onPointerLeave={reset} data-mascot-avoid>
      <ul>
        {DOCK_APPS.map((id, i) => item(id, i))}
        <li className="os-dock-sep" aria-hidden="true" />
        <li>
          <button type="button" className="os-di" aria-pressed={expoOn} aria-keyshortcuts="Alt+O" aria-label={strings.allWindows} onClick={onExpo}>
            <AppGlyph id="expose" />
            <span className="os-tip" aria-hidden="true">{strings.allWindows}<kbd>Alt O</kbd></span>
          </button>
        </li>
        {item('appearance', null)}
        <li>
          <a className="os-di" href="/courses" aria-label={strings.links.courses}>
            <span className="os-g os-g--flow" aria-hidden="true"><GraduationCap aria-hidden /></span>
            <span className="os-tip" aria-hidden="true">{strings.links.courses}</span>
          </a>
        </li>
      </ul>
    </nav>
  );
};
