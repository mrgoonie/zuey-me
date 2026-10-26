import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Block, TabsBlock as TabsBlockData } from '../../lib/blocks/schema';
import { DEFAULT_CARD_LEVEL } from '../../lib/blocks/schema';
import { tabPanelId } from './CompositionBlocks';

export interface TabsProps {
  block: TabsBlockData;
  renderBlocks: (blocks: Block[]) => ReactNode;
}

/** Index of the tab whose anchor is the URL fragment, or -1. */
function tabFromHash(block: TabsBlockData, hash: string): number {
  let id = hash.replace(/^#/, '');
  try { id = decodeURIComponent(id); } catch { /* keep the raw fragment */ }
  return id ? block.tabs.findIndex(t => t.anchor === id) : -1;
}

/**
 * WAI-ARIA tabs (automatic activation): Left/Right move between tabs and wrap, Home/End jump to the ends, and the
 * selected tab is the only one in the tab order. The first render, on the server and during hydration, is the
 * no-JavaScript form (every panel under its label, the same markup as TabsStatic); the tab list replaces the
 * headings once the component is mounted.
 * A tab with an anchor is selected by #anchor on load and on hashchange, and selecting it updates the fragment.
 */
export function Tabs({ block, renderBlocks }: TabsProps) {
  const [mounted, setMounted] = useState(false);
  const [selected, setSelected] = useState(Math.min(block.defaultTab ?? 0, block.tabs.length - 1));
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    setMounted(true);
    // The browser scrolled to the anchor in the all-panels server markup (or while the panel was hidden), so the
    // position is stale once only one panel shows: scroll again after React commits the selection.
    const open = (i: number) => {
      setSelected(i);
      setTimeout(() => document.getElementById(tabPanelId(block, i))?.scrollIntoView({ block: 'start' }), 0);
    };
    const fromHash = tabFromHash(block, window.location.hash);
    if (fromHash >= 0) open(fromHash);
    const onHash = () => {
      const i = tabFromHash(block, window.location.hash);
      if (i >= 0) open(i);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [block]);

  const select = (i: number, focus: boolean) => {
    setSelected(i);
    if (focus) tabRefs.current[i]?.focus();
    const anchor = block.tabs[i].anchor;
    if (anchor && window.location.hash !== `#${anchor}`) {
      try { window.history.replaceState(window.history.state, '', `#${anchor}`); } catch { /* sandboxed or file URLs */ }
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = block.tabs.length - 1;
    const next = e.key === 'ArrowRight' ? (selected === last ? 0 : selected + 1)
      : e.key === 'ArrowLeft' ? (selected === 0 ? last : selected - 1)
        : e.key === 'Home' ? 0
          : e.key === 'End' ? last : -1;
    if (next < 0) return;
    e.preventDefault();
    select(next, true);
  };
  const tabId = (i: number) => `${block.id}-tab-${i}`;
  const Heading = `h${block.level ?? DEFAULT_CARD_LEVEL}` as const;

  // Same element tree in both states (the tab list and headings are slots), so nested blocks never remount.
  return (
    <div className={mounted ? 'zb-tabs zb-tabs-live' : 'zb-tabs zb-tabs-static'}>
      {mounted ? (
        <div className="zb-tablist" role="tablist" onKeyDown={onKeyDown}>
          {block.tabs.map((tab, i) => (
            <button
              type="button" role="tab" className="zb-tab" id={tabId(i)} key={i}
              ref={el => { tabRefs.current[i] = el; }}
              aria-selected={i === selected} aria-controls={tabPanelId(block, i)} tabIndex={i === selected ? 0 : -1}
              onClick={() => select(i, false)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      ) : null}
      {block.tabs.map((tab, i) => (
        // Inactive panels stay mounted (hidden), so media and widgets inside keep their state.
        <section
          className="zb-tab-panel" id={tabPanelId(block, i)} key={i}
          {...(mounted ? { role: 'tabpanel', 'aria-labelledby': tabId(i), tabIndex: 0, hidden: i !== selected } : {})}
        >
          {mounted ? null : <Heading className="zb-tab-heading">{tab.label}</Heading>}
          {renderBlocks(tab.blocks)}
        </section>
      ))}
    </div>
  );
}
export default Tabs;
