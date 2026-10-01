import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';

interface Props {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Prevent Esc/backdrop dismissal while a request is in flight. */
  busy?: boolean;
}

/** Native modal <dialog>: focus is trapped and restored by the browser; Esc closes unless busy. */
export function MemberDialog({ open, title, onClose, children, busy = false }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}
      onClose={() => { if (open) onClose(); }}
      className="w-[calc(100%-1.5rem)] max-w-[520px] rounded-[24px] border border-stone-200 bg-[#F5EFEB] p-0 text-stone-900 shadow-floating-card backdrop:bg-black/60"
    >
      {open && (
        <div className="px-4 py-5 sm:p-6 grid gap-4 min-w-0">
          <h2 id={titleId} className="text-xl font-bold font-serif pr-8">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
