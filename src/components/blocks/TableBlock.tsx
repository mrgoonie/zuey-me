import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { TableBlock, TableColumn } from '../../lib/blocks/schema';
import {
  badgeTone, columnOf, csvFilename, filterChoices, filterKind, formatCell, isFilterActive, isNumericColumn, linkCell, tableCsv, tableLocale, visibleRows,
} from '../../lib/blocks/table-data';
import type { ColumnFilter, TableLocale, TableSort } from '../../lib/blocks/table-data';
import { BlockFrame } from './BlockFrame';

const LABELS = {
  vi: {
    download: 'Tải CSV',
    search: 'Tìm trong bảng',
    searchPlaceholder: 'Gõ để lọc hàng…',
    all: 'Tất cả',
    from: 'từ',
    to: 'đến',
    reset: 'Bỏ lọc',
    empty: 'Không có hàng phù hợp.',
    region: 'Bảng dữ liệu',
    asc: 'tăng dần',
    desc: 'giảm dần',
    status: (shown: number, total: number, sorted: string) => `Hiển thị ${shown}/${total} hàng${sorted ? `, sắp xếp theo ${sorted}` : ''}`,
  },
  en: {
    download: 'Download CSV',
    search: 'Search the table',
    searchPlaceholder: 'Type to filter rows…',
    all: 'All',
    from: 'from',
    to: 'to',
    reset: 'Clear filters',
    empty: 'No matching rows.',
    region: 'Data table',
    asc: 'ascending',
    desc: 'descending',
    status: (shown: number, total: number, sorted: string) => `Showing ${shown} of ${total} rows${sorted ? `, sorted by ${sorted}` : ''}`,
  },
} as const;

/** Longest search or filter text; longer pastes are cut so one input event stays cheap. */
const QUERY_MAX = 200;

export interface DataTableProps {
  block: TableBlock;
  /** Renders inline Markdown (text cells, caption). */
  renderInline: (text: string) => ReactNode;
  /** Edition locale: number, date and label language (Vietnamese for `vi`, English otherwise). */
  locale?: string;
}

function CellView({ col, raw, renderInline, locale }: { col: TableColumn; raw: string; renderInline: DataTableProps['renderInline']; locale: TableLocale }) {
  if (raw === '') return null;
  // Every case renders one node: in cards mode the cell is a label/value grid, and a second node would start a new grid row.
  switch (col.type) {
    case 'text': return <span>{renderInline(raw)}</span>;
    case 'badge': return <span className={`zb-dt-badge zb-dt-tone-${badgeTone(raw)}`}>{raw}</span>;
    case 'link': {
      const link = linkCell(raw);
      return link ? <a href={link.href} target="_blank" rel="noopener noreferrer nofollow">{link.label}</a> : <>{raw}</>;
    }
    case 'boolean':
      // One element, so the mark and its word stay together in the card grid.
      return <span><span className={raw === 'true' ? 'zb-dt-yes' : 'zb-dt-no'} aria-hidden="true">{raw === 'true' ? '✓' : '✗'}</span> {formatCell(col, raw, locale)}</span>;
    case 'date': return <time dateTime={raw}>{formatCell(col, raw, locale)}</time>;
    default: return <>{formatCell(col, raw, locale)}</>;
  }
}

function emptyFilter(col: TableColumn, choices: string[] | null): ColumnFilter {
  if (filterKind(col) === 'range') return { kind: 'range', min: '', max: '' };
  return choices ? { kind: 'value', value: '' } : { kind: 'contains', value: '' };
}

interface FilterProps {
  block: TableBlock;
  column: number;
  value: ColumnFilter | undefined;
  onChange: (f: ColumnFilter) => void;
  locale: TableLocale;
}

/** One column filter: a from/to range (numbers, dates), a value list, or a text box when values are too many to list. */
function FilterControl({ block, column, value, onChange, locale }: FilterProps) {
  const text = LABELS[locale];
  const col = columnOf(block, column);
  const header = block.headers[column] ?? '';
  const choices = useMemo(() => (filterKind(col) === 'value' ? filterChoices(block, column, locale) : null), [block, column, col, locale]);
  const current = value ?? emptyFilter(col, choices);
  if (current.kind === 'range') {
    const type = col.type === 'date' ? 'date' : 'number';
    return (
      <fieldset className="zb-dt-field zb-dt-range">
        <legend>{header}</legend>
        <input type={type} step={type === 'number' ? 'any' : undefined} inputMode={type === 'number' ? 'decimal' : undefined} value={current.min}
          aria-label={`${header} ${text.from}`} placeholder={text.from} onChange={e => onChange({ ...current, min: e.target.value })} />
        <input type={type} step={type === 'number' ? 'any' : undefined} inputMode={type === 'number' ? 'decimal' : undefined} value={current.max}
          aria-label={`${header} ${text.to}`} placeholder={text.to} onChange={e => onChange({ ...current, max: e.target.value })} />
      </fieldset>
    );
  }
  if (current.kind === 'value' && choices) {
    return (
      <label className="zb-dt-field">
        <span>{header}</span>
        <select value={current.value} onChange={e => onChange({ kind: 'value', value: e.target.value })}>
          <option value="">{text.all}</option>
          {choices.map(c => <option key={c} value={c}>{formatCell(col, c, locale)}</option>)}
        </select>
      </label>
    );
  }
  return (
    <label className="zb-dt-field">
      <span>{header}</span>
      <input type="text" maxLength={QUERY_MAX} value={current.value} onChange={e => onChange({ kind: 'contains', value: e.target.value })} />
    </label>
  );
}

