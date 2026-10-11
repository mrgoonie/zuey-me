import { describe, it, expect } from 'bun:test';
import {
  needsOverwriteConfirm, parseDraftRecovery, recoveryWarning, restoredRevisionWarning, saveConfirmMessage,
} from '../src/components/studio/recovered-draft';

// Studio warns about a recovered draft and asks before a save writes the recovered document back.

describe('parseDraftRecovery', () => {
  it('reads the admin draft view field', () => {
    expect(parseDraftRecovery({ dropped_blocks: 2, degraded_embeds: 1, unreadable: false })).toEqual({ droppedBlocks: 2, degradedEmbeds: 1, unreadable: false });
    expect(parseDraftRecovery({ dropped_blocks: 0, degraded_embeds: 0, unreadable: true })).toEqual({ droppedBlocks: 0, degradedEmbeds: 0, unreadable: true });
  });

  it('is null when nothing was recovered or the field is missing/garbled', () => {
    expect(parseDraftRecovery(null)).toBeNull();
    expect(parseDraftRecovery(undefined)).toBeNull();
    expect(parseDraftRecovery('yes')).toBeNull();
    expect(parseDraftRecovery({ dropped_blocks: 0, degraded_embeds: 0, unreadable: false })).toBeNull();
    expect(parseDraftRecovery({ dropped_blocks: -3, degraded_embeds: 1.5, unreadable: 'true' })).toBeNull();
  });
});

describe('save confirmation', () => {
  it('is required for any recovered draft and not for a clean one', () => {
    expect(needsOverwriteConfirm(null)).toBe(false);
    expect(needsOverwriteConfirm({ droppedBlocks: 1, degradedEmbeds: 0, unreadable: false })).toBe(true);
    expect(needsOverwriteConfirm({ droppedBlocks: 0, degradedEmbeds: 1, unreadable: false })).toBe(true);
    expect(needsOverwriteConfirm({ droppedBlocks: 0, degradedEmbeds: 0, unreadable: true })).toBe(true);
  });

  it('names what would be lost', () => {
    const lossy = { droppedBlocks: 2, degradedEmbeds: 1, unreadable: false };
    expect(recoveryWarning(lossy, 'vi')).toContain('2 block không hợp lệ');
    expect(recoveryWarning(lossy, 'vi')).toContain('1 khối nhúng');
    expect(saveConfirmMessage(lossy, null, 'en')).toContain('Bản nháp en');
    expect(saveConfirmMessage(lossy, null, 'vi')).toContain('xoá vĩnh viễn');
    const embedsOnly = recoveryWarning({ droppedBlocks: 0, degradedEmbeds: 3, unreadable: false }, 'vi');
    expect(embedsOnly).toContain('3 khối nhúng');
    expect(embedsOnly).not.toContain('block không hợp lệ');
  });

  it('explains that an unreadable draft would be replaced entirely', () => {
    const unreadable = { droppedBlocks: 0, degradedEmbeds: 0, unreadable: true };
    expect(recoveryWarning(unreadable, 'vi')).toContain('không đọc được');
    expect(saveConfirmMessage(unreadable, null, 'vi')).toContain('thay toàn bộ');
  });
});

describe('restoring a recovered History revision', () => {
  const lossy = { droppedBlocks: 1, degradedEmbeds: 0, unreadable: false };
  const clean = null;

  it('asks before saving a restored revision even when the stored draft is clean', () => {
    expect(saveConfirmMessage(clean, null, 'vi')).toBeNull();
    const q = saveConfirmMessage(clean, { revision: 4, recovery: lossy }, 'vi');
    expect(q).toContain('Revision r4');
    expect(q).toContain('1 block không hợp lệ');
    expect(q?.endsWith('Vẫn lưu?')).toBe(true);
    expect(q).not.toContain('Bản nháp vi');
  });

  it('names both losses when the stored draft and the restored revision were recovered', () => {
    const q = saveConfirmMessage({ droppedBlocks: 0, degradedEmbeds: 0, unreadable: true }, { revision: 2, recovery: { droppedBlocks: 0, degradedEmbeds: 2, unreadable: false } }, 'en');
    expect(q).toContain('Bản nháp en đã lưu không đọc được');
    expect(q).toContain('Revision r2 có lỗi (2 khối nhúng');
  });

  it('warns while the restored revision is in the editor', () => {
    expect(restoredRevisionWarning({ revision: 3, recovery: lossy }, 'vi')).toContain('Revision r3 (bản vi) không còn hợp lệ hoàn toàn');
    expect(restoredRevisionWarning({ revision: 5, recovery: { droppedBlocks: 0, degradedEmbeds: 0, unreadable: true } }, 'ja')).toContain('không đọc được nên được nạp dạng trống');
  });
});