/** Epoch (or earlier) means the owner has never saved a setting, so there is no change time to show. */
export function changedLabel(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ` · changed ${ts}`;
  if (d.getTime() <= 0) return '';
  return ` · changed ${d.toLocaleString('vi-VN', { timeZone: 'Asia/Saigon' })}`;
}
