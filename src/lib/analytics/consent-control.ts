/**
 * Copy and rendering for the `/privacy` analytics consent control, shared by the page and its tests so
 * the text a visitor sees for each consent state is checked without parsing the page source.
 */

import { consentControlView, type ConsentState } from './consent';

export type ConsentControlLang = 'vi' | 'en';

export interface ConsentControlCopy {
  granted: string;
  optedOut: string;
  dnt: string;
  /** Shown for `storage_blocked`, which covers storage the browser refuses and storage that is full. */
  storageOff: string;
  noScript: string;
  optOut: string;
  optIn: string;
  saved: string;
  /** Appended when a toggle click could not be saved. */
  notSaved: string;
}

export const CONSENT_CONTROL_COPY: Record<ConsentControlLang, ConsentControlCopy> = {
  vi: {
    granted: 'Đang bật thống kê sử dụng trên trình duyệt này.',
    optedOut: 'Bạn đã tắt thống kê sử dụng trên trình duyệt này.',
    dnt: 'Trình duyệt của bạn đang bật Do Not Track hoặc Global Privacy Control, nên thống kê luôn tắt.',
    storageOff: 'Trình duyệt này không lưu được lựa chọn cho zuey.me (bộ nhớ cục bộ bị chặn hoặc đã đầy), nên thống kê sử dụng luôn tắt. Muốn bật lại, hãy cho phép lưu dữ liệu trang web cho zuey.me hoặc xoá bớt dữ liệu đã lưu.',
    noScript: 'Cần bật JavaScript để thay đổi lựa chọn này.',
    optOut: 'Tắt thống kê',
    optIn: 'Bật lại thống kê',
    saved: 'Đã lưu lựa chọn.',
    notSaved: 'Trình duyệt này không lưu được lựa chọn.',
  },
  en: {
    granted: 'Usage analytics is on in this browser.',
    optedOut: 'You turned usage analytics off in this browser.',
    dnt: 'Your browser sends Do Not Track or Global Privacy Control, so analytics is always off.',
    storageOff: 'This browser cannot save choices for zuey.me (local storage is blocked or full), so usage analytics stays off. To turn it back on, allow site data for zuey.me or clear some stored data.',
    noScript: 'JavaScript is needed to change this choice.',
    optOut: 'Turn analytics off',
    optIn: 'Turn analytics back on',
    saved: 'Choice saved.',
    notSaved: 'This browser could not save the choice.',
  },
};

export function isConsentControlLang(value: string | undefined): value is ConsentControlLang {
  return value === 'vi' || value === 'en';
}

/** Status text and toggle label for a consent state; `toggle` is null when no button is shown. */
export function renderConsentControl(
  state: ConsentState,
  copy: ConsentControlCopy,
  note?: 'saved' | 'notSaved',
): { status: string; toggle: string | null } {
  const view = consentControlView(state);
  const text = copy[view.status];
  return {
    status: note ? `${text} ${copy[note]}` : text,
    toggle: view.toggle ? copy[view.toggle] : null,
  };
}
