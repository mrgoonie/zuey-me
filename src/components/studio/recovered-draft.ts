import type { Locale } from '../../lib/i18n/locales';

/**
 * How the server had to recover a stored document to show it (the `recovery` field of an admin draft
 * or revision read). Studio always saves the whole document, so saving a recovered document makes the loss permanent.
 */
export interface DraftRecovery {
  droppedBlocks: number;
  degradedEmbeds: number;
  unreadable: boolean;
}

/** A History revision loaded into the editor that itself needed recovery. */
export interface RestoredRevision {
  revision: number;
  recovery: DraftRecovery;
}

const count = (v: unknown): number => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0);

/** Reads `recovery` from an admin draft or revision read; null when absent or when nothing was recovered. */
export function parseDraftRecovery(v: unknown): DraftRecovery | null {
  if (typeof v !== 'object' || v === null) return null;
  const r: DraftRecovery = {
    droppedBlocks: 'dropped_blocks' in v ? count(v.dropped_blocks) : 0,
    degradedEmbeds: 'degraded_embeds' in v ? count(v.degraded_embeds) : 0,
    unreadable: 'unreadable' in v && v.unreadable === true,
  };
  return r.unreadable || r.droppedBlocks > 0 || r.degradedEmbeds > 0 ? r : null;
}

/** Saving would write a document the editor could not show as stored. */
export function needsOverwriteConfirm(r: DraftRecovery | null): boolean {
  return r !== null && (r.unreadable || r.droppedBlocks > 0 || r.degradedEmbeds > 0);
}

function lossDetails(r: DraftRecovery): string {
  const parts: string[] = [];
  if (r.droppedBlocks > 0) parts.push(`${r.droppedBlocks} block không hợp lệ đã bị bỏ qua`);
  if (r.degradedEmbeds > 0) parts.push(`${r.degradedEmbeds} khối nhúng chỉ còn hiển thị dạng liên kết`);
  return parts.join(', ');
}

/** Banner shown while a recovered stored draft is open. */
export function recoveryWarning(r: DraftRecovery, locale: Locale): string {
  if (r.unreadable) {
    return `Bản nháp ${locale} đã lưu không đọc được nên trình soạn đang trống. `
      + 'Lưu lúc này sẽ thay toàn bộ bản nháp cũ bằng nội dung đang soạn.';
  }
  return `Bản nháp ${locale} đã lưu không còn hợp lệ hoàn toàn: ${lossDetails(r)}. `
    + 'Lưu lúc này sẽ ghi bản đã khôi phục đè lên, phần bị bỏ qua mất vĩnh viễn.';
}

/** Banner shown after History loaded a revision that needed recovery. */
export function restoredRevisionWarning(restored: RestoredRevision, locale: Locale): string {
  const { revision, recovery: r } = restored;
  if (r.unreadable) {
    return `Revision r${revision} (bản ${locale}) không đọc được nên được nạp dạng trống. `
      + 'Lưu lúc này sẽ ghi nội dung đang soạn, không phải nội dung gốc của revision.';
  }
  return `Revision r${revision} (bản ${locale}) không còn hợp lệ hoàn toàn: ${lossDetails(r)}. `
    + 'Lưu lúc này chỉ giữ phần đã khôi phục, phần bị bỏ qua không được khôi phục.';
}

/**
 * Question asked before a save that would write a recovered document, or null when saving loses
 * nothing. Covers both the stored draft being overwritten and a recovered History revision being restored.
 */
export function saveConfirmMessage(draft: DraftRecovery | null, restored: RestoredRevision | null, locale: Locale): string | null {
  const parts: string[] = [];
  if (draft && needsOverwriteConfirm(draft)) {
    parts.push(draft.unreadable
      ? `Bản nháp ${locale} đã lưu không đọc được; lưu sẽ thay toàn bộ bản nháp cũ bằng nội dung đang soạn.`
      : `Bản nháp ${locale} đã lưu có lỗi (${lossDetails(draft)}); lưu sẽ xoá vĩnh viễn phần bị bỏ qua.`);
  }
  if (restored && needsOverwriteConfirm(restored.recovery)) {
    parts.push(restored.recovery.unreadable
      ? `Revision r${restored.revision} không đọc được; lưu sẽ ghi nội dung đang soạn thay cho nó.`
      : `Revision r${restored.revision} có lỗi (${lossDetails(restored.recovery)}); phần bị bỏ qua không được khôi phục.`);
  }
  return parts.length ? `${parts.join(' ')} Vẫn lưu?` : null;
}
