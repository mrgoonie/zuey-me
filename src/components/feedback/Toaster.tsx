import React, { useEffect, useRef, useState } from 'react';
import { Check, Info, TriangleAlert } from 'lucide-react';
import { TOAST_EVENT, parseToastDetail, type ToastDetail } from './toast-bus';

/** How long a toast stays up; errors stay longer so they can be read. */
export const TOAST_MS = { success: 2600, info: 2600, error: 4800 } as const;

interface ShownToast extends ToastDetail {
  id: number;
}

/**
 * The one toast surface for the page. The polite live region is always in the DOM (a region
 * added together with its text is often not announced); each toast replaces the previous one.
 * Enter/exit animate only transform and opacity, and stop under reduced motion via CSS.
 */
export const Toaster: React.FC<{ label: string }> = ({ label }) => {
  const [toast, setToast] = useState<ShownToast | null>(null);
  const [on, setOn] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const onToast = (e: Event) => {
      const detail = e instanceof CustomEvent ? parseToastDetail(e.detail) : null;
      if (!detail) return;
      seq.current += 1;
      setToast({ ...detail, id: seq.current });
      setOn(true);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setOn(false), TOAST_MS[toast.tone]);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const Icon = toast?.tone === 'error' ? TriangleAlert : toast?.tone === 'info' ? Info : Check;

  return (
    <div className="zf-toaster" role="status" aria-live="polite" aria-atomic="true" aria-label={label}>
      {toast && (
        <p key={toast.id} className={`zf-toast zf-toast--${toast.tone}${on ? ' is-on' : ''}`} aria-hidden={on ? undefined : true}>
          <Icon aria-hidden className="zf-toast-ic" />
          <span>{toast.message}</span>
        </p>
      )}
    </div>
  );
};