function nextSort(sort: TableSort | null, column: number): TableSort | null {
  if (sort?.column !== column) return { column, dir: 'asc' };
  return sort.dir === 'asc' ? { column, dir: 'desc' } : null;
}

/**
 * Data table. The server renders the whole table with formatted values, so readers without script (and search
 * engines) get every row; sort buttons, search, filters and CSV export appear once the block is hydrated, and
 * the first client render matches the server HTML. On narrow screens `mobile: 'cards'` stacks each row as
 * label/value pairs once hydrated: the labels are added on the client, so the server HTML does not repeat every
 * header in every cell, and without script the table scrolls sideways like the default mode.
 */
export function DataTable({ block, renderInline, locale: editionLocale }: DataTableProps) {
  const locale = tableLocale(editionLocale);
  const text = LABELS[locale];
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<Record<number, ColumnFilter>>({});
  const [sort, setSort] = useState<TableSort | null>(null);
  useEffect(() => { setMounted(true); }, []);

  const columns = block.headers.map((_, i) => columnOf(block, i));
  const order = useMemo(() => visibleRows(block, { query, filters, sort }, locale), [block, query, filters, sort, locale]);
  const filterColumns = columns.flatMap((c, i) => (c.filter ? [i] : []));
  const showControls = mounted && (block.search === true || filterColumns.length > 0);
  const sortable = mounted && block.sortable === true;
  const cards = mounted && block.mobile === 'cards';
  const titleId = `zb-dt-${block.id}`;
  const filtered = query.trim() !== '' || Object.values(filters).some(isFilterActive);
  const sortedName = sort ? `${block.headers[sort.column] ?? ''} ${text[sort.dir]}` : '';
  // Stacked rows lose table semantics in some screen readers; explicit roles keep them.
  const role = (r: string) => (cards ? r : undefined);

  const classes = ['zb-dt', cards ? 'zb-dt-cards' : '', block.sortable ? 'zb-dt-sortable' : ''].filter(Boolean).join(' ');
  return (
    <BlockFrame
      className={classes}
      title={block.title ? <span id={titleId}>{block.title}</span> : undefined}
      caption={block.caption ? renderInline(block.caption) : undefined}
      download={block.csv ? () => ({ filename: csvFilename(block), data: tableCsv(block, order), type: 'text/csv;charset=utf-8' }) : undefined}
      labels={{ download: text.download }}
    >
      {showControls && (
        <div className="zb-dt-controls">
          {block.search && (
            <label className="zb-dt-field zb-dt-search">
              <span>{text.search}</span>
              <input type="search" maxLength={QUERY_MAX} value={query} placeholder={text.searchPlaceholder} onChange={e => setQuery(e.target.value)} />
            </label>
          )}
          {filterColumns.map(i => (
            <FilterControl key={i} block={block} column={i} value={filters[i]} locale={locale} onChange={f => setFilters(prev => ({ ...prev, [i]: f }))} />
          ))}
          {filtered && (
            <button type="button" className="zb-dt-reset" onClick={() => { setQuery(''); setFilters({}); }}>{text.reset}</button>
          )}
        </div>
      )}
      {mounted && (block.search || filterColumns.length > 0 || block.sortable) && (
        <p className="zb-dt-status" role="status">{text.status(order.length, block.rows.length, sortedName)}</p>
      )}
      {/* Focusable so keyboard users can scroll a wide or sticky-header table; it carries the table's name once. */}
      <div className={`zb-scroll zb-dt-scroll${block.stickyHeader ? ' zb-dt-sticky' : ''}`} role="region" tabIndex={0}
        aria-labelledby={block.title ? titleId : undefined} aria-label={block.title ? undefined : text.region}>
        <table className="zb-table" role={role('table')}>
          <thead role={role('rowgroup')}>
            <tr role={role('row')}>
              {block.headers.map((h, i) => {
                const active = sort?.column === i ? sort.dir : null;
                return (
                  <th scope="col" key={i} role={role('columnheader')} className={isNumericColumn(columns[i] ?? { type: 'text' }) ? 'zb-num' : undefined}
                    aria-sort={sortable ? (active === 'asc' ? 'ascending' : active === 'desc' ? 'descending' : 'none') : undefined}>
                    {sortable
                      ? (
                        <button type="button" className="zb-dt-sort" onClick={() => setSort(s => nextSort(s, i))}>
                          {h}<span className="zb-dt-sort-icon" aria-hidden="true">{active === 'asc' ? '▲' : active === 'desc' ? '▼' : '↕'}</span>
                        </button>
                      )
                      : h}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody role={role('rowgroup')}>
            {order.map(r => (
              <tr key={r} role={role('row')}>
                {(block.rows[r] ?? []).map((raw, c) => {
                  const col = columns[c] ?? { type: 'text' };
                  return (
                    <td key={c} role={role('cell')} className={isNumericColumn(col) ? 'zb-num' : undefined} data-label={cards ? block.headers[c] : undefined}>
                      <CellView col={col} raw={raw} renderInline={renderInline} locale={locale} />
                    </td>
                  );
                })}
              </tr>
            ))}
            {order.length === 0 && (
              <tr role={role('row')}><td className="zb-dt-empty" role={role('cell')} colSpan={block.headers.length}>{text.empty}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </BlockFrame>
  );
}

export default DataTable;