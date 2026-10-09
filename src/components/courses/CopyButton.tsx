import { useState } from 'react';

/** Small "Chép" button that copies a value (bank account, amount, transfer content) to the clipboard. */
export function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ml-2 inline-flex min-h-[32px] items-center text-xs font-semibold underline focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 rounded"
      onClick={() => { navigator.clipboard.writeText(value).then(() => setCopied(true), () => setCopied(false)); }}
      aria-label={`Sao chép ${label}`}
    >
      {copied ? 'Đã chép' : 'Chép'}
    </button>
  );
}
