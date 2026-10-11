import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ICON_NAMES, iconAliases, iconGroup } from '../../lib/blocks/icons';
import type { IconName } from '../../lib/blocks/icons';
import { IconGlyph } from '../blocks/block-icons';
import { btnCls, inputCls } from './knowledge-studio-kit';

/** Options per row in the grid; arrow up/down move by one row. */
const COLS = 8;

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

interface IconPickerProps {
  label: string;
  value: IconName | undefined;
  onChange: (name: IconName | undefined) => void;
  /** Shows a "none" button that clears the value (optional icon fields). */
  noneLabel?: string;
}

/**
 * Searchable icon picker over the curated allowlist. The search box is a combobox driving a grid
 * listbox: arrow keys move, Home/End jump, Enter picks; every option previews its icon.
 */
export function IconPicker({ label, value, onChange, noneLabel }: IconPickerProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const items = useMemo(() => filterIcons(query), [query]);
  const current = Math.min(active, Math.max(items.length - 1, 0));
  const optionId = (name: IconName) => `${listId}-${name}`;

  useEffect(() => {
    const name = items[current];
    if (!name || !listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-icon-option="${name}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [current, items]);

  const move = (delta: number) => {
    if (!items.length) return;
    setActive(Math.max(0, Math.min(items.length - 1, current + delta)));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowRight') move(1);
    else if (e.key === 'ArrowLeft') move(-1);
    else if (e.key === 'ArrowDown') move(COLS);
    else if (e.key === 'ArrowUp') move(-COLS);
    else if (e.key === 'Home' && e.ctrlKey) setActive(0);
    else if (e.key === 'End' && e.ctrlKey) setActive(Math.max(items.length - 1, 0));
    else if (e.key === 'Enter' && items[current]) onChange(items[current]);
    else if (e.key === 'Escape' && query) setQuery('');
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] uppercase tracking-widest text-stone-500 font-mono">{label}</span>
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-stone-700 px-2 py-1 text-xs text-stone-200">
          {value ? <><IconGlyph name={value} size={16} /><span className="font-mono">{value}</span></> : <span className="text-stone-500">{noneLabel ?? 'Chưa chọn'}</span>}
        </span>
        {noneLabel && value && <button type="button" className={btnCls} onClick={() => onChange(undefined)}>{noneLabel}</button>}
      </div>
      <input className={inputCls} value={query} placeholder="Tìm icon (vd: arrow, warning, ai, book)…"
        role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
        aria-label={`${label}: tìm icon`}
        aria-activedescendant={items[current] ? optionId(items[current]) : undefined}
        onChange={e => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={onKeyDown} />
      <p className="sr-only" aria-live="polite">{items.length} icon</p>
      <ul id={listId} ref={listRef} role="listbox" aria-label={label}
        className="grid grid-cols-8 gap-1 max-h-44 overflow-auto rounded-xl border border-stone-800 bg-stone-950 p-1">
        {items.length === 0 && <li role="presentation" className="col-span-8 px-2 py-1.5 text-[11px] text-stone-500">Không có icon phù hợp</li>}
        {items.map((name, i) => (
          <li key={name} id={optionId(name)} role="option" aria-selected={name === value} aria-label={name} title={name}
            data-icon-option={name}
            onMouseDown={e => e.preventDefault()}
            onClick={() => { setActive(i); onChange(name); }}
            className={`flex items-center justify-center h-8 rounded-lg cursor-pointer text-stone-200 ${
              name === value ? 'bg-amber-400 text-stone-950' : i === current ? 'bg-stone-700' : 'hover:bg-stone-800'
            }`}>
            <IconGlyph name={name} size={18} />
          </li>
        ))}
      </ul>
    </div>
  );
}
