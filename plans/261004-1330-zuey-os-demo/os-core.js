/* Zuey OS demo core: demo state, helpers, overlays, window manager, mascot and weather effects. */
(() => {
  'use strict';
  const Z = (window.Z = {});
  const D = (Z.D = window.ZDATA);

  /* ---------- storage (every access guarded: private windows and previews may refuse it) ---------- */
  const lsGet = (Z.lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } });
  const lsSet = (Z.lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } });
  Z.lsClear = () => { try { Object.keys(localStorage).filter((k) => /^(zos_|zuey_)/.test(k)).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* ignore */ } };

  /* ---------- demo state, toggled from the reviewer panel ---------- */
  const DEF = { role: 'guest', plan: 'none', aiMode: 'normal', samples: false, lang: 'vi', bg: 'gradient', theme: 'dark', accent: 'ember', wpDim: 30, email: '', orders: [] };
  const S = (Z.S = Object.assign({}, DEF, lsGet('zos_demo_v1', {})));
  const subs = {};
  Z.on = (ev, fn) => (subs[ev] = subs[ev] || []).push(fn);
  Z.emit = (ev, a) => (subs[ev] || []).forEach((f) => { try { f(a); } catch (e) { console.error(e); } });
  Z.set = (patch) => { Object.assign(S, patch); lsSet('zos_demo_v1', S); Z.emit('state', patch); };

  /* plan helpers mirror the live entitlements: read_full for knowledges/combo/community, chat for ai/combo/community */
  Z.plan = (id) => D.plans.plans.find((p) => p.id === (id || S.plan));
  Z.signedIn = () => S.role !== 'guest';
  Z.isAdmin = () => S.role === 'admin';
  Z.canReadFull = () => Z.isAdmin() || (S.role === 'member' && ['knowledges', 'combo', 'community'].includes(S.plan));
  Z.canChat = () => Z.isAdmin() || (S.role === 'member' && ['ai', 'combo', 'community'].includes(S.plan));
  Z.planName = (id) => { const p = Z.plan(id); return p ? p.name : Z.L('Chưa có gói', 'No plan'); };

  /* ---------- text helpers ---------- */
  Z.L = (vi, en) => (S.lang === 'vi' || en == null ? vi : en);
  const esc = (Z.esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]));
  Z.h = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  Z.fmt = (s, o) => s.replace(/\{(\w+)\}/g, (m, k) => (o[k] != null ? o[k] : m));
  Z.vnd = (n) => n.toLocaleString('vi-VN') + ' ₫';
  Z.usd = (c) => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 });
  const TZ = 'Asia/Ho_Chi_Minh';
  Z.TZ = TZ;
  Z.date = (d, o) => new Date(d).toLocaleDateString(S.lang === 'vi' ? 'vi-VN' : 'en-GB', Object.assign({ timeZone: TZ }, o || { day: 'numeric', month: 'numeric', year: 'numeric' }));
  Z.time = (d) => new Date(d).toLocaleTimeString(S.lang === 'vi' ? 'vi-VN' : 'en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  Z.uid = () => Math.random().toString(36).slice(2, 10);
  /* keyboard labels: "Alt W" → ⌥ W on Mac, Alt W elsewhere; "Mod K" → ⌘ K / Ctrl K */
  const isMac = (Z.isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
  Z.keyText = (s) => s.replace(/\bAlt\b/g, isMac ? '⌥' : 'Alt').replace(/\bMod\b/g, isMac ? '⌘' : 'Ctrl').replace(/\bShift\b/g, isMac ? '⇧' : 'Shift');
  Z.kbd = (s) => `<kbd class="kb">${Z.keyText(s).split(' ').map((k) => `<span>${esc(k)}</span>`).join('')}</kbd>`;

  /* ---------- icons (one stroke family) ---------- */
  const P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>', minus: '<path d="M5 12h14"/>', plus: '<path d="M12 5v14M5 12h14"/>',
    back: '<path d="m15 18-6-6 6-6"/>', next: '<path d="m9 18 6-6-6-6"/>', down: '<path d="m6 9 6 6 6-6"/>',
    share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"/>',
    qr: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM21 14v.01M14 21h.01M17 21h4v-4"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    unlock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.9-1"/>',
    more: '<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>',
    send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    edit: '<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>', trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    cloud: '<path d="M17.5 19H8a6 6 0 1 1 5.7-7.9A4.5 4.5 0 1 1 17.5 19z"/>',
    rain: '<path d="M17.5 15H8a5 5 0 1 1 4.8-6.4A4 4 0 1 1 17.5 15z"/><path d="m8 18-1 3M12 18l-1 3M16 18l-1 3"/>',
    snow: '<path d="M17.5 15H8a5 5 0 1 1 4.8-6.4A4 4 0 1 1 17.5 15z"/><path d="M8 19h.01M12 21h.01M16 19h.01"/>',
    bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>', fog: '<path d="M4 8h16M2 12h20M5 16h14M8 20h8"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/>',
    cal: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    gh: '<path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.9a3.4 3.4 0 0 0-.9-2.6c3.1-.4 6.4-1.5 6.4-7a5.4 5.4 0 0 0-1.5-3.8 5 5 0 0 0-.1-3.8s-1.2-.4-3.9 1.5a13.4 13.4 0 0 0-7 0C6.3 1.4 5.1 1.8 5.1 1.8a5 5 0 0 0-.1 3.8A5.4 5.4 0 0 0 3.5 9.4c0 5.4 3.3 6.6 6.4 7a3.4 3.4 0 0 0-.9 2.6V22"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
    plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v4a6 6 0 0 1-12 0V8z"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20"/>',
    pause: '<path d="M8 5v14M16 5v14"/>', play: '<path d="m6 4 14 8-14 8z"/>',
    eyeoff: '<path d="M9.9 4.2A10 10 0 0 1 12 4c7 0 10 8 10 8a17 17 0 0 1-2.2 3.4M6.6 6.6A17 17 0 0 0 2 12s3 8 10 8a9.7 9.7 0 0 0 5.4-1.6M2 2l20 20M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    eye: '<path d="M2 12s3-8 10-8 10 8 10 8-3 8-10 8-10-8-10-8z"/><circle cx="12" cy="12" r="3"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4M21 3v6h-6"/>',
    mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m22 6-10 7L2 6"/>',
    filter: '<path d="M22 3H2l8 9.5V19l4 2v-8.5z"/>',
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    brief: '<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>',
    flow: '<circle cx="6" cy="6" r="3"/><circle cx="18" cy="18" r="3"/><path d="M6 9v3a3 3 0 0 0 3 3h6"/>',
    doc: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h5"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    device: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
    activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>',
    msg: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22z"/>',
    kbd: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>',
    palette: '<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.7-.9 1.4-1.9-.3-1 .4-2.1 1.5-2.1H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10z"/><circle cx="7.5" cy="11" r="1.2"/><circle cx="10.5" cy="7" r="1.2"/><circle cx="15" cy="7.5" r="1.2"/>',
    upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M20 16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3"/>',
    expo: '<rect x="3" y="4" width="8" height="7" rx="1.5"/><rect x="13" y="4" width="8" height="7" rx="1.5"/><rect x="3" y="13" width="8" height="7" rx="1.5"/><rect x="13" y="13" width="8" height="7" rx="1.5"/>',
    compass: '<circle cx="12" cy="12" r="10"/><path d="m16.2 7.8-2.1 6.3-6.3 2.1 2.1-6.3z"/>',
  };
  const ic = (Z.ic = (n, cls) => `<svg class="i ${cls || ''}" viewBox="0 0 24 24" aria-hidden="true">${P[n] || ''}</svg>`);

  /* ---------- motion helpers: every animation is skipped under prefers-reduced-motion ---------- */
  const reduced = (Z.reduced = matchMedia('(prefers-reduced-motion: reduce)').matches);
  const EASE = { out: 'cubic-bezier(.2,.8,.2,1)', spring: 'cubic-bezier(.2,.9,.28,1.12)', in: 'cubic-bezier(.55,0,.75,.2)', genie: 'cubic-bezier(.6,0,.4,1)' };
  Z.EASE = EASE;
  /* animate(el, keyframes, ms, easing) → Promise that resolves when done (or at once when motion is reduced) */
  const animate = (Z.animate = (el, kf, ms, easing) => new Promise((res) => {
    if (reduced || !el || !el.animate) return res();
    const a = el.animate(kf, { duration: ms, easing: easing || EASE.out, fill: 'both' });
    a.onfinish = () => { res(); requestAnimationFrame(() => a.cancel()); };
    a.oncancel = res;
    /* a throttled or hidden tab may never fire finish; the follow-up (hide, remove) must still happen */
    setTimeout(res, ms + 150);
  }));
  /* leave(el, kf, ms): animate out then remove */
  const leave = (Z.leave = (el, kf, ms) => { if (!el || el.leaving) return; el.leaving = true; el.style.pointerEvents = 'none'; animate(el, kf, ms || 160, EASE.in).then(() => el.remove()); });

  /* ---------- toast ---------- */
  Z.toast = (msg, ms) => {
    const host = document.getElementById('toasts');
    const t = Z.h(`<div class="toast">${esc(msg)}</div>`);
    host.append(t);
    animate(t, [{ opacity: 0, transform: 'translateY(12px) scale(.96)' }, { opacity: 1, transform: 'none' }], 260, EASE.spring);
    setTimeout(() => leave(t, [{ opacity: 1 }, { opacity: 0, transform: 'translateY(6px) scale(.98)' }], 180), ms || 2600);
  };

  /* ---------- clipboard: write inside the click handler, fall back to a selectable dialog ---------- */
  Z.copy = (text, done) => {
    const ok = () => { Z.toast(Z.L('Đã sao chép', 'Copied')); if (done) done(); };
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;opacity:0;top:0';
      document.body.append(ta); ta.select();
      let good = false;
      try { good = document.execCommand('copy'); } catch (e) { good = false; }
      ta.remove();
      if (good) return ok();
      Z.dialog({ title: Z.L('Sao chép thủ công', 'Copy manually'), body: `<p class="small" style="color:var(--muted)">${Z.L('Trình duyệt chặn clipboard. Chọn đoạn dưới và nhấn Ctrl/⌘ C.', 'Clipboard is blocked here. Select the text and press Ctrl/⌘ C.')}</p><textarea class="textarea mono" rows="5" readonly>${esc(text)}</textarea>`, mount: (d) => { const a = d.querySelector('textarea'); a.focus(); a.select(); } });
    };
    try { navigator.clipboard.writeText(text).then(ok, fallback); } catch (e) { fallback(); }
  };

  /* open an external link from script (a real anchor click keeps the new-tab behaviour) */
  Z.openUrl = (url) => { const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; document.body.append(a); a.click(); a.remove(); };

  /* ---------- modal dialogs ---------- */
  Z.dialog = ({ title, body, mount, wide, onClose }) => {
    const d = Z.h(`<dialog class="dlg light" aria-label="${esc(title)}"${wide ? ' style="width:min(560px,calc(100vw - 32px))"' : ''}>
      <div class="dh"><h2>${esc(title)}</h2><button class="x" aria-label="${Z.L('Đóng', 'Close')}">${ic('x')}</button></div>
      <div class="db"></div></dialog>`);
    const db = d.querySelector('.db');
    if (typeof body === 'string') db.innerHTML = body; else if (body) db.append(body);
    /* animate the close: Esc, ✕, backdrop click and programmatic close all run through d.close */
    const close0 = d.close.bind(d);
    d.close = (v) => {
      if (d.closing || !d.open) return; d.closing = true;
      animate(d, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(8px) scale(.97)' }], 150, EASE.in).then(() => close0(v));
    };
    d.addEventListener('cancel', (e) => { e.preventDefault(); d.close(); });
    d.querySelector('.x').onclick = () => d.close();
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
    d.addEventListener('close', () => { d.remove(); if (onClose) onClose(); });
    document.body.append(d);
    d.showModal();
    animate(d, [{ opacity: 0, transform: 'translateY(14px) scale(.96)' }, { opacity: 1, transform: 'none' }], 280, EASE.spring);
    if (mount) mount(d);
    return d;
  };
  Z.confirm = ({ title, body, ok, cancel, danger, onOk }) => {
    const d = Z.dialog({ title, body: `<p style="color:var(--muted)">${esc(body)}</p><div class="row" style="justify-content:flex-end"><button class="btn ghost" data-c>${esc(cancel || Z.L('Huỷ', 'Cancel'))}</button><button class="btn${danger ? ' acc' : ''}" data-o>${esc(ok)}</button></div>` });
    d.classList.add('light');
    d.querySelector('[data-c]').onclick = () => d.close();
    d.querySelector('[data-o]').onclick = () => { d.close(); onOk(); };
    d.querySelector('[data-c]').focus();
  };

  /* ---------- popovers and menus (one open at a time, Esc and outside click close) ---------- */
  let curPop = null;
  Z.closePop = (refocus) => {
    if (!curPop) return;
    const { el, anchor, onClose } = curPop;
    curPop = null;
    leave(el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], 120);
    if (anchor) { anchor.setAttribute('aria-expanded', 'false'); if (refocus) anchor.focus(); }
    if (onClose) onClose();
  };
  Z.popover = (anchor, content, opts) => {
    opts = opts || {};
    const again = curPop && curPop.anchor === anchor;
    Z.closePop();
    if (again && !opts.force) return null;
    const el = document.createElement('div');
    el.className = 'pop'; if (opts.cls) el.className += ' ' + opts.cls;
    if (opts.label) el.setAttribute('aria-label', opts.label);
    if (typeof content === 'string') el.innerHTML = content; else el.append(content);
    document.body.append(el);
    curPop = { el, anchor, onClose: opts.onClose };
    if (anchor) anchor.setAttribute('aria-expanded', 'true');
    const r = anchor ? anchor.getBoundingClientRect() : { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 2, bottom: innerHeight / 2 };
    const at = opts.at;
    const pw = el.offsetWidth, ph = el.offsetHeight;
    let x = at ? at.x : opts.alignRight ? r.right - pw : r.left;
    let y = at ? at.y : r.bottom + 6, up = false;
    if (y + ph > innerHeight - 8) { y = Math.max(8, (at ? at.y : r.top) - ph - 6); up = true; }
    x = Math.max(8, Math.min(x, innerWidth - pw - 8));
    el.style.left = x + 'px'; el.style.top = y + 'px';
    /* grow out of the anchor */
    el.style.transformOrigin = `${Math.max(0, Math.min(pw, (at ? at.x : (r.left + r.right) / 2) - x))}px ${up ? '100%' : '0'}`;
    animate(el, [{ opacity: 0, transform: `translateY(${up ? 6 : -6}px) scale(.95)` }, { opacity: 1, transform: 'none' }], 200, EASE.spring);
    const first = el.querySelector('.mi, input, button, a, select, textarea');
    if (first && !opts.noFocus) first.focus();
    return el;
  };
  document.addEventListener('pointerdown', (e) => {
    if (curPop && !curPop.el.contains(e.target) && !(curPop.anchor && curPop.anchor.contains(e.target))) Z.closePop();
  });
  document.addEventListener('keydown', (e) => {
    if (!curPop) return;
    if (e.key === 'Escape') { e.stopPropagation(); Z.closePop(true); return; }
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && curPop.el.contains(document.activeElement)) {
      const items = [...curPop.el.querySelectorAll('.mi')];
      if (!items.length || !items.includes(document.activeElement)) return;
      e.preventDefault();
      let i = items.indexOf(document.activeElement);
      i = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[i].focus();
    }
  }, true);
  /* items: {label, icon, small, on, checked, sep, header, href} */
  Z.menu = (anchor, items, opts) => {
    const box = document.createElement('div');
    box.setAttribute('role', 'menu');
    items.forEach((it) => {
      if (it.sep) return box.append(document.createElement('hr'));
      if (it.header) return box.append(Z.h(`<div class="ph">${esc(it.header)}</div>`));
      const b = Z.h(it.href
        ? `<a class="mi" role="menuitem" href="${esc(it.href)}" target="_blank" rel="noopener">${it.icon ? ic(it.icon) : ''}<span>${esc(it.label)}</span><small>↗</small></a>`
        : `<button class="mi" role="${it.checked != null ? 'menuitemradio' : 'menuitem'}"${it.checked != null ? ` aria-checked="${!!it.checked}"` : ''}${it.disabled ? ' disabled' : ''}${it.kbd ? ` aria-keyshortcuts="${esc(it.kbd.replace(/ /g, '+'))}"` : ''}>${it.icon ? ic(it.icon) : ''}<span>${esc(it.label)}</span>${it.small ? `<small>${esc(it.small)}</small>` : ''}${it.kbd ? Z.kbd(it.kbd) : ''}</button>`);
      b.addEventListener('click', () => { if (it.keep) { it.on(b); return; } Z.closePop(); if (it.on) it.on(); });
      box.append(b);
    });
    return Z.popover(anchor, box, opts);
  };

  /* ---------- share & QR (ShareModal / QrCodeModal) ---------- */
  Z.share = (url, title) => {
    const u = encodeURIComponent(url), t = encodeURIComponent(title || '');
    const T = [
      ['X', '#111', `https://twitter.com/intent/tweet?url=${u}&text=${t}`],
      ['Facebook', '#1877f2', `https://www.facebook.com/sharer/sharer.php?u=${u}`],
      ['WhatsApp', '#25d366', `https://wa.me/?text=${t}%20${u}`],
      ['LinkedIn', '#0a66c2', `https://www.linkedin.com/sharing/share-offsite/?url=${u}`],
      ['Messenger', '#a033ff', `fb-messenger://share/?link=${u}`],
    ];
    const d = Z.dialog({
      title: Z.L('Chia sẻ', 'Share'),
      body: `<p class="small mono" style="color:var(--muted);overflow-wrap:anywhere">${esc(url)}</p>
      <div class="share-grid">
        <button data-copy><span class="s" style="background:var(--ink)">${ic('copy')}</span>${Z.L('Sao chép', 'Copy')}</button>
        ${T.map(([n, c, href]) => `<a href="${esc(href)}" target="_blank" rel="noopener"><span class="s" style="background:${c}">${n[0]}</span>${n}</a>`).join('')}
        <button data-qr><span class="s" style="background:var(--accent)">${ic('qr')}</span>QR</button>
      </div>
      <p class="small" style="color:var(--muted)">${Z.L('Messenger mở bằng ứng dụng; trên một số trình duyệt liên kết này có thể không phản hồi.', 'Messenger opens the app; some browsers ignore that link.')}</p>`,
    });
    d.querySelector('[data-copy]').onclick = () => Z.copy(url);
    d.querySelector('[data-qr]').onclick = () => { d.close(); Z.qr(url, title); };
  };
  Z.qr = (url, title) => {
    const d = Z.dialog({
      title: Z.L('Mã QR', 'QR code'),
      body: `<div class="qr" data-q></div><p style="text-align:center;font-weight:700">${esc(title || url)}</p>
      <p class="small mono" style="text-align:center;color:var(--muted);overflow-wrap:anywhere">${esc(url)}</p>
      <div class="row" style="justify-content:center"><button class="btn" data-dl>${ic('download')} ${Z.L('Tải PNG', 'Download PNG')}</button><button class="btn ghost" data-cp>${ic('copy')} ${Z.L('Sao chép link', 'Copy link')}</button></div>`,
    });
    Z.renderQr(d.querySelector('[data-q]'), url);
    d.querySelector('[data-cp]').onclick = () => Z.copy(url);
    d.querySelector('[data-dl]').onclick = () => Z.toast(Z.L('Bản thật tải file PNG. Khung artifact chặn tải file nên demo chỉ báo ở đây.', 'The live site downloads a PNG; this preview frame blocks downloads.'), 4200);
  };
  Z.renderQr = (host, text) => {
    host.innerHTML = '';
    if (window.QRCode) { try { new window.QRCode(host, { text, width: 300, height: 300, colorDark: '#231f1c', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.M }); return; } catch (e) { /* fall through */ } }
    host.innerHTML = `<span class="small" style="color:var(--muted);text-align:center">${Z.L('Không tải được thư viện QR', 'QR library unavailable')}</span>`;
  };

  /* LinkCard ⋮ menu: copy, share, open */
  Z.linkMenu = (anchor, link) => Z.menu(anchor, [
    { label: Z.L('Sao chép link', 'Copy link'), icon: 'copy', keep: true, on: (b) => Z.copy(link.url, () => { b.querySelector('span').textContent = Z.L('Đã sao chép', 'Copied'); setTimeout(() => Z.closePop(), 700); }) },
    { label: Z.L('Chia sẻ liên kết', 'Share link'), icon: 'share', on: () => Z.share(link.url, link.title) },
    { label: Z.L('Mở tab mới', 'Open in new tab'), icon: 'ext', href: link.url },
  ], { alignRight: true });

  /* monogram tiles for products and companies */
  const HUES = ['#c4532a', '#3e6b5c', '#6b4fd6', '#2f6f8f', '#8f7a5c', '#b0476e', '#4a7a2f', '#a36a12', '#3a5bb0', '#7a3f9a', '#2d8a7a', '#9a4a2a'];
  Z.mono = (title) => {
    const clean = title.replace(/[^\p{L}\p{N} .]/gu, ' ').replace(/\(.*?\)/g, '').trim();
    const word = clean.split(/[\s.]+/).filter(Boolean);
    const special = { 'The Outstanding Production Group': 'TOP', '"Build in Public VN" Community': 'BIP', 'Build in Public VN Community': 'BIP' };
    let m = special[title] || special[clean] || (word.length > 1 ? (word[0][0] + word[1][0]) : word[0].slice(0, 2));
    if (/^AgentKit/.test(title)) m = 'AK'; if (/^AgentWiki/.test(title)) m = 'AW'; if (/^AgentBrain/.test(title)) m = 'AB';
    if (/^Dewee/.test(title)) m = 'DW'; if (/^GoClaw/.test(title)) m = 'GC'; if (/^tose/i.test(title)) m = 'TS'; if (/^IndieBoosting/.test(title)) m = 'IB';
    if (/^uupm/.test(title)) m = 'UU'; if (/^SkillX/.test(title)) m = 'SX'; if (/^FindYourAI/.test(title)) m = 'FY'; if (/^VidCap/.test(title)) m = 'VC';
    if (/^ReviewWeb/.test(title)) m = 'RW'; if (/^Xin Ch/.test(title)) m = 'XC'; if (/^Digitop/.test(title)) m = 'DG'; if (/^NEXT LEVEL/.test(title)) m = 'NL'; if (/^The Outstanding/.test(title)) m = 'TOP';
    let hash = 0; for (const ch of title) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return { m: m.toUpperCase(), c: HUES[hash % HUES.length] };
  };
  /* real site icons saved under assets/logos (128px). Value = plate colour behind a transparent mark, null = full-bleed icon */
  const LOGOS = { 'agentkit.best': '#fff', 'dewee.sh': '#f3efff', 'goclaw.sh': '#fff6ec', 'tose.sh': '#fff', 'indieboosting.com': '#fff', 'uupm.cc': '#fff', 'agentwiki.cc': '#0f1419', 'agentbrain.sh': '#fff', 'skillx.sh': '#fff', 'findyourai.tools': null, 'vidcap.zuey.me': null, 'reviewweb.site': null, 'wearetopgroup.com': '#151210', 'xinchao.world': '#151210', 'digitop.ai': null, 'nextlevelbuilder.io': null };
  const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } };
  Z.logo = (url) => { const h = hostOf(url); return h in LOGOS ? { src: `assets/logos/${h}.png`, plate: LOGOS[h] } : null; };
  /* tile for a link: site logo, the Substack mark for blogs, else a monogram */
  Z.tile = (l, cls) => {
    const lg = Z.logo(l.url);
    if (lg) return `<span class="${cls} lg${lg.plate ? '' : ' bleed'}"${lg.plate ? ` style="background:${lg.plate}"` : ''}><img src="${lg.src}" alt="" decoding="async" draggable="false"></span>`;
    if (/substack\.com/.test(l.url)) return `<span class="${cls} lg ss"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14v2.4H5zM5 8.3h14v2.4H5zM5 12.6h14V21l-7-3.9L5 21z"/></svg></span>`;
    const mo = Z.mono(Z.cleanTitle(l.title));
    return `<span class="${cls}" style="background:${mo.c}">${esc(mo.m)}</span>`;
  };
  Z.allLinks = () => {
    const L = D.links;
    return [
      ...L['Blogs & Publications'].map((l) => Object.assign({ group: 'blogs' }, l)),
      ...L['Products & AI Engineering Tools'].map((l) => Object.assign({ group: 'products' }, l)),
      ...L['Companies & Organizations'].map((l) => Object.assign({ group: 'companies' }, l)),
    ];
  };
  Z.desc = (l) => (S.lang === 'vi' ? l.desc_vi || l.desc_en : l.desc_en || l.desc_vi) || '';
  Z.cleanTitle = (t) => t.replace(/^\W+\s*/u, '');
  Z.linkCard = (l) => {
    const el = Z.h(`<div class="lc"><a href="${esc(l.url)}" target="_blank" rel="noopener">${Z.tile(l, 'mono-ic')}<div><b>${esc(Z.cleanTitle(l.title))}</b><span>${esc(Z.desc(l))}</span></div></a><button class="more" aria-label="${Z.L('Tuỳ chọn cho', 'Options for')} ${esc(Z.cleanTitle(l.title))}">${ic('more')}</button></div>`);
    el.querySelector('.more').onclick = (e) => Z.linkMenu(e.currentTarget, l);
    return el;
  };

  /* ---------- window manager: drag, 8-way resize, edge snapping, modes and animated open/close/minimize ---------- */
  const W = (Z.W = { apps: {}, wins: {}, z: 20 });
  const mq = matchMedia('(max-width:820px)');
  W.mobile = () => mq.matches;
  let layout = lsGet('zos_wins_v1', {});
  const saveLayout = () => lsSet('zos_wins_v1', layout);
  const persistOpen = () => lsSet('zos_open_v1', Object.values(W.wins).filter((w) => !w.min).map((w) => w.id));
  W.reg = (id, def) => { W.apps[id] = def; };
  const $id = (s) => document.getElementById(s);
  const GAP = 8, MIN = { w: 320, h: 260 };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
  const minOf = (w) => Object.assign({}, MIN, w.app.min);
  /* work area inside #screen: b = lowest y a window may reach without covering the dock; icons = width the desktop icons need */
  const area = () => {
    const s = $id('screen'), dk = $id('dock'), icn = $id('icons');
    const dockH = dk && dk.offsetWidth ? innerHeight - dk.getBoundingClientRect().top + 10 : GAP;
    return { w: s.clientWidth, h: s.clientHeight, b: s.clientHeight - dockH, icons: icn && icn.offsetWidth ? icn.offsetWidth + 22 : 0 };
  };
  const screenTop = () => $id('screen').getBoundingClientRect().top;
  /* keep a rect fully inside the work area, never smaller than the app's minimum unless the screen is */
  const fit = (r, w) => {
    const a = area(), m = minOf(w), maxW = a.w - 2 * GAP, maxH = a.b - GAP;
    r.w = Math.round(clamp(r.w, Math.min(m.w, maxW), maxW));
    r.h = Math.round(clamp(r.h, Math.min(m.h, maxH), maxH));
    r.x = Math.round(clamp(r.x, GAP, a.w - r.w - GAP));
    r.y = Math.round(clamp(r.y, GAP, a.b - r.h));
    return r;
  };
  const modeRect = (mode) => {
    const a = area(), half = Math.round((a.w - 3 * GAP) / 2), h = a.b - GAP;
    if (mode === 'left') return { x: GAP, y: GAP, w: half, h };
    if (mode === 'right') return { x: a.w - GAP - half, y: GAP, w: half, h };
    return { x: GAP, y: GAP, w: a.w - 2 * GAP, h };
  };
  const curRect = (w) => ({ x: w.el.offsetLeft, y: w.el.offsetTop, w: w.el.offsetWidth, h: w.el.offsetHeight });
  /* anim: glide between rects (maximize, snap, arrange); 'size' only animates width/height (tear-off while dragging) */
  const applyRect = (w, r, anim) => {
    const el = w.el;
    if (anim && !reduced) {
      const cls = anim === 'size' ? 'anim-size' : 'anim';
      el.classList.add(cls); clearTimeout(el.animT);
      el.animT = setTimeout(() => el.classList.remove('anim', 'anim-size'), 360);
    }
    Object.assign(el.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
  };
  const remember = (w) => { layout[w.id] = Object.assign({}, w.rect, { mode: w.mode }); saveLayout(); };
  const setMode = (w, mode, anim, keep) => {
    w.mode = mode; w.el.dataset.mode = mode;
    applyRect(w, mode === 'normal' ? fit(Object.assign({}, w.rect), w) : modeRect(mode), anim);
    if (!keep) remember(w);
    Z.emit('winmode', w);
  };
  const defRect = (w, i) => {
    const a = area(), aw = a.w - a.icons;
    const d = Object.assign({}, w.app.rect ? w.app.rect(aw, a.b) : { w: 560, h: 520 });
    if (d.x == null) { d.x = Math.round((aw - d.w) / 2) + i * 26; d.y = 18 + i * 24; }
    return fit(d, w);
  };
  const render = (w) => {
    const t = w.app.title(w);
    w.el.querySelector('.title').textContent = t;
    w.el.setAttribute('aria-label', t);
    w.app.render(w.body, w, w.arg);
  };
  W.visible = () => Object.values(W.wins).filter((w) => !w.min && !w.closing);

  /* where a window grows from: the control just pressed, else its dock icon */
  let lastPress = null;
  document.addEventListener('pointerdown', (e) => { const t = e.target.closest && e.target.closest('button,a,[role=option],.opt'); if (t) lastPress = { r: t.getBoundingClientRect(), t: performance.now() }; }, true);
  const dockRect = (id) => { const d = document.querySelector(`#dock [data-app="${id}"]`); return d && d.offsetWidth ? d.getBoundingClientRect() : null; };
  const originOf = (id) => (lastPress && performance.now() - lastPress.t < 700 ? lastPress.r : dockRect(id));
  const enter = (w) => {
    const el = w.el;
    if (W.mobile()) return animate(el, [{ transform: 'translateY(100%)' }, { transform: 'none' }], 420, EASE.out);
    const o = originOf(w.id), r = curRect(w), top = screenTop();
    if (o) {
      el.style.transformOrigin = `${Math.round(o.left + o.width / 2 - r.x)}px ${Math.round(o.top + o.height / 2 - top - r.y)}px`;
      return animate(el, [{ opacity: 0, transform: 'scale(.16)' }, { opacity: 1, offset: 0.4 }, { opacity: 1, transform: 'none' }], 440, EASE.spring);
    }
    el.style.transformOrigin = '50% 30%';
    return animate(el, [{ opacity: 0, transform: 'translateY(18px) scale(.94)' }, { opacity: 1, transform: 'none' }], 320, EASE.spring);
  };
  /* minimize: squeeze into the dock icon, a light take on the macOS genie */
  const genie = (w, t) => {
    const r = w.el.getBoundingClientRect();
    t = t || { left: innerWidth / 2, top: innerHeight, width: 0, height: 0 };
    const dx = t.left + t.width / 2 - (r.left + r.width / 2), dy = t.top + t.height / 2 - (r.top + r.height / 2);
    w.el.style.transformOrigin = '50% 50%';
    return [
      { transform: 'none', opacity: 1 },
      { transform: `translate(${Math.round(dx * 0.1)}px,${Math.round(dy * 0.32)}px) scale(.84,.6)`, opacity: 1, offset: 0.38 },
      { transform: `translate(${Math.round(dx)}px,${Math.round(dy)}px) scale(${Math.max(0.04, 44 / r.width).toFixed(3)},${Math.max(0.03, 44 / r.height).toFixed(3)})`, opacity: 0.1 },
    ];
  };
  const reverseKf = (kf) => kf.slice().reverse().map((k) => (k.offset != null ? Object.assign({}, k, { offset: 1 - k.offset }) : k));

  W.open = (id, arg) => {
    if (ex) exitExpo(null);
    const app = W.apps[id];
    if (!app) return null;
    Z.closePop();
    let w = W.wins[id], fresh = false, from = null;
    if (!w) {
      const tip = (vi, en, k) => `${Z.L(vi, en)} (${Z.keyText(k)})`;
      const el = Z.h(`<section class="win${app.light ? ' light' : ''}" role="dialog" data-id="${id}" data-mode="normal">
        <div class="tb" tabindex="0" title="${Z.L('Kéo để di chuyển · kéo ra mép màn hình để chia đôi · nhấp đúp để phóng to', 'Drag to move · drag to a screen edge to snap · double-click to zoom')}">
          <div class="lights"><button class="cl" aria-label="${Z.L('Đóng', 'Close')}" title="${tip('Đóng', 'Close', 'Alt W')}" aria-keyshortcuts="Alt+W">${ic('x')}</button><button class="mn" aria-label="${Z.L('Thu nhỏ', 'Minimize')}" title="${tip('Thu nhỏ', 'Minimize', 'Alt M')}" aria-keyshortcuts="Alt+M">${ic('minus')}</button><button class="mx" aria-label="${Z.L('Phóng to', 'Zoom')}" title="${tip('Phóng to · chuột phải để chia đôi', 'Zoom · right-click to snap', 'Alt ↑')}" aria-keyshortcuts="Alt+ArrowUp">${ic('plus')}</button></div>
          <button class="back" aria-label="${Z.L('Đóng cửa sổ', 'Close window')}">${ic('back')}<span>${Z.L('Màn hình chính', 'Home')}</span></button>
          <div class="title"></div><span class="grab" aria-hidden="true"></span>
        </div><div class="body"></div>
        ${['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map((d) => `<i class="rz ${d}" data-d="${d}" aria-hidden="true"></i>`).join('')}</section>`);
      $id('screen').append(el);
      const n = W.visible().length;
      w = W.wins[id] = { id, el, body: el.querySelector('.body'), app, state: {}, mode: 'normal', z: 0 };
      const sv = layout[id];
      w.rect = sv && sv.w ? fit({ x: sv.x, y: sv.y, w: sv.w, h: sv.h }, w) : defRect(w, n);
      setMode(w, sv && ['max', 'left', 'right'].includes(sv.mode) ? sv.mode : 'normal', false, true);
      wire(w);
      if (app.mount) app.mount(w);
      fresh = true;
    } else if (w.min) from = dockRect(id);
    w.arg = arg; w.min = false; w.el.hidden = false; w.el.style.pointerEvents = '';
    render(w); W.focus(id);
    if (fresh) enter(w);
    else if (from && !W.mobile()) animate(w.el, reverseKf(genie(w, from)), 420, EASE.out);
    persistOpen(); Z.emit('wins');
    return w;
  };
  W.rerender = (id) => { const w = W.wins[id]; if (w && !w.el.hidden) render(w); };
  W.refresh = () => Object.values(W.wins).forEach((w) => { if (!w.el.hidden) render(w); });
  W.focus = (id) => {
    const w = W.wins[id]; if (!w) return;
    if (W.top !== id || !w.z) w.el.style.zIndex = w.z = ++W.z;
    Object.values(W.wins).forEach((o) => o.el.classList.toggle('focus', o === w));
    W.top = id;
  };
  const focusTop = () => {
    const v = W.visible().sort((a, b) => a.z - b.z);
    W.top = null;
    if (v.length) W.focus(v[v.length - 1].id); else Object.values(W.wins).forEach((o) => o.el.classList.remove('focus'));
  };
  W.close = (id) => {
    if (ex) exitExpo(null);
    const w = W.wins[id]; if (!w || w.closing) return;
    w.closing = true;
    if (w.app.onClose) w.app.onClose(w);
    delete W.wins[id]; persistOpen(); focusTop(); Z.emit('wins');
    if (W.mobile()) leave(w.el, [{ transform: `translateY(${w.dy || 0}px)` }, { transform: 'translateY(100%)' }], 300);
    else { w.el.style.transformOrigin = '50% 40%'; leave(w.el, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.94) translateY(6px)' }], 170); }
  };
  W.minimize = (id) => {
    const w = W.wins[id]; if (!w || w.min) return;
    if (W.mobile()) return W.close(id);
    w.min = true; persistOpen(); focusTop(); Z.emit('wins');
    w.el.style.pointerEvents = 'none';
    animate(w.el, genie(w, dockRect(id)), 480, EASE.genie).then(() => { if (w.min) w.el.hidden = true; w.el.style.pointerEvents = ''; });
  };
  W.minimizeAll = () => W.visible().forEach((w) => W.minimize(w.id));
  W.toggleMax = (id) => { const w = W.wins[id]; if (w && !W.mobile()) setMode(w, w.mode === 'max' ? 'normal' : 'max', true); };
  W.snap = (id, side) => { const w = W.wins[id]; if (w && !W.mobile()) setMode(w, w.mode === side ? 'normal' : side, true); };
  /* Alt ↓: a zoomed or snapped window returns to its size first, a normal one minimizes */
  W.restore = (id) => { const w = W.wins[id]; if (!w) return; if (w.mode !== 'normal') setMode(w, 'normal', true); else W.minimize(id); };
  W.closeAll = () => Object.keys(W.wins).forEach(W.close);
  W.arrange = () => {
    layout = {}; saveLayout();
    W.visible().forEach((w, i) => { w.rect = defRect(w, i); setMode(w, 'normal', true, true); });
  };
  W.cycle = (dir) => {
    const v = W.visible(); if (!v.length) return;
    const i = v.findIndex((w) => w.id === W.top);
    W.focus(v[(i + (dir < 0 ? -1 : 1) + v.length) % v.length].id);
  };
  W.isOpen = (id) => !!(W.wins[id] && !W.wins[id].min);
  W.menuFor = (id, at) => {
    const w = W.wins[id]; if (!w || W.mobile()) return;
    Z.menu(null, [
      { label: w.mode === 'max' ? Z.L('Thu về kích thước cũ', 'Restore size') : Z.L('Phóng to', 'Zoom'), icon: 'layout', kbd: w.mode === 'max' ? 'Alt ↓' : 'Alt ↑', on: () => W.toggleMax(id) },
      { label: Z.L('Chia đôi bên trái', 'Snap left'), icon: 'back', kbd: 'Alt ←', checked: w.mode === 'left' ? true : undefined, on: () => W.snap(id, 'left') },
      { label: Z.L('Chia đôi bên phải', 'Snap right'), icon: 'next', kbd: 'Alt →', checked: w.mode === 'right' ? true : undefined, on: () => W.snap(id, 'right') },
      { sep: true },
      { label: Z.L('Thu nhỏ xuống Dock', 'Minimize to Dock'), icon: 'minus', kbd: 'Alt M', on: () => W.minimize(id) },
      { label: Z.L('Đóng cửa sổ', 'Close window'), icon: 'x', kbd: 'Alt W', on: () => W.close(id) },
    ], { at, force: true, label: Z.L('Cửa sổ', 'Window') });
  };

  /* snap preview shown while a drag sits on a screen edge */
  let ghost = null;
  const showGhost = (zone, w) => {
    if (!ghost) { ghost = Z.h('<div class="snap-ghost" aria-hidden="true"></div>'); $id('screen').append(ghost); }
    if (!zone) { ghost.classList.remove('on'); return; }
    const r = modeRect(zone);
    ghost.style.zIndex = w.z; w.el.style.zIndex = w.z = ++W.z;
    Object.assign(ghost.style, { left: r.x + 'px', top: r.y + 'px', width: r.w + 'px', height: r.h + 'px' });
    ghost.classList.add('on');
  };

  const wire = (w) => {
    const { el } = w, tb = el.querySelector('.tb');
    el.addEventListener('pointerdown', () => W.focus(w.id));
    el.querySelector('.cl').onclick = () => W.close(w.id);
    el.querySelector('.back').onclick = () => W.close(w.id);
    el.querySelector('.mn').onclick = () => W.minimize(w.id);
    el.querySelector('.mx').onclick = () => W.toggleMax(w.id);
    tb.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) W.toggleMax(w.id); });
    tb.addEventListener('contextmenu', (e) => { if (W.mobile()) return; e.preventDefault(); W.focus(w.id); W.menuFor(w.id, { x: e.clientX, y: e.clientY }); });

    /* title bar drag: desktop moves and snaps, mobile pulls the sheet down to dismiss */
    let drag = null;
    tb.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      drag = W.mobile() ? { mob: true, sy: e.clientY, dy: 0 } : { sx: e.clientX, sy: e.clientY, r: curRect(w), moved: false, zone: null, top: screenTop() };
      tb.setPointerCapture(e.pointerId);
    });
    tb.addEventListener('pointermove', (e) => {
      if (!drag) return;
      if (drag.mob) { drag.dy = Math.max(0, e.clientY - drag.sy); el.style.transform = drag.dy ? `translateY(${drag.dy}px)` : ''; return; }
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 4) return;
        drag.moved = true; el.classList.add('dragging');
        if (w.mode !== 'normal') {
          /* tear-off: shrink back to the saved size, keeping the grab point under the cursor */
          const fx = (drag.sx - drag.r.x) / drag.r.w;
          drag.r = { x: Math.round(drag.sx - w.rect.w * fx), y: drag.r.y, w: w.rect.w, h: w.rect.h };
          w.mode = 'normal'; el.dataset.mode = 'normal';
          applyRect(w, drag.r, 'size');
        }
      }
      const a = area();
      el.style.left = clamp(drag.r.x + e.clientX - drag.sx, 120 - drag.r.w, a.w - 120) + 'px';
      el.style.top = clamp(drag.r.y + e.clientY - drag.sy, 0, a.h - 44) + 'px';
      const zone = e.clientX <= 6 ? 'left' : e.clientX >= innerWidth - 7 ? 'right' : e.clientY <= drag.top + 2 ? 'max' : null;
      if (zone !== drag.zone) { drag.zone = zone; showGhost(zone, w); }
    });
    const end = () => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.mob) {
        if (d.dy > 110) { w.dy = d.dy; W.close(w.id); }
        else if (d.dy) animate(el, [{ transform: `translateY(${d.dy}px)` }, { transform: 'none' }], 260, EASE.spring);
        el.style.transform = '';
        return;
      }
      el.classList.remove('dragging'); showGhost(null);
      if (!d.moved) return;
      w.rect = curRect(w);
      if (d.zone) setMode(w, d.zone, true); else remember(w);
    };
    tb.addEventListener('pointerup', end); tb.addEventListener('pointercancel', end);
    tb.addEventListener('keydown', (e) => {
      if (e.target !== tb) return;
      const step = e.shiftKey ? 60 : 20, k = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (k && !e.altKey && !W.mobile()) {
        e.preventDefault();
        w.rect = fit({ x: el.offsetLeft + k[0] * step, y: el.offsetTop + k[1] * step, w: el.offsetWidth, h: el.offsetHeight }, w);
        setMode(w, 'normal');
      }
      if (e.key === 'Escape') W.close(w.id);
    });

    /* 8-way resize; double-click an edge to stretch that side to the screen */
    el.querySelectorAll('.rz').forEach((h) => {
      const d = h.dataset.d;
      let st = null;
      h.addEventListener('pointerdown', (e) => {
        if (e.button !== 0 || W.mobile()) return;
        e.preventDefault(); e.stopPropagation(); W.focus(w.id);
        st = { sx: e.clientX, sy: e.clientY, r: curRect(w), a: area(), m: minOf(w) };
        if (w.mode !== 'normal') { w.mode = 'normal'; el.dataset.mode = 'normal'; }
        h.setPointerCapture(e.pointerId); el.classList.add('resizing');
      });
      h.addEventListener('pointermove', (e) => {
        if (!st) return;
        const { r, a, m } = st, dx = e.clientX - st.sx, dy = e.clientY - st.sy, n = Object.assign({}, r);
        if (d.includes('e')) n.w = Math.round(clamp(r.w + dx, m.w, a.w - r.x - 2));
        if (d.includes('s')) n.h = Math.round(clamp(r.h + dy, m.h, a.b - r.y));
        if (d.includes('w')) { n.w = Math.round(clamp(r.w - dx, m.w, r.x + r.w)); n.x = r.x + r.w - n.w; }
        if (d.includes('n')) { n.h = Math.round(clamp(r.h - dy, m.h, r.y + r.h)); n.y = r.y + r.h - n.h; }
        applyRect(w, n);
      });
      const done = () => { if (!st) return; st = null; el.classList.remove('resizing'); w.rect = curRect(w); remember(w); Z.emit('winmode', w); };
      h.addEventListener('pointerup', done); h.addEventListener('pointercancel', done);
      h.addEventListener('dblclick', () => {
        const a = area(), r = curRect(w);
        if (d === 'n' || d === 's') Object.assign(r, { y: GAP, h: a.b - GAP });
        else if (d === 'e' || d === 'w') Object.assign(r, { x: GAP, w: a.w - 2 * GAP });
        else return;
        w.rect = r; setMode(w, 'normal', true);
      });
    });
  };
  /* keep every window reachable when the viewport changes */
  let fitRaf = 0;
  addEventListener('resize', () => {
    cancelAnimationFrame(fitRaf);
    fitRaf = requestAnimationFrame(() => { if (!W.mobile()) Object.values(W.wins).forEach((w) => applyRect(w, w.mode === 'normal' ? fit(Object.assign({}, w.rect), w) : modeRect(w.mode))); });
  });
  /* ---------- Exposé: every window, minimized ones too, glides into a grid of live thumbnails ---------- */
  let ex = null;
  W.inExpo = () => !!ex;
  const expoLayout = (rects) => {
    const a = area(), pad = 28, lbl = 36, top = 54, bot = 16, n = rects.length;
    const AW = a.w - pad * 2, AH = a.b - top - bot;
    let best = null;
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols), cw = (AW - pad * (cols - 1)) / cols, ch = (AH - pad * (rows - 1)) / rows - lbl;
      if (cw < 60 || ch < 40) continue;
      const sc = rects.map((r) => Math.min(cw / r.w, ch / r.h, 0.86));
      const score = sc.reduce((t, s, i) => t + s * s * rects[i].w * rects[i].h, 0);
      if (!best || score > best.score * 1.02) best = { cols, rows, cw, ch, sc, score };
    }
    if (!best) best = { cols: n, rows: 1, cw: 60, ch: 40, sc: rects.map((r) => Math.min(60 / r.w, 40 / r.h)) };
    const { cols, rows, cw, ch, sc } = best;
    const gridH = rows * (ch + lbl) + (rows - 1) * pad, y0 = top + Math.max(0, (AH - gridH) / 2);
    return {
      cols,
      slots: rects.map((r, i) => {
        const row = Math.floor(i / cols), col = i % cols, inRow = row === rows - 1 ? n - row * cols : cols;
        const x0 = pad + (AW - (inRow * cw + (inRow - 1) * pad)) / 2;
        return { s: sc[i], cx: x0 + col * (cw + pad) + cw / 2, cy: y0 + row * (ch + lbl + pad) + ch / 2, cw };
      }),
    };
  };
  /* transform that shrinks a window (origin top-left) onto its dock icon */
  const toDockT = (w, r) => {
    const t = dockRect(w.id) || { left: innerWidth / 2 - 22, top: innerHeight - 56, width: 44, height: 44 };
    const s = Math.max(0.04, 44 / r.w), top = screenTop();
    return `translate(${Math.round(t.left + t.width / 2 - (s * r.w) / 2 - r.x)}px,${Math.round(t.top - top + t.height / 2 - (s * r.h) / 2 - r.y)}px) scale(${s.toFixed(3)})`;
  };
  const expoMark = () => {
    ex.order.forEach((w, i) => { w.el.classList.toggle('expo-sel', i === ex.sel); w.exLbl.classList.toggle('on', i === ex.sel); });
    const w = ex.order[ex.sel];
    if (w) ex.live.textContent = `${ex.sel + 1}/${ex.order.length} · ${w.app.title(w)}`;
  };
  W.expo = () => {
    if (ex) { exitExpo(null); return true; }
    if (W.mobile()) return false;
    const list = Object.values(W.wins).filter((w) => !w.closing);
    if (!list.length) return false;
    Z.closePop();
    list.forEach((w) => { w.exMin = w.min; if (w.min) { w.el.hidden = false; render(w); } w.exR = curRect(w); });
    const band = (w) => Math.round(w.exR.y / 220);
    const order = [...list.filter((w) => !w.exMin).sort((p, q) => band(p) - band(q) || p.exR.x - q.exR.x), ...list.filter((w) => w.exMin)];
    const { cols, slots } = expoLayout(order.map((w) => w.exR));
    const bg = Z.h(`<div class="expo-bg" role="dialog" aria-modal="true" aria-label="${Z.L('Tất cả cửa sổ', 'All windows')}" tabindex="-1">
      <p class="expo-hint"><b>${Z.L('Tất cả cửa sổ', 'All windows')}</b><span>${Z.kbd('← → ↑ ↓')} ${Z.L('chọn', 'select')} ${Z.kbd('↵')} ${Z.L('mở', 'open')} ${Z.kbd('1–9')} ${Z.L('mở nhanh', 'jump')} ${Z.kbd('Esc')} ${Z.L('thoát', 'exit')}</span></p>
      <div class="sr" aria-live="polite"></div></div>`);
    $id('screen').append(bg);
    ex = { order, bg, cols, live: bg.querySelector('[aria-live]'), prevTop: W.top, prevFocus: document.activeElement, sel: Math.max(0, order.findIndex((w) => w.id === W.top)) };
    document.body.classList.add('expo-on');
    animate(bg, [{ opacity: 0 }, { opacity: 1 }], 280);
    order.forEach((w, i) => {
      const r = w.exR, s = slots[i];
      const to = `translate(${Math.round(s.cx - (r.w * s.s) / 2 - r.x)}px,${Math.round(s.cy - (r.h * s.s) / 2 - r.y)}px) scale(${s.s.toFixed(4)})`;
      w.el.style.setProperty('--xs', s.s.toFixed(4));
      w.el.classList.add('expo-win');
      w.el.style.transformOrigin = '0 0';
      w.el.style.transform = to;
      animate(w.el, [{ transform: w.exMin ? toDockT(w, r) : 'none', opacity: w.exMin ? 0 : 1 }, { transform: to, opacity: 1 }], 480 + i * 22, EASE.spring);
      w.exLbl = Z.h(`<button class="expo-lbl" data-id="${w.id}" tabindex="-1" style="left:${Math.round(s.cx)}px;top:${Math.round(s.cy + (r.h * s.s) / 2 + 10)}px;max-width:${Math.round(s.cw)}px">${i < 9 ? `<i>${i + 1}</i>` : ''}${w.app.icon()}<span>${esc(w.app.title(w))}</span>${w.exMin ? `<small>${Z.L('đã thu nhỏ', 'minimized')}</small>` : ''}</button>`);
      bg.append(w.exLbl);
    });
    expoMark();
    bg.focus({ preventScroll: true });
    Z.emit('expo', true);
    return true;
  };
  const exitExpo = (pickId) => {
    if (!ex) return;
    const e = ex; ex = null;
    document.body.classList.remove('expo-on');
    leave(e.bg, [{ opacity: 1 }, { opacity: 0 }], 240);
    const pick = pickId ? W.wins[pickId] : null;
    if (pick) { if (pick.min) { pick.min = false; persistOpen(); Z.emit('wins'); } W.focus(pick.id); }
    else if (e.prevTop && W.wins[e.prevTop] && !W.wins[e.prevTop].min) W.focus(e.prevTop);
    e.order.forEach((w) => {
      w.el.classList.remove('expo-win', 'expo-sel');
      if (W.wins[w.id] !== w) return;
      const from = w.el.style.transform, to = w.min ? toDockT(w, w.exR) : 'none';
      w.el.style.transform = '';
      animate(w.el, [{ transform: from, opacity: 1 }, { transform: to, opacity: w.min ? 0 : 1 }], w === pick ? 460 : 380, w === pick ? EASE.spring : EASE.out).then(() => {
        if (ex) return;
        if (w.min) w.el.hidden = true;
        w.el.style.transformOrigin = '';
      });
    });
    const f = pick ? pick.el.querySelector('.tb') : e.prevFocus;
    if (f && f.focus && document.contains(f)) f.focus({ preventScroll: true });
    Z.emit('expo', false);
  };
  W.exitExpo = exitExpo;
  $id('screen').addEventListener('click', (e) => {
    if (!ex) return;
    const t = e.target.closest('.win,.expo-lbl');
    e.stopPropagation();
    exitExpo(t ? t.dataset.id : null);
  }, true);
  $id('screen').addEventListener('pointerover', (e) => {
    if (!ex) return;
    const t = e.target.closest('.win,.expo-lbl'); if (!t) return;
    const i = ex.order.findIndex((w) => w.id === t.dataset.id);
    if (i >= 0 && i !== ex.sel) { ex.sel = i; expoMark(); }
  });
  document.addEventListener('keydown', (e) => {
    if (!ex) return;
    const n = ex.order.length, k = e.key;
    let ok = true;
    if (k === 'Escape' || (e.altKey && e.code === 'KeyO')) exitExpo(null);
    else if (k === 'Enter' || k === ' ') exitExpo(ex.order[ex.sel].id);
    else if (k === 'ArrowRight' || (k === 'Tab' && !e.shiftKey)) { ex.sel = (ex.sel + 1) % n; expoMark(); }
    else if (k === 'ArrowLeft' || (k === 'Tab' && e.shiftKey)) { ex.sel = (ex.sel - 1 + n) % n; expoMark(); }
    else if (k === 'ArrowDown') { ex.sel = Math.min(n - 1, ex.sel + ex.cols); expoMark(); }
    else if (k === 'ArrowUp') { ex.sel = Math.max(0, ex.sel - ex.cols); expoMark(); }
    else if (/^[1-9]$/.test(k) && +k <= n) exitExpo(ex.order[+k - 1].id);
    else ok = false;
    if (ok) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  addEventListener('resize', () => { if (ex) exitExpo(null); });
  Z.on('wins', () => document.body.classList.toggle('sheet-open', W.mobile() && W.visible().length > 0));

  /* ---------- mascot sprite player (cells and timings from public/mascot/manifest.json) ---------- */
  const F = {
    'idle-0': [0, 0], 'idle-blink': [1, 0], 'idle-breathe': [2, 0], 'idle-1': [3, 0],
    'walk-0': [0, 1], 'walk-1': [1, 1], 'walk-2': [2, 1], 'walk-3': [3, 1],
    'wave-0': [0, 2], 'wave-1': [1, 2], 'wave-2': [2, 2], 'wave-3': [3, 2],
    thinking: [0, 3], happy: [1, 3], surprised: [2, 3], talking: [3, 3],
  };
  const A = {
    idle: { loop: 1, f: [['idle-0', 1400], ['idle-blink', 140], ['idle-breathe', 700], ['idle-1', 1100]] },
    walk: { loop: 1, f: [['walk-0', 125], ['walk-1', 125], ['walk-2', 125], ['walk-3', 125]] },
    wave: { f: [['wave-0', 120], ['wave-1', 160], ['wave-2', 320], ['wave-1', 160], ['wave-2', 320], ['wave-3', 200]] },
    talk: { loop: 1, f: [['talking', 180], ['idle-0', 140]] },
    thinking: { f: [['thinking', 1200]] }, happy: { f: [['happy', 1200]] }, surprised: { f: [['surprised', 1200]] },
  };
  const M = (Z.M = { x: 0, y: 0, tx: null, mood: null, bubbles: 0, paused: false });
  const COPY = {
    label: () => Z.L('Bạn đồng hành Zuey. Enter để vẫy tay, phím mũi tên để di chuyển, kéo để đặt chỗ.', 'Zuey companion. Enter to wave, arrow keys to move, drag to place.'),
    greet: () => S.lang === 'vi' ? ['Chào bạn! Mình là bạn đồng hành của Zuey.', 'Xin chào! Kéo mình đi đâu cũng được.', 'Hey! Nhấn Ctrl/⌘ K để mở bảng lệnh.'] : ['Hi! I am Zuey\'s companion.', 'Hello! Drag me anywhere.', 'Hey! Press Ctrl/⌘ K for commands.'],
    tips: () => S.lang === 'vi' ? ['Nhấn Ctrl/⌘ K để mở bảng lệnh.', 'Kéo mình đi đâu cũng được. Khi bạn gõ phím, mình sẽ tránh sang bên.', 'Chọn thành phố ở mục Thời tiết, nền trang sẽ đổi theo trời.', 'Bạn có thể kết nối Zuey với Claude, ChatGPT hoặc Cursor qua MCP.', 'Tò mò Duy đang làm gì? Mở cửa sổ "Zuey đang làm gì".'] : ['Press Ctrl/⌘ K for the command palette.', 'Drag me anywhere. I step aside while you type.', 'Pick a city under Weather and the wallpaper follows the sky.', 'Connect Zuey to Claude, ChatGPT or Cursor via MCP.', 'Curious what Duy is doing? Open "What Zuey is doing".'],
    wx: { clear: ['Trời nắng đẹp ghê!', 'Lovely sunny day!'], rain: ['Trời mưa… hợp để đọc bài.', 'Rainy… good time to read.'], snow: ['Tuyết á?! Giữ ấm nhé.', 'Snow?! Stay warm.'], storm: ['Có dông, cẩn thận nhé.', 'Storm outside, take care.'], clouds: ['Hôm nay nhiều mây.', 'Cloudy today.'], fog: ['Ngoài trời có sương mù.', 'Foggy outside.'], night: ['Khuya rồi, nghỉ ngơi chút nhé.', 'It is late, take a break.'] },
  };
  M.COPY = COPY;
  const ground = () => innerHeight - M.size - (W.mobile() ? 78 : 64);
  M.show = (name) => { const c = F[name]; M.cur = name; M.sp.style.backgroundPosition = `${-c[0] * M.size}px ${-c[1] * M.size}px`; };
  M.play = (name, then) => {
    const a = A[name] || A.idle; let i = 0;
    clearTimeout(M.timer); M.anim = name;
    if (reduced) { M.show(a.f[0][0]); if (!a.loop) M.timer = setTimeout(() => M.play(then || 'idle'), 1400); return; }
    const step = () => {
      M.show(a.f[i][0]);
      M.timer = setTimeout(() => { i++; if (i >= a.f.length) { if (!a.loop) return M.play(then || 'idle'); i = 0; } step(); }, a.f[i][1]);
    };
    step();
  };
  const place = () => {
    M.el.style.transform = `translate(${Math.round(M.x)}px,${Math.round(M.y)}px)`;
    if (M.bubble) placeBubble();
  };
  const save = () => lsSet('zuey_mascot_v1', { rx: M.x / innerWidth, ry: M.y / innerHeight, paused: M.paused });
  M.walkTo = (x) => { M.tx = Math.max(8, Math.min(x, innerWidth - M.size - 8)); M.el.classList.toggle('flip', M.tx < M.x); if (M.anim !== 'walk') M.play('walk'); };
  let last = 0, idleUntil = performance.now() + 4000;
  const tick = (t) => {
    const dt = Math.min(64, t - (last || t)); last = t;
    if (M.tx != null && !M.drag && !M.mood) {
      const dir = Math.sign(M.tx - M.x), sp = reduced ? 9999 : 0.065 * dt;
      if (Math.abs(M.tx - M.x) <= sp) { M.x = M.tx; M.tx = null; M.play('idle'); idleUntil = t + 4000 + Math.random() * 6000; save(); }
      else M.x += dir * sp;
      place();
    } else if (!M.paused && !M.drag && !M.mood && t > idleUntil && !document.body.classList.contains('zm-hidden') && !reduced) {
      M.walkTo(40 + Math.random() * (innerWidth - M.size - 80));
    }
    requestAnimationFrame(tick);
  };
  /* bubble: greetings, tips and notices from Duy */
  const placeBubble = () => {
    const b = M.bubble, bw = b.offsetWidth, bh = b.offsetHeight;
    const cx = M.x + M.size / 2;
    const left = Math.max(8, Math.min(cx - bw / 2, innerWidth - bw - 8));
    b.style.left = left + 'px'; b.style.top = Math.max(44, M.y - bh + 4) + 'px';
    b.style.setProperty('--tail', Math.max(14, Math.min(bw - 14, cx - left)) + 'px');
  };
  M.say = (text, o) => {
    o = o || {};
    if (document.body.classList.contains('zm-hidden') && !o.duy) return;
    M.hush();
    const b = (M.bubble = Z.h(`<div class="bubble" role="status">
      <div class="bh">${o.duy ? `<span class="duy">${Z.L('Thông báo từ Duy', 'Notice from Duy')}</span>` : 'Zuey'}<button class="bx" aria-label="${Z.L('Đóng tin nhắn', 'Close message')}">${ic('x')}</button></div>
      <div>${esc(text)}</div>
      ${o.until ? `<div class="small" style="color:var(--muted);margin-top:4px">${Z.fmt(Z.L('Đến {time}', 'Until {time}'), { time: Z.time(o.until) })}</div>` : ''}
      ${o.duy ? `<div class="ba"><button class="btn sm" data-d>${Z.L('Bỏ qua', 'Dismiss')}</button></div>` : ''}</div>`));
    document.body.append(b);
    b.querySelector('.bx').onclick = () => M.hush();
    if (o.duy) b.querySelector('[data-d]').onclick = () => { M.hush(); if (o.onDismiss) o.onDismiss(); };
    placeBubble();
    if (!o.duy) M.bubbleT = setTimeout(M.hush, o.ms || 6500);
    if (!M.mood) M.play('talk');
    setTimeout(() => { if (M.anim === 'talk' && !M.mood) M.play('idle'); }, 2600);
  };
  M.hush = () => { clearTimeout(M.bubbleT); if (M.bubble) { M.bubble.remove(); M.bubble = null; } };
  M.tip = () => {
    if (M.bubbles >= 4) return;
    const list = M.bubbles === 0 ? COPY.greet() : COPY.tips();
    M.say(list[Math.floor(Math.random() * list.length)]);
    M.bubbles++;
  };
  /* mood: hold an expression while AI works ('thinking', 'talk'), or one-shot ('happy', 'surprised', 'wave') */
  M.react = (mood) => {
    if (!M.el) return;
    if (mood === 'thinking') { M.mood = mood; M.tx = null; clearTimeout(M.timer); M.show('thinking'); return; }
    if (mood === 'talk') { M.mood = mood; M.tx = null; M.play('talk'); return; }
    M.mood = null;
    if (mood) M.play(mood, 'idle'); else M.play('idle');
  };
  M.avoid = (r) => {
    if (!M.el || document.body.classList.contains('zm-hidden')) return;
    const m = { l: M.x, r: M.x + M.size, t: M.y, b: M.y + M.size };
    if (m.r < r.left - 20 || m.l > r.right + 20 || m.b < r.top - 20 || m.t > r.bottom + 20) return;
    M.walkTo(r.left + r.width / 2 > innerWidth / 2 ? 24 : innerWidth - M.size - 24);
  };
  M.setHidden = (hide) => {
    document.body.classList.toggle('zm-hidden', hide);
    lsSet('zuey_mascot_hidden_v1', hide);
    if (hide) M.hush();
    Z.emit('mascot');
  };
  M.setPaused = (p) => {
    M.paused = p; if (p) { M.tx = null; M.play('idle'); }
    const b = M.el.querySelector('[data-a=pause]');
    b.innerHTML = ic(p ? 'play' : 'pause');
    b.setAttribute('aria-label', p ? Z.L('Cho Zuey đi dạo', 'Let Zuey roam') : Z.L('Cho Zuey đứng yên', 'Keep Zuey still'));
    b.title = b.getAttribute('aria-label');
    save();
  };
  M.init = () => {
    const el = (M.el = Z.h(`<div class="zm"><div class="sp"></div>
      <div class="tools"><button data-a="pause"></button><button data-a="hide">${ic('eyeoff')}</button></div>
      <div class="hit" tabindex="0" role="button"></div></div>`));
    document.body.append(el);
    M.sp = el.querySelector('.sp');
    const hit = el.querySelector('.hit');
    const setLabels = () => {
      hit.setAttribute('aria-label', COPY.label());
      const hb = el.querySelector('[data-a=hide]'); hb.setAttribute('aria-label', Z.L('Ẩn Zuey', 'Hide Zuey')); hb.title = hb.getAttribute('aria-label');
    };
    setLabels(); Z.on('lang', setLabels);
    const measure = () => { M.size = el.offsetWidth; };
    measure();
    const sv = lsGet('zuey_mascot_v1', null);
    M.x = sv ? sv.rx * innerWidth : innerWidth * 0.32;
    M.y = sv ? sv.ry * innerHeight : ground();
    M.x = Math.max(8, Math.min(M.x, innerWidth - M.size - 8)); M.y = Math.max(44, Math.min(M.y, innerHeight - M.size));
    M.setPaused(!!(sv && sv.paused));
    place(); M.play('idle');
    if (lsGet('zuey_mascot_hidden_v1', false)) document.body.classList.add('zm-hidden');
    el.querySelector('[data-a=pause]').onclick = () => M.setPaused(!M.paused);
    el.querySelector('[data-a=hide]').onclick = () => { M.setHidden(true); Z.toast(Z.L('Đã ẩn Zuey. Bật lại ở thanh trên cùng.', 'Zuey hidden. Turn back on from the top bar.')); };
    hit.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      M.drag = { dx: e.clientX - M.x, dy: e.clientY - M.y, moved: false };
      hit.setPointerCapture(e.pointerId);
    });
    hit.addEventListener('pointermove', (e) => {
      if (!M.drag) return;
      const nx = e.clientX - M.drag.dx, ny = e.clientY - M.drag.dy;
      if (!M.drag.moved && Math.hypot(nx - M.x, ny - M.y) > 4) { M.drag.moved = true; M.tx = null; M.show('surprised'); clearTimeout(M.timer); }
      if (!M.drag.moved) return;
      M.x = Math.max(0, Math.min(nx, innerWidth - M.size)); M.y = Math.max(40, Math.min(ny, innerHeight - M.size)); place();
    });
    const up = () => {
      if (!M.drag) return;
      const moved = M.drag.moved; M.drag = null;
      if (moved) { save(); M.play('happy'); idleUntil = performance.now() + 8000; } else { M.play('wave'); M.tip(); }
    };
    hit.addEventListener('pointerup', up); hit.addEventListener('pointercancel', up);
    hit.addEventListener('keydown', (e) => {
      const k = { ArrowLeft: [-24, 0], ArrowRight: [24, 0], ArrowUp: [0, -24], ArrowDown: [0, 24] }[e.key];
      if (k) { e.preventDefault(); M.tx = null; M.x = Math.max(0, Math.min(M.x + k[0], innerWidth - M.size)); M.y = Math.max(40, Math.min(M.y + k[1], innerHeight - M.size)); if (k[0]) M.el.classList.toggle('flip', k[0] < 0); place(); save(); }
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); M.play('wave'); M.say(COPY.greet()[0]); }
    });
    /* step aside from the field being typed in */
    document.addEventListener('focusin', (e) => { if (e.target.matches('input,textarea')) M.avoid(e.target.getBoundingClientRect()); });
    document.addEventListener('input', (e) => { if (e.target.matches('input,textarea')) M.avoid(e.target.getBoundingClientRect()); });
    addEventListener('resize', () => { measure(); M.x = Math.min(M.x, innerWidth - M.size - 8); M.y = Math.min(M.y, ground()); place(); });
    requestAnimationFrame(tick);
    setTimeout(M.tip, 1600);
    setInterval(() => { if (!M.bubble && !M.mood && document.visibilityState === 'visible') M.tip(); }, 45000);
  };

  /* ---------- wallpaper and weather effects ---------- */
  const FX = (Z.FX = {});
  FX.COND = {
    clear: { vi: 'Trời quang', en: 'Clear', icon: 'sun', temp: 31, mood: 'happy' },
    clouds: { vi: 'Nhiều mây', en: 'Cloudy', icon: 'cloud', temp: 29 },
    fog: { vi: 'Sương mù', en: 'Fog', icon: 'fog', temp: 24 },
    rain: { vi: 'Mưa', en: 'Rain', icon: 'rain', temp: 26, mood: 'thinking' },
    storm: { vi: 'Dông', en: 'Storm', icon: 'bolt', temp: 25, mood: 'surprised' },
    snow: { vi: 'Tuyết', en: 'Snow', icon: 'snow', temp: -2, mood: 'surprised' },
    night: { vi: 'Ban đêm', en: 'Night', icon: 'moon', temp: 27 },
  };
  let parts = [], ctx = null, cv = null, raf = 0, flashT = 0;
  FX.set = (cond) => {
    const host = document.getElementById('wx');
    cancelAnimationFrame(raf); clearInterval(flashT);
    host.innerHTML = ''; host.dataset.c = cond || '';
    if (!cond) return;
    if (['clouds', 'fog', 'storm', 'rain'].includes(cond)) {
      for (let i = 0; i < (cond === 'fog' ? 6 : 4); i++) {
        const c = document.createElement('div'); c.className = 'cloud';
        const s = 260 + Math.random() * 280;
        Object.assign(c.style, { width: s + 'px', height: s * 0.45 + 'px', top: 40 + Math.random() * (cond === 'fog' ? 600 : 220) + 'px', animationDuration: 70 + Math.random() * 60 + 's', animationDelay: -Math.random() * 90 + 's' });
        if (reduced) c.style.animation = 'none', c.style.left = Math.random() * 80 + '%';
        host.append(c);
      }
    }
    if (['rain', 'storm', 'snow', 'night'].includes(cond)) {
      cv = document.createElement('canvas'); host.append(cv); ctx = cv.getContext('2d');
      const fit = () => { cv.width = innerWidth; cv.height = innerHeight; };
      fit(); addEventListener('resize', fit);
      const n = cond === 'night' ? 90 : cond === 'snow' ? 120 : cond === 'storm' ? 260 : 170;
      parts = Array.from({ length: n }, () => ({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, v: 0.4 + Math.random(), r: Math.random() }));
      const draw = () => {
        ctx.clearRect(0, 0, cv.width, cv.height);
        parts.forEach((p) => {
          if (cond === 'night') { ctx.fillStyle = `rgba(255,248,230,${0.25 + 0.5 * Math.abs(Math.sin(p.r * 10 + performance.now() / 1400))})`; ctx.fillRect(p.x, p.y * 0.7, 1.6, 1.6); return; }
          if (cond === 'snow') { ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.beginPath(); ctx.arc(p.x, p.y, 1 + p.r * 2.2, 0, 7); ctx.fill(); p.y += p.v * 0.9; p.x += Math.sin(p.y / 40 + p.r * 6) * 0.4; }
          else { ctx.strokeStyle = 'rgba(190,210,235,.38)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - 3, p.y + 14 + p.v * 8); ctx.stroke(); p.y += (cond === 'storm' ? 16 : 11) * p.v; p.x -= 1.5; }
          if (p.y > innerHeight) { p.y = -20; p.x = Math.random() * (innerWidth + 100); }
        });
        if (!reduced) raf = requestAnimationFrame(draw);
      };
      draw();
    }
    if (cond === 'storm' && !reduced) {
      const f = document.createElement('div'); f.className = 'flash'; host.append(f);
      flashT = setInterval(() => { f.classList.remove('on'); void f.offsetWidth; f.classList.add('on'); }, 7000);
    }
  };
  /* wallpapers: gradient presets, the zuey.me video loop, or a photo the visitor picks (kept on this device) */
  Z.WALLS = ['gradient', 'dusk', 'forest', 'ocean', 'aurora', 'mono', 'video', 'image'];
  Z.wallImg = () => Z.memWall || lsGet('zos_wall_img_v1', '');
  FX.bg = (mode) => {
    const desk = document.getElementById('desk');
    const img = mode === 'image' ? Z.wallImg() : '';
    if (!Z.WALLS.includes(mode) || (mode === 'image' && !img)) mode = 'gradient';
    desk.dataset.wp = mode;
    desk.style.setProperty('--dim', S.wpDim == null ? 30 : S.wpDim);
    if (img) desk.style.setProperty('--wp-img', `url("${img}")`); else desk.style.removeProperty('--wp-img');
    const v = desk.querySelector('video');
    if (mode === 'video' && !v) desk.prepend(Z.h('<video src="assets/loop.mp4" autoplay muted loop playsinline aria-hidden="true"></video>'));
    if (mode !== 'video' && v) v.remove();
  };
  /* a picked photo is downscaled to the screen and re-encoded so it fits in local storage */
  Z.wallFromFile = (file) => new Promise((res, rej) => {
    if (!file || !/^image\//.test(file.type)) return rej(new Error('type'));
    const url = URL.createObjectURL(file), im = new Image();
    im.onload = () => {
      const max = Math.min(2560, Math.max(screen.width, screen.height) * Math.min(2, devicePixelRatio || 1));
      const k = Math.min(1, max / Math.max(im.naturalWidth, im.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(im.naturalWidth * k)); c.height = Math.max(1, Math.round(im.naturalHeight * k));
      c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      let q = 0.86, data = c.toDataURL('image/jpeg', q);
      while (data.length > 1.6e6 && q > 0.5) { q -= 0.12; data = c.toDataURL('image/jpeg', q); }
      Z.memWall = data;
      let saved = true;
      try { localStorage.setItem('zos_wall_img_v1', JSON.stringify(data)); } catch (e) { saved = false; }
      res({ data, saved });
    };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('decode')); };
    im.src = url;
  });

  /* ---------- appearance: dark, light or follow the system, plus an accent colour ---------- */
  const ACCENTS = (Z.ACCENTS = { ember: ['#c4532a', '#a3401c', '#f2b48a'], rose: ['#c2416b', '#9e2c53', '#f4a7c0'], violet: ['#6b4fd6', '#5236b8', '#c3b4ff'], ocean: ['#2f7fa8', '#1f6288', '#9fd3ef'], forest: ['#3e8a5c', '#2b6a44', '#a8dcb9'], amber: ['#b8862b', '#8f6719', '#f2d08a'] });
  const lightMq = matchMedia('(prefers-color-scheme: light)');
  Z.theme = () => (S.theme === 'light' || (S.theme === 'auto' && lightMq.matches) ? 'light' : 'dark');
  Z.look = () => {
    const r = document.documentElement, a = ACCENTS[S.accent] || ACCENTS.ember;
    r.dataset.zt = Z.theme();
    r.style.setProperty('--accent', a[0]); r.style.setProperty('--accent-ink', a[1]); r.style.setProperty('--accent-hi', a[2]);
    let m = document.querySelector('meta[name="theme-color"]');
    if (!m) { m = document.createElement('meta'); m.name = 'theme-color'; document.head.append(m); }
    m.content = Z.theme() === 'light' ? '#f6ebe1' : '#120f0d';
  };
  lightMq.addEventListener('change', () => { if (S.theme === 'auto') Z.look(); });
  /* change the look with a circular reveal from the control that was pressed (View Transitions, when available) */
  Z.setLook = (patch, at) => {
    let done = false;
    const go = () => { if (done) return; done = true; Z.set(patch); Z.look(); FX.bg(S.bg); };
    if (reduced || !document.startViewTransition || document.visibilityState !== 'visible') return go();
    const vt = document.startViewTransition(go);
    /* a tab that is not painting never runs the transition callback: apply the change anyway */
    setTimeout(go, 400);
    const p = at || { x: innerWidth / 2, y: innerHeight / 2 };
    vt.ready.then(() => {
      const rad = Math.hypot(Math.max(p.x, innerWidth - p.x), Math.max(p.y, innerHeight - p.y));
      document.documentElement.animate({ clipPath: [`circle(0px at ${p.x}px ${p.y}px)`, `circle(${rad}px at ${p.x}px ${p.y}px)`] }, { duration: 620, easing: EASE.out, pseudoElement: '::view-transition-new(root)' });
    }).catch(() => {});
  };
  Z.centerOf = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; };
  Z.look();
})();
