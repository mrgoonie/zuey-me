import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';
import type { HomeStrings } from './home-i18n';
import { animateDialogIn } from './motion';

interface McpDialogProps {
  open: boolean;
  onClose: () => void;
  strings: HomeStrings['mcp'];
}

type ClientTab = 'claudeCode' | 'claudeApp' | 'chatgpt' | 'cursor' | 'apiKey';
const TABS: ClientTab[] = ['claudeCode', 'claudeApp', 'chatgpt', 'cursor', 'apiKey'];
const KEY_PLACEHOLDER = '<YOUR_ZUEY_API_KEY>';

function tabLabel(tab: ClientTab, s: HomeStrings['mcp']): string {
  switch (tab) {
    case 'claudeCode': return 'Claude Code';
    case 'claudeApp': return 'Claude';
    case 'chatgpt': return 'ChatGPT';
    case 'cursor': return 'Cursor';
    case 'apiKey': return s.apiKey;
  }
}

/** Connection snippets. Only placeholders are ever shown: real keys are created under /account#keys. */
function snippetsFor(tab: ClientTab, origin: string, s: HomeStrings['mcp']): { note: string; code: string }[] {
  const oauth = `${origin}/mcp`;
  const keyed = `${origin}/api/mcp`;
  switch (tab) {
    case 'claudeCode':
      return [{ note: `${s.claudeCode} · ${s.oauth}`, code: `claude mcp add --transport http zuey ${oauth}` }];
    case 'claudeApp':
      return [{ note: s.claudeApp, code: oauth }];
    case 'chatgpt':
      return [{ note: s.chatgpt, code: oauth }];
    case 'cursor':
      return [{ note: s.cursor, code: JSON.stringify({ mcpServers: { zuey: { url: oauth } } }, null, 2) }];
    case 'apiKey':
      return [
        { note: `${s.claudeCode} · ${s.apiKey}`, code: `claude mcp add --transport http zuey ${keyed} --header "Authorization: Bearer ${KEY_PLACEHOLDER}"` },
        { note: s.keyHeader, code: JSON.stringify({ mcpServers: { zuey: { url: keyed, headers: { Authorization: `Bearer ${KEY_PLACEHOLDER}` } } } }, null, 2) },
      ];
  }
}

/** Clipboard API copy; on failure the snippet text is selected so the visitor can copy it manually. */
async function copyText(text: string, source: HTMLElement | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the manual-selection fallback.
  }
  if (source) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(source);
    selection?.removeAllRanges();
    selection?.addRange(range);
  }
  return false;
}

/** MCP setup dialog for Claude, ChatGPT and Cursor (OAuth /mcp or API-key /api/mcp). */
export const McpDialog: React.FC<McpDialogProps> = ({ open, onClose, strings }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [tab, setTab] = useState<ClientTab>('claudeCode');
  const [origin, setOrigin] = useState('https://zuey.me');
  const [copied, setCopied] = useState<{ index: number; ok: boolean } | null>(null);
  const titleId = useId();
  const panelId = useId();

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      dialog.showModal();
      void animateDialogIn(dialog);
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const onClosed = () => {
      setCopied(null);
      onClose();
      const target = returnFocusRef.current;
      if (target && target.isConnected) target.focus();
    };
    dialog.addEventListener('close', onClosed);
    return () => dialog.removeEventListener('close', onClosed);
  }, [onClose]);

  const onTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.indexOf(tab);
    let next = index;
    if (e.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = TABS.length - 1;
    else return;
    e.preventDefault();
    setTab(TABS[next]);
    setCopied(null);
    ref.current?.querySelector<HTMLButtonElement>(`[data-mcp-tab="${TABS[next]}"]`)?.focus();
  };

  const snippets = snippetsFor(tab, origin, strings);

  return (
    <dialog ref={ref} className="home-dialog" aria-labelledby={titleId} onClick={e => { if (e.target === ref.current) ref.current?.close(); }}>
      <div className="home-dialog-head">
        <h2 id={titleId}>{strings.title}</h2>
        <button type="button" className="home-icon-btn" aria-label={strings.close} onClick={() => ref.current?.close()}>
          <X aria-hidden="true" className="w-5 h-5" />
        </button>
      </div>
      <div className="home-dialog-body">
        <p className="text-stone-700">{strings.intro}</p>
        <div className="home-segmented" role="tablist" aria-label={strings.title} onKeyDown={onTabKey}>
          {TABS.map(t => (
            <button
              key={t}
              type="button"
              role="tab"
              data-mcp-tab={t}
              aria-selected={tab === t}
              aria-controls={panelId}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => { setTab(t); setCopied(null); }}
            >
              {tabLabel(t, strings)}
            </button>
          ))}
        </div>
        <div id={panelId} role="tabpanel" aria-label={tabLabel(tab, strings)} className="grid gap-3">
          {snippets.map((s, i) => (
            <div key={`${tab}-${i}`} className="grid gap-1.5">
              <p className="text-[13px] font-semibold text-stone-700">{s.note}</p>
              <div className="home-snippet">
                <code>{s.code}</code>
                <button
                  type="button"
                  aria-label={`${strings.copy}: ${s.note}`}
                  onClick={async e => {
                    const code = e.currentTarget.parentElement?.querySelector('code') ?? null;
                    setCopied({ index: i, ok: await copyText(s.code, code) });
                  }}
                  data-press
                >
                  {copied?.index === i && copied.ok ? <Check aria-hidden="true" className="w-4 h-4" /> : <Copy aria-hidden="true" className="w-4 h-4" />}
                </button>
              </div>
            </div>
          ))}
          <p className="min-h-[20px] text-[13px] font-semibold" role="status" aria-live="polite">
            {copied ? (copied.ok ? strings.copied : strings.copyFailed) : ''}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <a href="/account#keys" className="home-cta" data-press>{strings.keys}</a>
          <a href="/docs" className="home-cta home-cta--ghost" data-press>{strings.docs}</a>
        </div>
      </div>
    </dialog>
  );
};
