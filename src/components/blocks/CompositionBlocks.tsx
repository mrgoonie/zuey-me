import type { CSSProperties, ReactNode } from 'react';
import type { Block, ComparisonBlock, ProgressBlock, StatBlock, StatItem, StepsBlock, TabsBlock } from '../../lib/blocks/schema';
import { DEFAULT_CARD_LEVEL } from '../../lib/blocks/schema';
import type { IconName } from '../../lib/blocks/icons';
import {
  localeNumber, progressRatio, progressScale, progressSegments, progressState, progressText, statDelta, statState, statTrend, statValue,
} from '../../lib/blocks/widget-format';
import { widgetLabels } from '../../lib/blocks/widget-labels';

/**
 * Server-rendered composition widgets. Everything here is plain markup (no effects, no browser APIs), so it
 * renders identically on the server and the client and costs nothing until a page uses it. Only tabs gain
 * behaviour, from the lazy ./TabsBlock chunk; `TabsStatic` is what they show without it.
 */
type CssVars = CSSProperties & { [key: `--${string}`]: string | number };

function cssVars(vars: { [key: `--${string}`]: string | number }): CssVars {
  return vars;
}

interface WidgetProps<B> {
  block: B;
  locale?: string;
  renderInline: (text: string) => ReactNode;
}
interface NestedWidgetProps<B> extends WidgetProps<B> {
  renderBlocks: (blocks: Block[]) => ReactNode;
}

/** Element id of a tab panel: its anchor (a #link target), or one derived from the block id. */
export function tabPanelId(block: TabsBlock, index: number): string {
  return block.tabs[index].anchor ?? `${block.id}-panel-${index}`;
}

/** Every panel in order under its label: the page without JavaScript, and the client before the tabs chunk loads. */
export function TabsStatic({ block, renderBlocks }: { block: TabsBlock; renderBlocks: (blocks: Block[]) => ReactNode }) {
  const Heading = `h${block.level ?? DEFAULT_CARD_LEVEL}` as const;
  return (
    <div className="zb-tabs zb-tabs-static">
      {block.tabs.map((tab, i) => (
        <section className="zb-tab-panel" id={tabPanelId(block, i)} key={i}>
          <Heading className="zb-tab-heading">{tab.label}</Heading>
          {renderBlocks(tab.blocks)}
        </section>
      ))}
    </div>
  );
}

const ARROWS = { up: '▲', down: '▼', flat: '▬' } as const;

