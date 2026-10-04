/* Zuey OS demo shell: menubar, desktop icons, dock, spotlight, keyboard shortcuts, weather, notices, reviewer panel, mobile home and boot. */
(() => {
  'use strict';
  const { D, S, W, M, FX, L, esc, ic, fmt } = Z;
  const $ = (s) => document.querySelector(s);
  const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
  const zmHidden = () => document.body.classList.contains('zm-hidden');

  /* apps reachable with Alt 1…9 and Alt 0, in this order */
  const APP_KEYS = ['about', 'ai', 'knowledges', 'reads', 'launchpad', 'workflows', 'business', 'pricing', 'mcp', 'github'];
  const appKey = (id) => { const i = APP_KEYS.indexOf(id); return i < 0 ? '' : `Alt ${(i + 1) % 10}`; };
  const appName = (id) => ({ about: L('Giới thiệu', 'About'), ai: 'Zuey AI', knowledges: L('Bài viết', 'Articles'), reads: 'Zuey Reads', launchpad: 'Launchpad', workflows: 'AI Workflows', business: L('Doanh nghiệp', 'Business'), pricing: L('Gói thành viên', 'Membership'), mcp: 'MCP', github: 'GitHub', login: L('Đăng nhập', 'Sign in'), account: L('Tài khoản', 'Account'), appearance: L('Giao diện', 'Appearance') })[id] || id;
  const withKey = (label, k) => (k ? `${label} (${Z.keyText(k)})` : label);

  const toggleTheme = (at) => Z.setLook({ theme: Z.theme() === 'light' ? 'dark' : 'light' }, at);
  const themeLabel = () => (Z.theme() === 'light' ? L('Chuyển sang tối', 'Switch to dark') : L('Chuyển sang sáng', 'Switch to light'));
  const expo = () => { if (!W.expo()) Z.toast(W.mobile() ? L('Exposé có trên màn hình rộng.', 'Exposé works on wider screens.') : L('Chưa có cửa sổ nào đang mở.', 'No windows open.')); };

  /* ---------- weather state (live key) + the demo condition the reviewer picks ---------- */
  let wx = Z.lsGet('zuey_weather_v1', { mode: 'off' });
  let cond = Z.lsGet('zos_wx_cond_v1', 'clear');
  let wxStatus = '';
  const wxOn = () => wx.mode !== 'off';
  const place = () => (wx.mode === 'geo' ? L('gần bạn', 'near you') : wx.city || 'Sài Gòn');
  const applyWx = (announce) => {
    FX.set(wxOn() ? cond : null);
    if (announce && wxOn()) { const c = FX.COND[cond]; if (c.mood) M.react(c.mood); M.say(M.COPY.wx[cond][S.lang === 'vi' ? 0 : 1]); }
    renderBar();
  };

  /* ---------- notices from Duy ---------- */
  const notices = () => Z.lsGet('zos_notices_v1', []);
  const dismissed = () => Z.lsGet('zuey_notices_dismissed_v1', []);
  const activeNotices = () => notices().filter((n) => n.until > Date.now() && !dismissed().includes(n.id));
  const dismissNotice = (id) => { Z.lsSet('zuey_notices_dismissed_v1', [...dismissed(), id]); renderBar(); };
  const showNotice = (n) => M.say(n.text, { duy: true, until: n.until, onDismiss: () => dismissNotice(n.id) });

  /* ---------- menubar: nav links fold into "Go to" below 1280px, labels and clock drop out as space shrinks ---------- */
  const NAV = () => [['knowledges', L('Bài viết', 'Articles')], ['reads', 'Reads'], ['workflows', 'Workflows'], ['business', L('Doanh nghiệp', 'Business')], ['pricing', L('Gói & giá', 'Plans')], ['mcp', 'MCP']];
  const LANGS = [['vi', 'Tiếng Việt'], ['en', 'English'], ['zh', '中文'], ['ko', '한국어'], ['ja', '日本語']];
  const renderBar = () => {
    const c = FX.COND[cond], hasN = activeNotices().length;
    const offline = S.aiMode === 'unconfigured';
    $('#menubar').innerHTML = `
      <button class="mb-btn mb-brand" data-m="brand" aria-haspopup="menu" aria-expanded="false"><i>/z</i> Zuey</button>
      <button class="mb-btn review-pill" data-m="review" aria-expanded="${!!review}" title="${withKey(L('Chỉ có trong demo', 'Demo only'), 'Alt R')}">${ic('sliders')}<span class="mb-label mb-hide-m mb-l">${L('Trạng thái demo', 'Demo states')}</span></button>
      <nav class="mb-nav mb-hide-m" aria-label="${L('Điều hướng', 'Navigation')}">${NAV().map(([id, t]) => `<button class="mb-btn" data-open="${id}" title="${withKey(t, appKey(id))}">${t}</button>`).join('')}</nav>
      <button class="mb-btn mb-go mb-hide-m" data-m="go" aria-haspopup="menu" aria-expanded="false">${ic('compass')}<span>${L('Đi tới', 'Go to')}</span>${ic('down', 'chev')}</button>
      <span class="mb-sp"></span>
      <button class="mb-btn" data-m="cmd" aria-label="${L('Lệnh', 'Commands')} (${Z.keyText('Mod K')})" title="${withKey(L('Bảng lệnh', 'Command palette'), 'Mod K')}">${ic('search')}<span class="mb-label mb-hide-m mb-l">${L('Lệnh', 'Commands')}</span><span class="mb-hide-m mb-k">${Z.kbd('Mod K')}</span></button>
      <button class="mb-btn mb-hide-m" data-m="keys" aria-label="${L('Phím tắt', 'Keyboard shortcuts')} (?)" title="${L('Phím tắt', 'Keyboard shortcuts')} (?)">${ic('kbd')}</button>
      <button class="mb-btn" data-m="wx" aria-haspopup="dialog" aria-expanded="false" aria-label="${L('Thời tiết', 'Weather')}">${ic(wxOn() ? c.icon : 'cloud')}<span class="mb-label mb-wx">${wxOn() ? `${c.temp}° ${esc(place())}` : L('Thời tiết', 'Weather')}</span></button>
      <button class="mb-btn" data-m="lang" aria-haspopup="menu" aria-expanded="false" aria-label="${L('Ngôn ngữ', 'Language')}" title="${withKey(L('Ngôn ngữ', 'Language'), 'Alt L')}">${ic('globe')}<span class="mb-label">${S.lang.toUpperCase()}</span></button>
      <button class="mb-btn" data-m="bell" aria-haspopup="dialog" aria-expanded="false" aria-label="${hasN ? L('1 thông báo từ Duy', '1 notice from Duy') : L('Thông báo', 'Notices')}">${ic('bell')}${hasN ? '<span class="badge-dot"></span>' : ''}</button>
      <button class="mb-btn mb-hide-m" data-m="zm" title="${withKey(zmHidden() ? L('Hiện Zuey', 'Show Zuey') : L('Ẩn Zuey', 'Hide Zuey'), 'Alt Z')}" aria-label="${zmHidden() ? L('Hiện Zuey', 'Show Zuey') : L('Ẩn Zuey', 'Hide Zuey')}">${ic(zmHidden() ? 'eye' : 'eyeoff')}<span class="mb-l">${zmHidden() ? L('Hiện Zuey', 'Show Zuey') : L('Ẩn Zuey', 'Hide Zuey')}</span></button>
      <span class="mb-btn mb-hide-m mb-status" role="status" title="${offline ? L('Zuey tạm nghỉ', 'Zuey resting') : 'Zuey online'}"><span class="st-dot${offline ? ' off' : ''}"></span><span class="mb-l">${offline ? L('Zuey tạm nghỉ', 'Zuey resting') : 'Zuey online'}</span></span>
      <span class="mb-clock" data-clock title="${L('Giờ Sài Gòn', 'Saigon time')}"></span>
      <button class="mb-btn mb-acct" data-m="acct" aria-haspopup="menu" aria-expanded="false">${Z.signedIn() ? `<span class="av">${esc((S.email || 'b')[0].toUpperCase())}</span><span class="mb-label">${Z.isAdmin() ? 'Admin' : esc(Z.planName())}</span>` : `${ic('user')}<span class="mb-label">${L('Đăng nhập', 'Sign in')}</span>`}</button>`;
    tickClock(); fitBar();
  };
  /* fold the menubar step by step (nav → labels → clock → weather text) until it fits, whatever the language */
  const fitBar = () => {
    const mb = $('#menubar'), steps = ['c1', 'c2', 'c3', 'c4'];
    mb.classList.remove(...steps);
    for (const c of steps) { if (mb.scrollWidth <= mb.clientWidth + 1) break; mb.classList.add(c); }
  };
  addEventListener('resize', () => requestAnimationFrame(fitBar));
  if (document.fonts) document.fonts.ready.then(() => { fitBar(); renderDock(true); });
  const tickClock = () => {
    const el = $('[data-clock]');
    if (el) el.textContent = new Date().toLocaleString(S.lang === 'vi' ? 'vi-VN' : 'en-GB', { timeZone: Z.TZ, weekday: 'short', hour: '2-digit', minute: '2-digit' });
  };
  setInterval(tickClock, 20000);

  const brandMenu = (a) => Z.menu(a, [
    { label: L('Giới thiệu Zuey', 'About Zuey'), icon: 'user', kbd: 'Alt 1', on: () => W.open('about') },
    { label: 'Launchpad', icon: 'grid', kbd: 'Alt 5', on: () => W.open('launchpad') },
    { label: L('Zuey đang làm gì', 'What Zuey is doing'), icon: 'gh', kbd: 'Alt 0', on: () => W.open('github') },
    { sep: true },
    { label: L('Tất cả cửa sổ', 'All windows'), icon: 'expo', kbd: 'Alt O', on: expo },
    { label: L('Sắp xếp cửa sổ', 'Arrange windows'), icon: 'layout', kbd: 'Alt A', on: W.arrange },
    { label: L('Thu nhỏ tất cả', 'Minimize all'), icon: 'minus', kbd: 'Alt Shift M', on: W.minimizeAll },
    { label: L('Đóng tất cả', 'Close all'), icon: 'x', on: W.closeAll },
    { label: zmHidden() ? L('Hiện Zuey', 'Show Zuey') : L('Ẩn Zuey', 'Hide Zuey'), icon: 'eyeoff', kbd: 'Alt Z', on: () => M.setHidden(!zmHidden()) },
    { sep: true },
    { label: L('Giao diện & hình nền…', 'Appearance & wallpaper…'), icon: 'palette', on: () => W.open('appearance') },
    { label: themeLabel(), icon: Z.theme() === 'light' ? 'moon' : 'sun', kbd: 'Alt T', on: () => toggleTheme() },
    { label: L('Phím tắt', 'Keyboard shortcuts'), icon: 'kbd', kbd: '?', on: keysSheet },
    { label: L('Trạng thái demo', 'Demo states'), icon: 'sliders', kbd: 'Alt R', on: toggleReview },
  ]);
  const goMenu = (a) => Z.menu(a, NAV().map(([id, t]) => ({ label: t, icon: { knowledges: 'doc', reads: 'book', workflows: 'flow', business: 'brief', pricing: 'card', mcp: 'plug' }[id], kbd: appKey(id), on: () => W.open(id) })));
  const langMenu = (a) => Z.menu(a, LANGS.map(([id, n]) => ({ label: n, checked: S.lang === id, on: () => {
    if (id === 'vi' || id === 'en') Z.set({ lang: id });
    else { Z.set({ lang: 'en' }); Z.toast(L('Demo dựng VI và EN. 中文 / 한국어 / 日本語 dùng cùng bố cục với bản dịch có sẵn khi triển khai.', 'The demo ships VI and EN. 中文 / 한국어 / 日本語 reuse this layout with the existing translations.'), 4500); }
  } })), { alignRight: true });
  const acctMenu = (a) => {
    if (!Z.signedIn()) return W.open('login');
    Z.menu(a, [
      { header: S.email || 'ban@example.com' },
      { label: L('Tài khoản', 'Account'), icon: 'user', on: () => W.open('account') },
      { label: L('Gói & giá', 'Plans'), icon: 'card', kbd: 'Alt 8', on: () => W.open('pricing') },
      { label: L('Khoá API', 'API keys'), icon: 'key', on: () => W.open('account', { tab: 'keys' }) },
      ...(Z.isAdmin() ? [{ label: 'Studio', icon: 'layout', href: 'https://zuey.me/studio' }] : []),
      { sep: true },
      { label: L('Đăng xuất', 'Sign out'), icon: 'logout', on: () => { Z.set({ role: 'guest', plan: 'none' }); Z.toast(L('Đã đăng xuất.', 'Signed out.')); } },
    ], { alignRight: true });
  };
  const bellPop = (a) => {
    const list = activeNotices();
    const el = Z.popover(a, `<div class="pop-body"><b>${L('Thông báo từ Duy', 'Notices from Duy')}</b>${list.length ? list.map((n) => `<div class="note"><div>${esc(n.text)}</div><div class="row small" style="justify-content:space-between;margin-top:6px"><span class="muted">${fmt(L('Đến {time}', 'Until {time}'), { time: Z.time(n.until) })}</span><button class="btn sm ghost" data-dis="${n.id}">${L('Bỏ qua', 'Dismiss')}</button></div></div>`).join('') : `<p>${L('Chưa có thông báo nào từ Duy.', 'No notices from Duy.')}</p><p class="small">${L('Khi Duy đăng thông báo (livestream, ưu đãi…), Zuey sẽ mang tới bằng bong bóng chat.', 'When Duy posts a notice (livestream, offer…), Zuey brings it in a bubble.')}</p>`}</div>`, { alignRight: true, label: L('Thông báo', 'Notices') });
    if (el) el.onclick = (e) => { const b = e.target.closest('[data-dis]'); if (b) { dismissNotice(b.dataset.dis); M.hush(); Z.closePop(); } };
  };
  const wxPop = (a) => {
    const box = document.createElement('div');
    box.className = 'pop-body wxp';
    const fill = () => {
      const c = FX.COND[cond];
      box.innerHTML = `<b>${L('Thời tiết', 'Weather')}</b>
        <p>${L('Nền trang và Zuey có thể phản ứng theo thời tiết nơi bạn ở. Không có yêu cầu nào được gửi cho tới khi bạn chọn.', 'The wallpaper and Zuey can follow your local weather. Nothing is requested until you choose.')}</p>
        <form class="row grow" data-city><label class="sr" for="wx-city">${L('Thành phố', 'City')}</label><input id="wx-city" class="input" placeholder="${L('ví dụ: Hà Nội', 'e.g. Hanoi')}" value="${esc(wx.city || '')}"><button class="btn sm">${L('Dùng thành phố', 'Use city')}</button></form>
        <div class="row"><button class="btn sm ghost" data-geo>${ic('globe')} ${L('Dùng vị trí gần đúng', 'Use approximate location')}</button>${wxOn() ? `<button class="btn sm ghost" data-off>${L('Tắt', 'Off')}</button>` : ''}</div>
        <p class="small">${L('Toạ độ được làm tròn ~11 km và chỉ lưu trên thiết bị này.', 'Coordinates are rounded to ~11 km and stay on this device.')}</p>
        ${wxStatus ? `<p class="small" role="status" style="color:var(--accent-2)">${esc(wxStatus)}</p>` : wxOn() ? `<p role="status" style="color:var(--ink-inv)">${ic(c.icon)} ${fmt(L('{condition}, {temp}°C · {place}', '{condition}, {temp}°C · {place}'), { condition: c[S.lang === 'vi' ? 'vi' : 'en'], temp: c.temp, place: esc(place()) })}</p>` : ''}
        <div class="demo-box">
          <span class="small demo-l">${L('Demo: chọn trời (artifact không gọi được Open-Meteo)', 'Demo: pick the sky (the artifact cannot call Open-Meteo)')}</span>
          <div class="row">${Object.entries(FX.COND).map(([k, v]) => `<button class="chip" data-cond="${k}" aria-pressed="${wxOn() && cond === k}">${ic(v.icon)} ${v[S.lang === 'vi' ? 'vi' : 'en']}</button>`).join('')}</div>
</div>
        <button class="btn sm ghost" data-look>${ic('palette')} ${L('Giao diện & hình nền…', 'Appearance & wallpaper…')}</button>
        <p class="small">${L('Dữ liệu thời tiết từ Open-Meteo.com', 'Weather data from Open-Meteo.com')}</p>`;
    };
    fill();
    const el = Z.popover(a, box, { alignRight: true, label: L('Thời tiết & nền', 'Weather & wallpaper'), noFocus: true });
    if (!el) return;
    const save = () => { Z.lsSet('zuey_weather_v1', wx); Z.lsSet('zos_wx_cond_v1', cond); };
    box.addEventListener('submit', (e) => {
      e.preventDefault();
      const city = box.querySelector('#wx-city').value.trim();
      if (!city) { wxStatus = L('Không tìm thấy thành phố.', 'City not found.'); return fill(); }
      wxStatus = L('Đang xem trời…', 'Checking the sky…'); fill();
      setTimeout(() => { wx = { mode: 'city', city }; wxStatus = ''; save(); applyWx(true); fill(); }, 700);
    });
    box.addEventListener('click', (e) => {
      const t = e.target.closest('button'); if (!t || t.closest('form')) return;
      const d = t.dataset;
      if (d.cond) { cond = d.cond; if (!wxOn()) wx = { mode: 'city', city: 'Sài Gòn' }; save(); applyWx(true); }
      if ('off' in d) { wx = { mode: 'off' }; save(); applyWx(false); }
      if ('look' in d) { Z.closePop(); W.open('appearance'); return; }
      if ('geo' in d) {
        if (!navigator.geolocation) { wxStatus = L('Trình duyệt không hỗ trợ định vị.', 'Location is not supported.'); return fill(); }
        wxStatus = L('Đang xem trời…', 'Checking the sky…'); fill();
        navigator.geolocation.getCurrentPosition((p) => {
          wx = { mode: 'geo', lat: Math.round(p.coords.latitude * 10) / 10, lon: Math.round(p.coords.longitude * 10) / 10 }; wxStatus = ''; save(); applyWx(true); fill();
        }, () => { wxStatus = L('Không lấy được vị trí (bị từ chối hoặc bị khung artifact chặn). Hãy nhập thành phố.', 'Location unavailable (denied or blocked by this frame). Enter a city instead.'); fill(); }, { timeout: 6000, maximumAge: 6e5 });
      }
      fill();
    });
  };
  $('#menubar').addEventListener('click', (e) => {
    const t = e.target.closest('button'); if (!t) return;
    if (t.dataset.open) return W.open(t.dataset.open);
    const m = t.dataset.m;
    if (m === 'brand') brandMenu(t);
    else if (m === 'go') goMenu(t);
    else if (m === 'cmd') openSpot();
    else if (m === 'keys') keysSheet();
    else if (m === 'wx') wxPop(t);
    else if (m === 'lang') langMenu(t);
    else if (m === 'bell') bellPop(t);
    else if (m === 'acct') acctMenu(t);
    else if (m === 'review') toggleReview();
    else if (m === 'zm') M.setHidden(!zmHidden());
  });

  /* ---------- desktop icons ---------- */
  const ICONS = () => [['knowledges', L('Bài viết', 'Articles'), 'knowledges/'], ['reads', 'Zuey Reads', '8 items'], ['workflows', 'AI Workflows', ''], ['business', L('Doanh nghiệp', 'Business'), '$1,999'], ['pricing', L('Gói thành viên', 'Membership'), 'from $9'], ['mcp', 'MCP', ''], ['github', 'GitHub', '@mrgoonie']];
  const renderIcons = () => {
    $('#icons').innerHTML = ICONS().map(([id, t, s], i) => `<button class="icon" data-open="${id}" style="--i:${i}" title="${withKey(t, appKey(id))}">${W.apps[id].icon()}<span>${t}</span>${s ? `<small>${s}</small>` : ''}</button>`).join('');
  };
  $('#icons').addEventListener('click', (e) => { const t = e.target.closest('[data-open]'); if (t) W.open(t.dataset.open); });

  const deskHit = (t) => !W.mobile() && !W.inExpo() && (t.closest('#desk') || t.id === 'icons' || t.id === 'screen');
  document.addEventListener('contextmenu', (e) => {
    if (!deskHit(e.target)) return;
    e.preventDefault();
    const at = { x: e.clientX, y: e.clientY };
    Z.menu(null, [
      { label: L('Đổi hình nền…', 'Change wallpaper…'), icon: 'image', on: () => W.open('appearance') },
      { label: themeLabel(), icon: Z.theme() === 'light' ? 'moon' : 'sun', kbd: 'Alt T', on: () => toggleTheme(at) },
      { sep: true },
      { label: L('Tất cả cửa sổ', 'All windows'), icon: 'expo', kbd: 'Alt O', on: expo },
      { label: L('Sắp xếp cửa sổ', 'Arrange windows'), icon: 'layout', kbd: 'Alt A', on: W.arrange },
      { label: 'Launchpad', icon: 'grid', kbd: 'Alt 5', on: () => W.open('launchpad') },
    ], { at });
  });
  {
    let drop = null, depth = 0;
    const hasImg = (e) => [...(e.dataTransfer ? e.dataTransfer.items || [] : [])].some((i) => i.kind === 'file' && /^image\//.test(i.type));
    const hide = () => { depth = 0; if (drop) { Z.leave(drop, [{ opacity: 1 }, { opacity: 0 }], 160); drop = null; } };
    document.addEventListener('dragenter', (e) => {
      if (!hasImg(e)) return;
      depth++;
      if (!drop) { drop = Z.h(`<div class="drop-wp" aria-hidden="true"><div>${ic('image')}<b>${L('Thả ảnh để làm hình nền', 'Drop to set as wallpaper')}</b><span>${L('Ảnh chỉ lưu trên trình duyệt này', 'Kept in this browser only')}</span></div></div>`); document.body.append(drop); }
    });
    document.addEventListener('dragover', (e) => { if (hasImg(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    document.addEventListener('dragleave', () => { if (drop && --depth <= 0) hide(); });
    document.addEventListener('drop', (e) => {
      const f = e.dataTransfer && [...e.dataTransfer.files].find((x) => /^image\//.test(x.type));
      if (!f) return;
      e.preventDefault(); hide();
      Z.useWallFile(f, { x: e.clientX, y: e.clientY });
    });
  }

  /* ---------- dock: apps, minimized windows, then real product and company logos; folds into stacks when narrow ---------- */
  const DOCK_APPS = ['about', 'ai', 'knowledges', 'reads', 'launchpad'];
  const PRODUCTS = () => D.links['Products & AI Engineering Tools'], COMPANIES = () => D.links['Companies & Organizations'];
  const short = (t) => Z.cleanTitle(t).replace(/\s*\(.*?\)/, '').replace(/\s+[—–]\s+.*$/, '');
  const dockApp = (id) => `<button class="di app" data-app="${id}" aria-label="${esc(appName(id))}">${W.apps[id].icon()}<span class="tip">${esc(appName(id))}${appKey(id) ? Z.kbd(appKey(id)) : ''}</span></button>`;
  const dockLink = (l, i, grp) => `<a class="di lnk" href="${esc(l.url)}" target="_blank" rel="noopener" data-li="${grp}:${i}" aria-label="${esc(short(l.title))}">${Z.tile(l, 't')}<span class="tip">${esc(short(l.title))}</span></a>`;
  const dockStack = (grp, list, name) => `<button class="di stack" data-stack="${grp}" aria-haspopup="dialog" aria-expanded="false" aria-label="${esc(name)} · ${list.length}"><span class="sg">${list.slice(0, 4).map((l) => Z.tile(l, 't')).join('')}</span><span class="tip">${esc(name)} · ${list.length}</span></button>`;
  const linkOf = (el) => { const [g, i] = el.dataset.li.split(':'); return (g === 'p' ? PRODUCTS() : COMPANIES())[+i]; };
  let dockLevel = 0, dockSig = '';
  const markRunning = () => $('#dock').querySelectorAll('[data-app]').forEach((b) => {
    const w = W.wins[b.dataset.app];
    b.classList.toggle('run', !!w); b.classList.toggle('min', !!(w && w.min));
  });
  const renderDock = (force) => {
    const dk = $('#dock');
    const minimized = Object.values(W.wins).filter((w) => w.min && !DOCK_APPS.includes(w.id)).map((w) => w.id);
    const sig = [S.lang, dockLevel, minimized.join(',')].join('|');
    if (force !== true && sig === dockSig) return markRunning();
    dockSig = sig;
    const P = PRODUCTS(), C = COMPANIES(), sep = '<span class="sep" aria-hidden="true"></span>';
    dk.innerHTML = DOCK_APPS.map(dockApp).join('') + `<button class="di expo-di" data-expo aria-pressed="${W.inExpo()}" aria-label="${L('Tất cả cửa sổ', 'All windows')}"><span class="g expo">${ic('expo')}</span><span class="tip">${L('Tất cả cửa sổ', 'All windows')}${Z.kbd('Alt O')}</span></button>` + (minimized.length ? sep + minimized.map(dockApp).join('') : '')
      + sep + (dockLevel >= 2 ? dockStack('p', P, L('Sản phẩm', 'Products')) : P.map((l, i) => dockLink(l, i, 'p')).join(''))
      + sep + (dockLevel >= 1 ? dockStack('c', C, L('Công ty', 'Companies')) : C.map((l, i) => dockLink(l, i, 'c')).join(''));
    markRunning();
    if (!W.mobile() && dockLevel < 2 && dk.offsetWidth > innerWidth - 24) { dockLevel++; renderDock(true); }
  };
  const stackPop = (a) => {
    const list = a.dataset.stack === 'p' ? PRODUCTS() : COMPANIES();
    const box = Z.h(`<div class="stack-box"><div class="ph">${a.dataset.stack === 'p' ? L('Sản phẩm & công cụ AI', 'Products & AI tools') : L('Sáng lập & điều hành', 'Founded & run')}</div>
      <div class="sgrid">${list.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener" class="mi">${Z.tile(l, 't')}<span>${esc(short(l.title))}</span></a>`).join('')}</div>
      <button class="mi all" data-lp>${ic('grid')}<span>${L('Mở Launchpad', 'Open Launchpad')}</span>${Z.kbd('Alt 5')}</button></div>`);
    box.querySelector('[data-lp]').onclick = () => { Z.closePop(); W.open('launchpad'); };
    box.addEventListener('click', (e) => { if (e.target.closest('a')) Z.closePop(); });
    Z.popover(a, box, { cls: 'stack-pop', label: a.getAttribute('aria-label') });
  };
  {
    const dk = $('#dock');
    dk.addEventListener('click', (e) => {
      const s = e.target.closest('[data-stack]'); if (s) return stackPop(s);
      if (e.target.closest('[data-expo]')) return expo();
      const t = e.target.closest('[data-app]'); if (!t) return;
      const id = t.dataset.app, w = W.wins[id];
      if (w && !w.min && W.top === id) return W.minimize(id);
      if (!w && !Z.reduced) { t.classList.remove('bounce'); void t.offsetWidth; t.classList.add('bounce'); setTimeout(() => t.classList.remove('bounce'), 1000); }
      W.open(id);
    });
    dk.addEventListener('contextmenu', (e) => {
      const li = e.target.closest('[data-li]'), ap = e.target.closest('[data-app]');
      if (li) { e.preventDefault(); return Z.linkMenu(li, linkOf(li)); }
      if (ap && W.wins[ap.dataset.app]) { e.preventDefault(); W.focus(ap.dataset.app); W.menuFor(ap.dataset.app, { x: e.clientX, y: e.clientY }); }
    });
    dk.addEventListener('keydown', (e) => {
      const t = e.target.closest('.di'); if (!t) return;
      if (t.dataset.li && (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10'))) { e.preventDefault(); return Z.linkMenu(t, linkOf(t)); }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const all = [...dk.querySelectorAll('.di')], i = all.indexOf(t);
        e.preventDefault(); all[(i + (e.key === 'ArrowRight' ? 1 : -1) + all.length) % all.length].focus();
      }
    });
    /* magnification: each icon grows with pointer proximity (mouse only, never under reduced motion) */
    /* growth shrinks when the dock already spans most of the screen, so magnified icons never leave it */
    const RANGE = 150;
    let GROW = 0.55;
    dk.addEventListener('pointerenter', () => {
      const icon = dk.querySelector('.di'), room = innerWidth - 16 - dk.offsetWidth;
      GROW = icon ? Math.max(0.12, Math.min(0.55, room / (icon.offsetWidth * 3.4))) : 0.55;
    });
    dk.addEventListener('pointermove', (e) => {
      if (Z.reduced || e.pointerType !== 'mouse' || W.mobile()) return;
      dk.classList.add('fish');
      dk.querySelectorAll('.di').forEach((el) => {
        const r = el.getBoundingClientRect(), t = Math.max(0, 1 - Math.abs(e.clientX - (r.left + r.width / 2)) / RANGE);
        el.style.setProperty('--s', (1 + GROW * t * t * (3 - 2 * t)).toFixed(3));
      });
    });
    dk.addEventListener('pointerleave', () => { dk.classList.remove('fish'); dk.querySelectorAll('.di').forEach((el) => el.style.removeProperty('--s')); });
    let rz = 0;
    addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { dockLevel = 0; renderDock(true); }, 120); });
  }

  /* ---------- keyboard shortcuts: one table drives the handler hints, the cheat sheet and menus ---------- */
  const SHORTCUTS = () => [
    [L('Chung', 'General'), [
      ['Mod K', L('Bảng lệnh', 'Command palette')],
      ['/', L('Tìm nhanh', 'Quick search')],
      ['?', L('Bảng phím tắt này', 'This shortcut sheet')],
      ['Esc', L('Đóng menu, hộp thoại hoặc bảng lệnh', 'Close a menu, dialog or the palette')],
    ]],
    [L('Mở ứng dụng', 'Open apps'), APP_KEYS.map((id) => [appKey(id), appName(id)])],
    [L('Cửa sổ', 'Windows'), [
      ['Alt W', L('Đóng cửa sổ đang chọn', 'Close focused window')],
      ['Alt M', L('Thu nhỏ xuống Dock', 'Minimize to Dock')],
      ['Alt Shift M', L('Thu nhỏ tất cả', 'Minimize all')],
      ['Alt ↑', L('Phóng to / thu về', 'Zoom / restore')],
      ['Alt ↓', L('Thu về, rồi thu nhỏ', 'Restore, then minimize')],
      ['Alt ←', L('Chia đôi bên trái', 'Snap left')],
      ['Alt →', L('Chia đôi bên phải', 'Snap right')],
      ['Alt `', L('Cửa sổ kế tiếp', 'Next window')],
      ['Alt Shift `', L('Cửa sổ trước', 'Previous window')],
      ['Alt A', L('Sắp xếp lại cửa sổ', 'Arrange windows')],
      ['Alt O', L('Tất cả cửa sổ (Exposé)', 'All windows (Exposé)')],
    ]],
    ['Zuey', [
      ['Alt N', L('Cuộc trò chuyện AI mới', 'New AI chat')],
      ['Alt Z', L('Ẩn / hiện bạn đồng hành', 'Hide / show companion')],
      ['Alt L', L('Đổi Tiếng Việt / English', 'Switch Vietnamese / English')],
      ['Alt T', L('Đổi giao diện sáng / tối', 'Toggle light / dark')],
      ['Alt R', L('Bảng trạng thái demo', 'Demo states panel')],
    ]],
  ];
  function keysSheet() {
    if (document.querySelector('dialog.keys-dlg')) return;
    const d = Z.dialog({
      title: L('Phím tắt', 'Keyboard shortcuts'),
      body: `<div class="keys">${SHORTCUTS().map(([g, rows]) => `<section><h3>${esc(g)}</h3><dl>${rows.map(([k, t]) => `<div><dt>${esc(t)}</dt><dd>${Z.kbd(k)}</dd></div>`).join('')}</dl></section>`).join('')}</div>
        <p class="small" style="color:var(--muted)">${Z.isMac ? L('Alt là phím ⌥ Option. ', 'Alt is the ⌥ Option key. ') : ''}${L('Phím tắt cửa sổ tác động lên cửa sổ đang chọn. Kéo thanh tiêu đề ra mép trái, phải hoặc lên đỉnh màn hình để chia đôi hay phóng to; kéo mọi cạnh và góc để đổi kích thước.', 'Window shortcuts act on the focused window. Drag a title bar to the left, right or top edge to snap or zoom; drag any edge or corner to resize.')}</p>`,
    });
    d.classList.add('keys-dlg');
  }
  /* brief on-screen echo of the shortcut just used */
  let hudEl = null, hudT = 0;
  const hud = (keys, label) => {
    if (W.mobile()) return;
    if (!hudEl) { hudEl = Z.h('<div class="hud" role="status" aria-live="polite"></div>'); document.body.append(hudEl); }
    hudEl.innerHTML = `${Z.kbd(keys)}<span>${esc(label)}</span>`;
    hudEl.classList.remove('on'); void hudEl.offsetWidth; hudEl.classList.add('on');
    clearTimeout(hudT); hudT = setTimeout(() => hudEl.classList.remove('on'), 1200);
  };
  const focused = () => (W.top && W.wins[W.top] && !W.wins[W.top].min ? W.top : null);
  const onWin = (keys, label, fn) => () => { const id = focused(); if (!id) return hud(keys, L('Chưa có cửa sổ nào', 'No window open')); const t = typeof label === 'function' ? label(id) : label; fn(id); hud(keys, t); };
  const altAction = (e) => {
    const sh = e.shiftKey, dg = /^Digit(\d)$/.exec(e.code);
    if (dg && !sh) { const id = APP_KEYS[(+dg[1] + 9) % 10]; return () => { W.open(id); hud(`Alt ${dg[1]}`, appName(id)); }; }
    const map = {
      KeyW: !sh && onWin('Alt W', L('Đóng cửa sổ', 'Close window'), W.close),
      KeyM: sh ? () => { W.minimizeAll(); hud('Alt Shift M', L('Thu nhỏ tất cả', 'Minimize all')); } : onWin('Alt M', L('Thu nhỏ', 'Minimize'), W.minimize),
      ArrowUp: !sh && onWin('Alt ↑', (id) => (W.wins[id].mode === 'max' ? L('Thu về', 'Restore') : L('Phóng to', 'Zoom')), W.toggleMax),
      ArrowDown: !sh && onWin('Alt ↓', (id) => (W.wins[id].mode === 'normal' ? L('Thu nhỏ', 'Minimize') : L('Thu về', 'Restore')), W.restore),
      ArrowLeft: !sh && onWin('Alt ←', L('Chia đôi bên trái', 'Snap left'), (id) => W.snap(id, 'left')),
      ArrowRight: !sh && onWin('Alt →', L('Chia đôi bên phải', 'Snap right'), (id) => W.snap(id, 'right')),
      Backquote: () => { W.cycle(sh ? -1 : 1); hud(sh ? 'Alt Shift `' : 'Alt `', focused() ? appName(focused()) : L('Chưa có cửa sổ nào', 'No window open')); },
      KeyA: !sh && (() => { W.arrange(); hud('Alt A', L('Sắp xếp cửa sổ', 'Arrange windows')); }),
      KeyN: !sh && (() => { W.open('ai', { newChat: true }); hud('Alt N', L('Cuộc trò chuyện mới', 'New chat')); setTimeout(() => { const t = document.getElementById('ai-in'); if (t && !t.disabled) t.focus(); }, 80); }),
      KeyZ: !sh && (() => { M.setHidden(!zmHidden()); hud('Alt Z', zmHidden() ? L('Đã ẩn Zuey', 'Zuey hidden') : L('Zuey đã quay lại', 'Zuey is back')); }),
      KeyL: !sh && (() => { Z.set({ lang: S.lang === 'vi' ? 'en' : 'vi' }); hud('Alt L', S.lang === 'vi' ? 'Tiếng Việt' : 'English'); }),
      KeyR: !sh && (() => { toggleReview(); hud('Alt R', L('Trạng thái demo', 'Demo states')); }),
      KeyO: !sh && (() => { if (!W.expo()) hud('Alt O', L('Chưa có cửa sổ nào', 'No window open')); }),
      KeyT: !sh && (() => { toggleTheme(); hud('Alt T', Z.theme() === 'light' ? L('Giao diện sáng', 'Light mode') : L('Giao diện tối', 'Dark mode')); }),
      Slash: () => keysSheet(),
    };
    return map[e.code] || null;
  };
  const typing = (t) => !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyK') { e.preventDefault(); return openSpot(); }
    if (spot || document.querySelector('dialog[open]')) return;
    if (e.altKey && !mod) {
      const f = altAction(e); if (!f) return;
      e.preventDefault(); Z.closePop(); f(); return;
    }
    if (mod || e.altKey || typing(e.target)) return;
    if (e.key === '/') { e.preventDefault(); openSpot(); } else if (e.key === '?') { e.preventDefault(); keysSheet(); }
  });

  /* ---------- spotlight / command palette ---------- */
  const RECENT = 'zuey_commands_recent_v1';
  const A = (id, label, icon, run, hint, kbd) => ({ id, label, icon, run, hint, kbd });
  const ACTIONS = () => [
    A('ai', L('Chat với Zuey AI', 'Chat with Zuey AI'), 'spark', () => W.open('ai'), '', 'Alt 2'),
    A('search', L('Tìm bài viết', 'Search posts'), 'search', () => { W.open('knowledges'); setTimeout(() => { const q = document.getElementById('kn-q'); if (q) q.focus(); }, 60); }, '', 'Alt 3'),
    A('mcp', L('Kết nối qua MCP', 'Connect via MCP'), 'plug', () => W.open('mcp'), '', 'Alt 9'),
    A('pricing', L('Gói & giá', 'Plans & pricing'), 'card', () => W.open('pricing'), '', 'Alt 8'),
    ...(Z.signedIn() ? [] : [A('login', L('Đăng nhập & đăng ký', 'Sign in & sign up'), 'user', () => W.open('login'))]),
    A('account', L('Tài khoản', 'Account'), 'user', () => W.open('account')),
    A('github', L('Zuey đang làm gì (GitHub)', 'What Zuey is doing (GitHub)'), 'gh', () => W.open('github'), '', 'Alt 0'),
    A('docs', 'API docs', 'doc', () => Z.openUrl('https://zuey.me/docs'), '↗'),
    A('keys', 'API keys', 'key', () => (Z.signedIn() ? W.open('account', { tab: 'keys' }) : W.open('login', { next: 'account' }))),
    A('privacy', L('Chính sách quyền riêng tư', 'Privacy policy'), 'shield', () => Z.openUrl('https://zuey.me/privacy'), '↗'),
    A('business', L('Dành cho doanh nghiệp', 'For business'), 'brief', () => W.open('business'), '', 'Alt 7'),
    A('reads', 'Zuey Reads', 'book', () => W.open('reads'), '', 'Alt 4'),
    A('launchpad', 'Launchpad', 'grid', () => W.open('launchpad'), '', 'Alt 5'),
    A('shortcuts', L('Phím tắt', 'Keyboard shortcuts'), 'kbd', keysSheet, '', '?'),
    A('arrange', L('Sắp xếp cửa sổ', 'Arrange windows'), 'layout', W.arrange, '', 'Alt A'),
    A('minall', L('Thu nhỏ tất cả cửa sổ', 'Minimize all windows'), 'minus', W.minimizeAll, '', 'Alt Shift M'),
    A('expo', L('Tất cả cửa sổ (Exposé)', 'All windows (Exposé)'), 'expo', expo, '', 'Alt O'),
    A('appearance', L('Giao diện, màu nhấn & hình nền', 'Appearance, accent & wallpaper'), 'palette', () => W.open('appearance')),
    A('theme', themeLabel(), Z.theme() === 'light' ? 'moon' : 'sun', () => toggleTheme(), '', 'Alt T'),
  ];
  let spot = null;
  const openSpot = () => {
    if (spot) return closeSpot();
    Z.closePop();
    const prev = document.activeElement;
    spot = Z.h(`<div class="spot" role="dialog" aria-modal="true" aria-label="${L('Bảng lệnh', 'Command palette')}"><div class="box">
      <div class="in">${ic('search')}<input role="combobox" aria-expanded="true" aria-controls="spot-list" aria-autocomplete="list" placeholder="${L('Gõ lệnh, tìm bài viết hoặc sản phẩm…', 'Type a command, search posts or products…')}" autocomplete="off" spellcheck="false">${Z.kbd('Esc')}</div>
      <div class="lst" id="spot-list" role="listbox"></div>
      <div class="ft"><span>${Z.kbd('↑ ↓')} ${L('di chuyển', 'move')} ${Z.kbd('↵')} ${L('mở', 'open')}</span><span data-n></span></div></div></div>`);
    spot.prev = prev;
    document.body.append(spot);
    const box = spot.querySelector('.box');
    Z.animate(spot, [{ opacity: 0 }, { opacity: 1 }], 180);
    Z.animate(box, [{ opacity: 0, transform: 'translateY(-10px) scale(.97)' }, { opacity: 1, transform: 'none' }], 300, Z.EASE.spring);
    const inp = spot.querySelector('input'), lst = spot.querySelector('.lst');
    let opts = [], sel = 0;
    const build = () => {
      const q = inp.value.trim(), nq = norm(q), all = ACTIONS();
      const groups = [];
      if (!q) {
        const rec = Z.lsGet(RECENT, []).map((id) => all.find((a) => a.id === id)).filter(Boolean);
        if (rec.length) groups.push([L('Gần đây', 'Recent'), rec]);
      } else groups.push(['Zuey AI', [A('ask', fmt(L('Hỏi Zuey AI: “{q}”', 'Ask Zuey AI: “{q}”'), { q }), 'spark', () => Z.ask(q), '↵')]]);
      const acts = all.filter((a) => !q || norm(a.label).includes(nq));
      if (acts.length) groups.push([L('Thao tác', 'Actions'), acts]);
      if (q) {
        const arts = S.samples ? Z.SAMPLES.filter((x) => norm(x.title + ' ' + x.tags.join(' ')).includes(nq)).map((x) => A('art-' + x.id, x.title, x.paid ? 'lock' : 'doc', () => W.open('knowledges', { read: x.id }), L('Mẫu', 'Sample'))) : [];
        groups.push([L('Bài viết', 'Articles'), arts.length ? arts : [{ empty: S.samples ? L('Không có bài phù hợp.', 'No matching posts.') : L('Chưa có bài viết nào được xuất bản.', 'No posts published yet.') }]]);
        const links = Z.allLinks().filter((l) => norm(`${l.title} ${l.desc_vi || ''} ${l.desc_en || ''}`).includes(nq)).slice(0, 6).map((l) => Object.assign(A('link', short(l.title), null, () => Z.openUrl(l.url), '↗'), { tile: Z.tile(l, 'oi lg-oi') }));
        if (links.length) groups.push([L('Liên kết', 'Links'), links]);
        const reads = D.reads.items.filter((r) => norm(r.title).includes(nq)).slice(0, 4).map((r) => A('read', r.title, 'book', () => W.open('reads'), r.domain));
        if (reads.length) groups.push(['Zuey Reads', reads]);
      }
      opts = groups.flatMap((g) => g[1]).filter((o) => !o.empty);
      sel = Math.min(sel, Math.max(0, opts.length - 1));
      let k = 0;
      lst.innerHTML = groups.map(([t, items]) => `<div role="group" aria-label="${esc(t)}"><div class="grp">${esc(t)}</div>${items.map((o) => o.empty ? `<div class="none">${esc(o.empty)}</div>` : `<div class="opt" role="option" id="opt-${k}" data-k="${k}" aria-selected="${k++ === sel}">${o.tile || `<span class="oi">${ic(o.icon)}</span>`}<span class="l">${esc(o.label)}</span>${o.kbd ? Z.kbd(o.kbd) : o.hint ? `<small>${esc(o.hint)}</small>` : ''}</div>`).join('')}</div>`).join('') || `<div class="none">${L('Không có lệnh phù hợp.', 'No matching commands.')}</div>`;
      spot.querySelector('[data-n]').textContent = q ? fmt(L('{n} kết quả', '{n} results'), { n: opts.length }) : '';
      inp.setAttribute('aria-activedescendant', opts.length ? 'opt-' + sel : '');
    };
    const mark = () => { lst.querySelectorAll('.opt').forEach((o) => o.setAttribute('aria-selected', +o.dataset.k === sel)); const cur = lst.querySelector(`[data-k="${sel}"]`); if (cur) cur.scrollIntoView({ block: 'nearest' }); inp.setAttribute('aria-activedescendant', 'opt-' + sel); };
    const go = (o) => {
      if (!o) return;
      if (ACTIONS().some((a) => a.id === o.id)) Z.lsSet(RECENT, [o.id, ...Z.lsGet(RECENT, []).filter((x) => x !== o.id)].slice(0, 5));
      closeSpot(true); o.run();
    };
    inp.addEventListener('input', () => { sel = 0; build(); });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, opts.length); mark(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + opts.length) % Math.max(1, opts.length); mark(); }
      else if (e.key === 'Home') { e.preventDefault(); sel = 0; mark(); }
      else if (e.key === 'End') { e.preventDefault(); sel = opts.length - 1; mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); go(opts[sel]); }
      else if (e.key === 'Escape') { e.preventDefault(); closeSpot(); }
      else if (e.key === 'Tab') e.preventDefault();
    });
    lst.addEventListener('click', (e) => { const o = e.target.closest('.opt'); if (o) go(opts[+o.dataset.k]); });
    lst.addEventListener('pointermove', (e) => { const o = e.target.closest('.opt'); if (o && +o.dataset.k !== sel) { sel = +o.dataset.k; mark(); } });
    spot.addEventListener('pointerdown', (e) => { if (e.target === spot) closeSpot(); });
    build(); inp.focus();
  };
  const closeSpot = (keepFocus) => {
    if (!spot) return;
    const s = spot, p = s.prev; spot = null;
    Z.animate(s.querySelector('.box'), [{ transform: 'none' }, { transform: 'translateY(-6px) scale(.98)' }], 140, Z.EASE.in);
    Z.leave(s, [{ opacity: 1 }, { opacity: 0 }], 150);
    if (!keepFocus && p && p.focus) p.focus();
  };

  /* ---------- reviewer panel (demo only, clearly separated) ---------- */
  let review = null;
  function toggleReview() {
    if (review) { Z.leave(review, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateX(-12px) scale(.98)' }], 170); review = null; renderBar(); return; }
    review = Z.h('<section class="review" aria-label="Trạng thái demo"></section>');
    document.body.append(review);
    fillReview(); renderBar();
    Z.animate(review, [{ opacity: 0, transform: 'translateX(-16px) scale(.98)' }, { opacity: 1, transform: 'none' }], 300, Z.EASE.spring);
  }
  const fillReview = () => {
    if (!review) return;
    const opt = (v, t, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`;
    review.innerHTML = `<div class="rv-h"><h2>${L('Trạng thái demo', 'Demo states')}</h2><button class="x" data-a="close" aria-label="${L('Đóng', 'Close')}" title="${withKey(L('Đóng', 'Close'), 'Alt R')}">${ic('x')}</button></div>
      <p>${L('Bảng này chỉ có trong bản demo để duyệt các trạng thái. Trang thật không có.', 'Demo-only panel for reviewing states. Not part of the real site.')}</p>
      <label>${L('Vai trò', 'Role')}<select class="select" data-k="role">${opt('guest', L('Khách (chưa đăng nhập)', 'Guest'), S.role)}${opt('member', L('Thành viên', 'Member'), S.role)}${opt('admin', 'Admin', S.role)}</select></label>
      <label>${L('Gói', 'Plan')}<select class="select" data-k="plan"${S.role !== 'member' ? ' disabled' : ''}>${opt('none', L('Chưa có gói', 'No plan'), S.plan)}${D.plans.plans.map((p) => opt(p.id, `${p.name} · ${Z.usd(p.price_usd_cents)}`, S.plan)).join('')}</select></label>
      <label>Zuey AI<select class="select" data-k="aiMode">${opt('normal', L('Bình thường', 'Normal'), S.aiMode)}${opt('unconfigured', L('Chưa cấu hình', 'Not configured'), S.aiMode)}${opt('quota', L('Hết lượt (300/tháng)', 'Out of turns (300/mo)'), S.aiMode)}${opt('budget', L('Hết ngân sách AI', 'AI budget used'), S.aiMode)}${opt('error', L('Lỗi ở lần gửi tới', 'Fail next send'), S.aiMode)}</select></label>
      <label class="ck"><input type="checkbox" data-k="samples"${S.samples ? ' checked' : ''}> ${L('Bài viết mẫu (Knowledges đang trống)', 'Sample posts (Knowledges is empty)')}</label>
      <div class="row"><button class="btn sm" data-a="notice">${ic('bell')} ${L('Gửi thông báo thử', 'Send test notice')}</button><button class="btn sm ghost" data-a="all">${L('Mở mọi cửa sổ', 'Open every window')}</button></div>
      <div class="row"><button class="btn sm ghost" data-a="arrange">${L('Sắp xếp lại', 'Re-arrange')}</button><button class="btn sm ghost" data-a="keys">${ic('kbd')} ${L('Phím tắt', 'Shortcuts')}</button><button class="btn sm ghost" data-a="reset">${L('Đặt lại demo', 'Reset demo')}</button></div>`;
  };
  document.addEventListener('change', (e) => {
    if (!review || !review.contains(e.target)) return;
    const k = e.target.dataset.k; if (!k) return;
    const v = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    const patch = { [k]: v };
    if (k === 'role' && v === 'member' && S.plan === 'none') patch.plan = 'combo';
    if (k === 'role' && v !== 'guest' && !S.email) patch.email = v === 'admin' ? 'hi@zuey.me' : 'ban@example.com';
    Z.set(patch);
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('.review [data-a]'); if (!b) return;
    const a = b.dataset.a;
    if (a === 'close') toggleReview();
    if (a === 'keys') keysSheet();
    if (a === 'notice') {
      const n = { id: Z.uid(), text: L('Tối nay 21:00 Duy livestream build-in-public: dựng MCP server cho zuey.me.', 'Tonight 21:00 Duy streams build-in-public: an MCP server for zuey.me.'), until: Date.now() + 3 * 36e5 };
      Z.lsSet('zos_notices_v1', [n, ...notices()].slice(0, 5)); renderBar();
      if (zmHidden()) Z.toast(L('Zuey đang ẩn: thông báo nằm ở chuông.', 'Zuey is hidden: the notice is under the bell.'));
      showNotice(n);
    }
    if (a === 'all') ['about', 'ai', 'knowledges', 'reads', 'workflows', 'pricing', 'business', 'github', 'mcp', 'account', 'launchpad'].forEach((id, i) => setTimeout(() => W.open(id), i * 70));
    if (a === 'arrange') W.arrange();
    if (a === 'reset') Z.confirm({ title: L('Đặt lại demo?', 'Reset demo?'), body: L('Xoá mọi trạng thái demo trên trình duyệt này (cửa sổ, chat, vai trò, thời tiết) rồi tải lại.', 'Clears all demo state in this browser (windows, chats, role, weather) and reloads.'), ok: L('Đặt lại', 'Reset'), danger: true, onOk: () => { Z.lsClear(); location.reload(); } });
  });

  /* ---------- mobile home screen (≤820px) ---------- */
  const HOME_APPS = () => [['ai', 'Zuey AI'], ['knowledges', L('Bài viết', 'Articles')], ['reads', 'Reads'], ['workflows', 'Workflows'], ['business', L('Doanh nghiệp', 'Business')], ['pricing', L('Gói & giá', 'Plans')], ['mcp', 'MCP'], ['github', 'GitHub'], ['launchpad', L('Liên kết', 'Links')], [Z.signedIn() ? 'account' : 'login', Z.signedIn() ? L('Tài khoản', 'Account') : L('Đăng nhập', 'Sign in')]];
  const renderHome = () => {
    const p = D.profile, cal = D.github.calendar;
    const bio = (S.lang === 'vi' ? p.intro_vi : p.intro_en).split(/(?<=😎)|\. /)[0];
    const favs = PRODUCTS().slice(0, 5);
    $('#home').innerHTML = `
      <button class="w-prof" data-open="about" style="--i:0"><img src="assets/avatar.png" alt=""><div style="min-width:0"><h1>${esc(p.name)}</h1><p>${esc(p.handle)} · ${esc(bio)}</p></div></button>
      <div class="apps" style="--i:1">${HOME_APPS().map(([id, t]) => `<button data-open="${id}">${W.apps[id].icon()}<span>${t}</span></button>`).join('')}
        <button data-share><span class="g links">${ic('share')}</span><span>${L('Chia sẻ', 'Share')}</span></button><button data-qr><span class="g gh">${ic('qr')}</span><span>QR</span></button></div>
      <section class="widget" style="--i:2"><h3><span>Zuey Reads</span><button data-open="reads">${L('Xem tất cả', 'See all')}</button></h3>${D.reads.items.slice(0, 3).map((r) => `<button class="r" data-open="reads"><img src="${esc(r.cover)}" alt=""><b>${esc(r.title)}</b></button>`).join('')}</section>
      <section class="widget gh-w" style="--i:3"><h3><span>${L('Zuey đang làm gì', 'What Zuey is doing')}</span><button data-open="github">GitHub</button></h3><button class="r gh-wb" data-open="github" aria-label="${esc(fmt(L('{n} đóng góp trong năm qua · mở GitHub', '{n} contributions in the last year · open GitHub'), { n: cal.total.toLocaleString(S.lang === 'vi' ? 'vi-VN' : 'en-US') }))}"><span class="small muted">${fmt(L('{n} đóng góp trong năm qua', '{n} contributions in the last year'), { n: cal.total.toLocaleString(S.lang === 'vi' ? 'vi-VN' : 'en-US') })}</span>${Z.ghGraph(cal, { weeks: 18, compact: true })}</button></section>
      <nav class="mdock" style="--i:4" aria-label="${L('Sản phẩm', 'Products')}">${favs.map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener" aria-label="${esc(short(l.title))}">${Z.tile(l, 't')}</a>`).join('')}<button data-open="launchpad" aria-label="Launchpad"><span class="t more-t">${ic('grid')}</span></button></nav>
      <p class="small home-foot" style="--i:5">Crafted with ❤️ by Duy Nguyen · <a href="https://zuey.me/privacy" target="_blank" rel="noopener">${L('Quyền riêng tư', 'Privacy')}</a></p>
      <button class="askbar" data-open="ai"><span>${L('Kể tôi nghe điều bạn đang nghĩ…', 'Tell me what you are thinking…')}</span><b>${ic('spark')} ${L('Hỏi Zuey', 'Ask Zuey')}</b></button>`;
  };
  $('#home').addEventListener('click', (e) => {
    const t = e.target.closest('[data-open],[data-share],[data-qr]'); if (!t) return;
    if (t.dataset.open) W.open(t.dataset.open);
    else if ('share' in t.dataset) Z.share('https://zuey.me', 'Duy Nguyen /zuey/');
    else Z.qr('https://zuey.me', 'Duy Nguyen /zuey/');
  });

  /* ---------- state wiring ---------- */
  Z.on('state', (patch) => {
    if (patch && 'lang' in patch) { document.documentElement.lang = S.lang; Z.emit('lang'); renderIcons(); }
    renderBar(); renderDock(); renderHome(); fillReview(); W.refresh();
  });
  Z.on('wins', renderDock);
  Z.on('expo', (on) => { const b = $('#dock [data-expo]'); if (b) b.setAttribute('aria-pressed', String(on)); });
  Z.on('mascot', renderBar);

  /* ---------- boot: a short splash once per session, then the desktop assembles itself ---------- */
  document.documentElement.lang = S.lang;
  renderBar(); renderIcons(); renderHome(); renderDock(true);
  FX.bg(S.bg); applyWx(false);
  M.init();
  const saved = Z.lsGet('zos_open_v1', null);
  const hash = location.hash.slice(1);
  const openStart = (delay) => {
    const ids = W.mobile() ? [] : (saved || (innerWidth >= 1400 ? ['about', 'ai', 'reads'] : ['about', 'ai']));
    ids.forEach((id, i) => setTimeout(() => W.open(id), delay + i * 130));
    const ask = Z.lsGet('zos_ask_v1', null);
    if (ask && ask.q && Date.now() - ask.t < 60000) { try { localStorage.removeItem('zos_ask_v1'); } catch (e) { /* ignore */ } setTimeout(() => Z.ask(ask.q), delay + ids.length * 130 + 100); }
    else if (hash && W.apps[hash]) setTimeout(() => W.open(hash), delay + ids.length * 130);
    const n = activeNotices()[0];
    if (n) setTimeout(() => showNotice(n), delay + 3000);
  };
  let first = false;
  try { first = !sessionStorage.getItem('zos_boot_v1'); sessionStorage.setItem('zos_boot_v1', '1'); } catch (e) { first = false; }
  if (!first || Z.reduced) openStart(0);
  else {
    const boot = Z.h(`<div class="boot" aria-hidden="true"><div class="bl"><i>/z</i><b>Zuey OS</b><span class="bar"><span></span></span><small>${L('Đang mở bàn làm việc của Duy…', 'Opening Duy\'s desk…')}</small></div></div>`);
    document.body.append(boot);
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      document.body.classList.add('intro');
      Z.leave(boot, [{ opacity: 1 }, { opacity: 0, transform: 'scale(1.04)' }], 420);
      setTimeout(() => document.body.classList.remove('intro'), 1800);
      openStart(380);
    };
    boot.addEventListener('pointerdown', finish);
    setTimeout(finish, 1150);
  }
})();
