import type { Locale } from '../../lib/i18n/locales';

/**
 * How the server had to recover a stored draft to show it (the `recovery` field of an admin draft
 * read). Studio always saves the whole document, so saving over a recovered draft makes the loss permanent.
 */
export interface DraftRecovery {
  droppedBlocks: number;
  degradedEmbeds: number;
  unreadable: boolean;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);

/** Reads `recovery` from an admin draft view; null when absent or when nothing was recovered. */
export function parseDraftRecovery(v: unknown): DraftRecovery | null {
  if (typeof v !== 'object' || v === null) return null;
  const r: DraftRecovery = {
    droppedBlocks: 'dropped_blocks' in v ? count(v.dropped_blocks) : 0,
    degradedEmbeds: 'degraded_embeds' in v ? count(v.degraded_embeds) : 0,
    unreadable: 'unreadable' in v && v.unreadable === true,
  };
  return r.unreadable || r.droppedBlocks > 0 || r.degradedEmbeds > 0 ? r : null;
}

/** Saving would overwrite a draft the editor could not show as stored. */
export function needsOverwriteConfirm(r: DraftRecovery | null): boolean {
  return r !== null && (r.unreadable || r.droppedBlocks > 0 || r.degradedEmbeds > 0);
}

function lossDetails(r: DraftRecovery): string {
  const parts: string[] = [];
  if (r.droppedBlocks > 0) parts.push(`${r.droppedBlocks} block không hợp lệ đã bị bỏ qua`);
  if (r.degradedEmbeds > 0) parts.push(`${r.degradedEmbeds} khối nhúng chỉ còn hiển thị dạng liên kết`);
  return parts.join(', ');
}

/** Banner shown while a recovered draft is open. */
export function recoveryWarning(r: DraftRecovery, locale: Locale): string {
  if (r.unreadable) {
    return `Bản nháp ${locale} đã lưu không đọc được nên trình soạn đang trống. `
      + 'Lưu lúc này sẽ thay toàn bộ bản nháp cũ bằng nội dung đang soạn.';
  }
  return `Bản nháp ${locale} đã lưu không còn hợp lệ hoàn toàn: ${lossDetails(r)}. `
    + 'Lưu lúc này sẽ ghi bản đã khôi phục đè lên, phần bị bỏ qua mất vĩnh viễn.';
}

/** Question of the confirmation asked before the first save over a recovered draft. */
export function overwriteConfirmMessage(r: DraftRecovery, locale: Locale): string {
  return r.unreadable
    ? `Bản nháp ${locale} đã lưu không đọc được. Lưu sẽ thay toàn bộ bản nháp cũ bằng nội dung đang soạn. Vẫn lưu?`
    : `Bản nháp ${locale} đã lưu có lỗi (${lossDetails(r)}). Lưu sẽ xoá vĩnh viễn phần bị bỏ qua. Vẫn lưu?`;
}