/** Decorative trend line; its meaning is repeated as screen-reader text by the caller. */
function Sparkline({ values }: { values: number[] }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values.map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(2)},${(28 - ((v - min) / span) * 26).toFixed(2)}`).join(' ');
  return (
    <svg className="zb-sparkline" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true" focusable="false">
      <polyline points={points} fill="none" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function StatFigure({ item, locale, renderInline }: { item: StatItem; locale?: string; renderInline: (text: string) => ReactNode }) {
  const words = widgetLabels(locale);
  const fmt = (n: number, d?: number) => localeNumber(n, d, locale);
  const delta = statDelta(item, fmt);
  const trend = statTrend(item);
  const spark = item.sparkline;
  return (
    <div className={`zb-stat-item zb-state-${statState(item)}`}>
      <dt className="zb-stat-label">{item.label}</dt>
      <dd className="zb-stat-value">{statValue(item, fmt)}</dd>
      {(delta || trend) && (
        <dd className="zb-stat-delta">
          {trend && <span aria-hidden="true">{`${ARROWS[trend]} `}</span>}
          {trend && <span className="zb-sr-only">{`${words.trend[trend]}: `}</span>}
          {delta}{item.delta?.label && <span className="zb-stat-basis">{` ${item.delta.label}`}</span>}
        </dd>
      )}
      {spark && (
        <dd className="zb-stat-spark">
          <Sparkline values={spark} />
          <span className="zb-sr-only">
            {words.sparkline(spark.length, fmt(Math.min(...spark), item.decimals), fmt(Math.max(...spark), item.decimals), fmt(spark[spark.length - 1], item.decimals))}
          </span>
        </dd>
      )}
      {item.note && <dd className="zb-stat-note">{renderInline(item.note)}</dd>}
    </div>
  );
}

export function StatView({ block, locale, renderInline }: WidgetProps<StatBlock>) {
  return (
    <div className="zb-widget zb-stat">
      {block.title && <p className="zb-widget-title">{block.title}</p>}
      <dl className="zb-stat-grid" style={cssVars({ '--zs-count': block.items.length })}>
        {block.items.map((item, i) => <StatFigure item={item} locale={locale} renderInline={renderInline} key={i} />)}
      </dl>
    </div>
  );
}

export function StepsView({ block, locale, renderInline, renderBlocks, renderIcon }: NestedWidgetProps<StepsBlock> & { renderIcon: (name: IconName) => ReactNode }) {
  const words = widgetLabels(locale);
  const className = [
    'zb-steps', `zb-steps-${block.variant}`, `zb-steps-${block.orientation ?? 'vertical'}`, block.connector === 'none' ? 'zb-steps-noline' : '',
  ].filter(Boolean).join(' ');
  return (
    <ol className={className}>
      {block.items.map((item, i) => (
        <li className={`zb-step zb-step-${item.status ?? 'none'}`} aria-current={item.status === 'current' ? 'step' : undefined} key={i}>
          <span className="zb-step-marker" aria-hidden="true">
            {item.icon ? renderIcon(item.icon) : item.status === 'done' ? '✓' : block.variant === 'timeline' ? '' : i + 1}
          </span>
          <div className="zb-step-body">
            <p className="zb-step-title">
              {block.variant === 'steps' && <span className="zb-sr-only">{`${words.step(i + 1)}: `}</span>}
              {renderInline(item.title)}
            </p>
            {(item.date || item.status) && (
              <p className="zb-step-meta">
                {item.date && <span className="zb-step-date">{item.date}</span>}
                {item.status && <span className={`zb-step-status zb-step-status-${item.status}`}>{words.status[item.status]}</span>}
              </p>
            )}
            {item.blocks.length > 0 && <div className="zb-step-content">{renderBlocks(item.blocks)}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Mark({ value, words }: { value: string | boolean; words: ReturnType<typeof widgetLabels> }) {
  if (typeof value === 'string') return <>{value}</>;
  return (
    <>
      <span className={value ? 'zb-mark-yes' : 'zb-mark-no'} aria-hidden="true">{value ? '✓' : '✗'}</span>
      <span className="zb-sr-only">{value ? words.yes : words.no}</span>
    </>
  );
}

export function ComparisonView({ block, locale, renderInline, renderBlocks }: NestedWidgetProps<ComparisonBlock>) {
  const words = widgetLabels(locale);
  return (
    <div className="zb-widget zb-comparison">
      {block.title && <p className="zb-widget-title">{block.title}</p>}
      <div className="zb-compare-options" style={cssVars({ '--zc-count': block.options.length })}>
        {block.options.map((o, i) => (
          <div className={o.highlight ? 'zb-compare-option zb-compare-highlight' : 'zb-compare-option'} key={i}>
            <div className="zb-compare-head">
              <p className="zb-compare-name">{o.name}</p>
              {(o.badge || o.highlight) && <span className="zb-badge">{o.badge ?? words.recommended}</span>}
              {o.highlight && o.badge && <span className="zb-sr-only">{` (${words.recommended})`}</span>}
            </div>
            {o.description && <p className="zb-compare-desc">{renderInline(o.description)}</p>}
            {(o.pros || o.cons) && (
              <ul className="zb-compare-points">
                {(o.pros ?? []).map((s, j) => (
                  <li className="zb-compare-pro" key={`p${j}`}><span aria-hidden="true">✓</span><span className="zb-sr-only">{`${words.pros}: `}</span>{renderInline(s)}</li>
                ))}
                {(o.cons ?? []).map((s, j) => (
                  <li className="zb-compare-con" key={`c${j}`}><span aria-hidden="true">✗</span><span className="zb-sr-only">{`${words.cons}: `}</span>{renderInline(s)}</li>
                ))}
              </ul>
            )}
            {o.blocks.length > 0 && <div className="zb-compare-content">{renderBlocks(o.blocks)}</div>}
          </div>
        ))}
      </div>
      {block.features && block.features.length > 0 && (
        <div className="zb-scroll">
          <table className="zb-table zb-compare-matrix">
            <thead>
              <tr>
                <th scope="col">{words.feature}</th>
                {block.options.map((o, i) => <th scope="col" className={o.highlight ? 'zb-compare-col-highlight' : undefined} key={i}>{o.name}</th>)}
              </tr>
            </thead>
            <tbody>
              {block.features.map((f, r) => (
                <tr key={r}>
                  <th scope="row">{f.label}</th>
                  {f.values.map((x, i) => (
                    <td className={block.options[i]?.highlight ? 'zb-compare-col-highlight' : undefined} key={i}><Mark value={x} words={words} /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Semicircle gauge; the arc length is the filled share (pathLength 100). */
function Gauge({ ratio }: { ratio: number }) {
  const arc = 'M 6 46 A 40 40 0 0 1 86 46';
  return (
    <svg className="zb-gauge" viewBox="0 0 92 50" aria-hidden="true" focusable="false">
      <path className="zb-gauge-track" d={arc} pathLength={100} />
      <path className="zb-gauge-fill" d={arc} pathLength={100} strokeDasharray={`${(ratio * 100).toFixed(2)} 100`} />
    </svg>
  );
}

export function ProgressView({ block, locale, renderInline }: WidgetProps<ProgressBlock>) {
  const words = widgetLabels(locale);
  const fmt = (n: number, d?: number) => localeNumber(n, d, locale);
  const { min, max } = progressScale(block);
  return (
    <div className={`zb-widget zb-progress zb-progress-${block.variant}`}>
      {block.title && <p className="zb-widget-title">{block.title}</p>}
      <ul className="zb-progress-list">
        {block.items.map((item, i) => {
          const ratio = progressRatio(block, item);
          const state = progressState(block, item);
          const shown = progressText(block, item, fmt);
          const stateText = words.progressState[state];
          const labelId = `${block.id}-meter-${i}`;
          const valueText = [block.variant === 'rating' ? words.rating(fmt(item.value, block.decimals), fmt(max)) : shown, stateText].filter(Boolean).join(', ');
          let meter: ReactNode;
          if (block.variant === 'gauge') meter = <Gauge ratio={ratio} />;
          else if (block.variant === 'rating') {
            meter = Array.from({ length: max }, (_, s) => (
              <span className="zb-star" style={cssVars({ '--zp-fill': `${(Math.min(1, Math.max(0, item.value - s)) * 100).toFixed(0)}%` })} key={s}>★</span>
            ));
          } else if (block.variant === 'segments') {
            const n = progressSegments(block);
            const filled = Math.round(ratio * n);
            meter = Array.from({ length: n }, (_, s) => <span className={s < filled ? 'zb-seg zb-seg-on' : 'zb-seg'} key={s} />);
          } else {
            meter = <span className="zb-meter-fill" style={{ width: `${(ratio * 100).toFixed(2)}%` }} />;
          }
          return (
            <li className={`zb-progress-item zb-state-${state}`} key={i}>
              <div className="zb-progress-head">
                <span className="zb-progress-label" id={labelId}>{item.label}</span>
                <span className="zb-progress-value">
                  {shown}
                  {stateText && <span className="zb-progress-state">{` · ${stateText}`}</span>}
                </span>
              </div>
              <div
                className="zb-meter" role="meter" aria-labelledby={labelId}
                aria-valuenow={item.value} aria-valuemin={min} aria-valuemax={max} aria-valuetext={valueText}
              >
                {meter}
              </div>
              {item.note && <p className="zb-progress-note">{renderInline(item.note)}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
