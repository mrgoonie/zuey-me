import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ICON_NAMES, iconAliases, iconGroup, resolveIconName } from '../../lib/blocks/icons';
import type { IconName } from '../../lib/blocks/icons';
import { IconGlyph } from '../blocks/block-icons';
import { btnCls, inputCls } from './knowledge-studio-kit';

/** Options per grid row; ArrowUp/ArrowDown move by one row. */
export const PICKER_COLS = 8;

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/gi, 'd').toLowerCase();

/** Search text per icon: name, group and aliases. */
const SEARCH_TEXT: ReadonlyMap<IconName, string> = new Map(
  ICON_NAMES.map(name => [name, fold(`${name} ${name.replace(/-/g, ' ')} ${iconGroup(name)} ${iconAliases(name).join(' ')}`)]),
);

export function filterIcons(query: string): IconName[] {
  const q = fold(query.trim());
  if (!q) return [...ICON_NAMES];
  return ICON_NAMES.filter(name => (SEARCH_TEXT.get(name) ?? name).includes(q));
}

export interface PickerKey { key: string; altKey: boolean; metaKey: boolean; ctrlKey: boolean }

/**
 * Next active index for a navigation key, or null when the picker must not consume the key.
 * Modified keys pass through (Alt+↑/↓ reorders the block card), and ←/→ stay with the text caret
 * while the search box holds a query.
 */
export function pickerMove(e: PickerKey, current: number, count: number, queryEmpty: boolean): number | null {
  if (e.altKey || e.metaKey || e.ctrlKey || count === 0) return null;
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  switch (e.key) {
    case 'ArrowDown': return clamp(current + PICKER_COLS);
    case 'ArrowUp': return clamp(current - PICKER_COLS);
    case 'ArrowRight': return queryEmpty ? clamp(current + 1) : null;
    case 'ArrowLeft': return queryEmpty ? clamp(current - 1) : null;
    case 'Home': return queryEmpty ? 0 : null;
    case 'End': return queryEmpty ? count - 1 : null;
    default: return null;
  }
}

/** Scrolls only the list container (never the page) so the option is fully visible. */
export function revealInList(list: HTMLElement, option: HTMLElement): void {
  const top = option.offsetTop;
  const bottom = top + option.offsetHeight;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}

interface IconPickerProps {
  label: string;
  /** Current value; may be an alias or an invalid name typed in the JSON tab. */
  value: string | undefined;
  onChange: (name: IconName | undefined) => void;
  /** Shows a button that clears the value (optional icon fields). */
  noneLabel?: string;
}

/**
 * Icon field: a chip with the current icon and a disclosure button. The searchable grid is mounted
 * only while open, so a document with many callouts does not render hundreds of SVGs.
 */
export function IconPicker({ label, value, onChange, noneLabel }: IconPickerProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  const resolved = resolveIconName(value);
  const close = () => { setOpen(false); toggleRef.current?.focus(); };
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-stone-500 font-mono">{label}</span>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-stone-700 px-2 py-1 text-xs text-stone-200" data-icon-chip="">
          {resolved
            ? <><IconGlyph name={resolved} size={16} /><span className="font-mono">{resolved}</span></>
            : value
              ? <span className="text-rose-300 font-mono">{value} (không hợp lệ)</span>
              : <span className="text-stone-500">{noneLabel ?? 'Chưa chọn'}</span>}
        </span>
        <button type="button" ref={toggleRef} className={btnCls} aria-expanded={open} aria-controls={open ? panelId : undefined}
          onClick={() => setOpen(o => !o)}>
          {open ? 'Đóng' : 'Chọn icon'}
        </button>
        {noneLabel && value && <button type="button" className={btnCls} onClick={() => onChange(undefined)}>{noneLabel}</button>}
      </div>
      {open && (
        <IconPickerPanel id={panelId} label={label} value={resolved ?? undefined}
          onPick={name => { onChange(name); close(); }} onClose={close} />
      )}
    </div>
  );
}

function IconPickerPanel({ id, label, value, onPick, onClose }: {
  id: string; label: string; value: IconName | undefined; onPick: (name: IconName) => void; onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const items = useMemo(() => filterIcons(query), [query]);
  const [active, setActive] = useState(() => Math.max(0, value ? items.indexOf(value) : 0));
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** Set by keyboard moves only, so opening or typing never scrolls anything. */
  const revealNext = useRef(false);
  const current = Math.min(active, Math.max(items.length - 1, 0));
  const optionId = (name: IconName) => `${listId}-${name}`;

  useEffect(() => { inputRef.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    if (!revealNext.current) return;
    revealNext.current = false;
    const name = items[current];
    const list = listRef.current;
    const option = name && list ? list.querySelector<HTMLElement>(`[data-icon-option="${name}"]`) : null;
    if (list && option) revealInList(list, option);
  }, [current, items]);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const next = pickerMove(e, current, items.length, query === '');
    if (next !== null) {
      revealNext.current = true;
      setActive(next);
    } else if (e.key === 'Enter' && !e.altKey && items[current]) {
      onPick(items[current]);
    } else if (e.key === 'Escape') {
      if (query) { setQuery(''); setActive(0); } else onClose();
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div id={id} className="space-y-1.5 rounded-xl border border-stone-800 p-2">
      <input ref={inputRef} className={inputCls} value={query} placeholder="Tìm icon (vd: arrow, warning, ai, book)…"
        role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
        aria-label={`${label}: tìm icon`}
        aria-activedescendant={items[current] ? optionId(items[current]) : undefined}
        onChange={e => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={onKeyDown} />
      <p className="sr-only" aria-live="polite">{items.length} icon</p>
      <ul id={listId} ref={listRef} role="listbox" aria-label={label}
        className="relative grid grid-cols-8 gap-1 max-h-44 overflow-auto rounded-lg bg-stone-950 p-1">
        {items.length === 0 && <li role="presentation" className="col-span-8 px-2 py-1.5 text-[11px] text-stone-500">Không có icon phù hợp</li>}
        {items.map((name, i) => (
          <li key={name} id={optionId(name)} role="option" aria-selected={name === value} aria-label={name} title={name}
            data-icon-option={name}
            onMouseDown={e => e.preventDefault()}
            onClick={() => onPick(name)}
            className={`flex items-center justify-center h-8 rounded-lg cursor-pointer text-stone-200 ${
              name === value ? 'bg-amber-400 text-stone-950' : i === current ? 'bg-stone-700' : 'hover:bg-stone-800'
            } ${i === current ? 'ring-1 ring-amber-300' : ''}`}>
            <IconGlyph name={name} size={18} />
          </li>
        ))}
      </ul>
    </div>
  );
}
