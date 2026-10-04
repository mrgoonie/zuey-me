/* Zuey OS demo apps: every window maps to a live zuey.me surface (profile, AI, knowledges, reads, plans, booking, GitHub, MCP, auth, account). */
(() => {
  'use strict';
  const { D, S, W, L, esc, ic, fmt } = Z;
  const head = (eyebrow, title, lead) => `<div class="eyebrow">${eyebrow}</div><h2 class="h2">${title}</h2>${lead ? `<p class="lead">${lead}</p>` : ''}`;
  const demoTag = (t) => `<span class="tag sample">${esc(t || L('Demo', 'Demo'))}</span>`;
  const plural = (n, vi, en) => (S.lang === 'vi' ? `${n} ${vi}` : `${n} ${en}${n === 1 ? '' : 's'}`);

  /* ======================= about-zuey.md (ProfileView) ======================= */
  const SOC = [['IG', 'imzuey', 'https://instagram.com/imzuey'], ['TikTok', '@mrgoonvn', 'https://www.tiktok.com/@mrgoonvn'], ['WhatsApp', 'imzuey', 'https://wa.me/imzuey'], ['YouTube', '@imzuey', 'https://youtube.com/@imzuey'], ['Facebook', 'mrgoonie', 'https://fb.com/mrgoonie'], ['Threads', '@imzuey', 'https://www.threads.net/@imzuey'], ['X', 'goon_nguyen', 'https://x.com/goon_nguyen']];
  const TILES = () => [
    ['knowledges', L('Bài viết', 'Articles'), L('Ghi chép, biểu đồ, khảo sát', 'Notes, charts, surveys')],
    ['reads', L('Zuey đang đọc', 'Zuey is reading'), L('Tóm tắt những gì mình đọc', 'Summaries of what I read')],
    ['workflows', L('Workflow AI', 'AI workflows'), L('Cách mình làm việc với AI', 'How I work with AI')],
    ['business', L('Cho doanh nghiệp', 'For business'), L('Tư vấn 1:1 · $1,999', '1:1 consulting · $1,999')],
  ];
  W.reg('about', {
    min: { w: 340, h: 360 },
    light: true,
    icon: () => '<span class="g about"><img src="assets/avatar.png" alt=""></span>',
    title: () => 'about-zuey.md',
    rect: (aw, ah) => ({ x: 16, y: 14, w: 420, h: Math.min(ah - 14, 780) }),
    render(body) {
      const p = D.profile;
      body.innerHTML = `
        <div class="ab-head"><span class="mono" style="font-weight:800;color:var(--accent-ink)">/zuey/</span>
          <div class="row">${Z.isAdmin() ? `<a class="btn sm ghost" href="https://zuey.me/studio" target="_blank" rel="noopener">${ic('layout')} Studio</a>` : ''}
          <button class="icon-btn" data-qr aria-label="QR Code" title="QR Code">${ic('qr')}</button>
          <button class="icon-btn" data-share aria-label="${L('Chia sẻ profile', 'Share profile')}" title="${L('Chia sẻ profile', 'Share profile')}">${ic('share')}</button></div></div>
        <div class="prof"><div class="avatar"><img src="assets/avatar.png" alt="Duy Nguyen"><span class="tick" title="${L('Đã xác minh', 'Verified')}">✓</span></div>
          <div><h1>${esc(p.name)}</h1><div class="h"><span>${esc(p.handle)}</span><span aria-hidden="true">·</span><button data-mail title="${L('Sao chép email', 'Copy email')}">${esc(p.email)}</button></div></div></div>
        <p class="bio">${esc(S.lang === 'vi' ? p.intro_vi : p.intro_en)}</p>
        <div class="socials">${SOC.map(([n, h, u]) => `<a href="${u}" target="_blank" rel="noopener" aria-label="${n} ${h}">${n} <span style="opacity:.7">${esc(h)}</span></a>`).join('')}</div>
        <div class="tiles">${TILES().map(([id, t, s]) => `<button data-open="${id}"><b>${t}</b><span>${s}</span></button>`).join('')}</div>
        <h2 class="sec-t">${L('Blog & bài viết', 'Blogs & publications')}</h2><div class="lc-list" data-blogs></div>
        <h2 class="sec-t">${L('Sản phẩm & công ty', 'Products & companies')}</h2>
        <p class="small muted">${L('12 sản phẩm và 6 công ty nằm ở Dock phía dưới. Launchpad liệt kê tất cả kèm mô tả.', '12 products and 6 companies live in the Dock. Launchpad lists them all with descriptions.')}</p>
        <div class="lstrip">${[...D.links['Products & AI Engineering Tools'], ...D.links['Companies & Organizations']].map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener" title="${esc(Z.cleanTitle(l.title))}" aria-label="${esc(Z.cleanTitle(l.title))}">${Z.tile(l, 'ls-ic')}</a>`).join('')}</div>
        <div class="row" style="margin-top:12px"><button class="btn sm" data-open="launchpad">${ic('grid')} Launchpad</button><button class="btn sm ghost" data-open="github">${ic('gh')} ${L('Zuey đang làm gì', 'What Zuey is doing')}</button></div>
        <footer class="ab-foot"><span>zuey.me</span><button data-mail>hi@zuey.me</button><a href="https://zuey.me/docs" target="_blank" rel="noopener">API Docs</a><a href="https://zuey.me/llms.txt" target="_blank" rel="noopener">llms.txt</a><a href="https://zuey.me/privacy" target="_blank" rel="noopener">${L('Quyền riêng tư', 'Privacy')}</a>
          <span style="flex-basis:100%">Crafted with ❤️ by Duy Nguyen. Hosted on Cloudflare Edge.</span></footer>`;
      const blogs = body.querySelector('[data-blogs]');
      D.links['Blogs & Publications'].forEach((l) => blogs.append(Z.linkCard(l)));
      body.onclick = (e) => {
        const t = e.target.closest('[data-open],[data-qr],[data-share],[data-mail]');
        if (!t) return;
        if (t.dataset.open) W.open(t.dataset.open);
        else if (t.hasAttribute('data-qr')) Z.qr('https://zuey.me', 'Duy Nguyen /zuey/');
        else if (t.hasAttribute('data-share')) Z.share('https://zuey.me', 'Duy Nguyen /zuey/');
        else if (t.hasAttribute('data-mail')) Z.copy(p.email);
      };
    },
  });

  /* ======================= Zuey AI (chat) ======================= */
  const AI_KEY = 'zos_ai_v1';
  const AIS = (() => { const s = Z.lsGet(AI_KEY, null); return s && Array.isArray(s.sessions) ? s : { sessions: [], cur: null }; })();
  const aiSave = () => Z.lsSet(AI_KEY, AIS);
  const cur = () => AIS.sessions.find((s) => s.id === AIS.cur) || null;
  const SUG = () => [L('Giúp tôi chọn một cách bắt đầu với AI', 'Help me pick a way to start with AI'), L('Tìm bài về xây dựng sản phẩm', 'Find posts about building products'), L('Dựng khối tương tác: effort và chi phí', 'Build an interactive block: effort vs cost')];
  const ERR = {
    ai_timeout: () => L('Zuey trả lời quá lâu nên lượt này bị ngắt. Bạn thử lại nhé.', 'Zuey took too long and the turn was cut off. Please retry.'),
    generic: () => L('Có lỗi khi gọi Zuey AI. Bạn thử lại sau ít phút.', 'Something went wrong calling Zuey AI. Try again shortly.'),
  };
  const aiGate = () => {
    if (!Z.signedIn()) return 'guest';
    if (Z.isAdmin()) return S.aiMode === 'unconfigured' ? 'unconf' : null;
    if (!Z.canChat()) return 'noent';
    if (S.aiMode === 'unconfigured') return 'unconf';
    if (S.aiMode === 'quota') return 'quota';
    if (S.aiMode === 'budget') return 'budget';
    return null;
  };
  const sentCount = () => AIS.sessions.reduce((n, s) => n + s.msgs.filter((m) => m.role === 'me').length, 0);
  const monthLabel = () => Z.date(Date.now(), { month: 'numeric', year: 'numeric' });
  const quotaPill = () => {
    if (!Z.signedIn() || (!Z.canChat() && !Z.isAdmin())) return '';
    if (Z.isAdmin()) return `<span class="quota">${L('Admin · không giới hạn', 'Admin · unlimited')}</span>`;
    const plan = Z.plan(), budget = plan.ai_budget_usd_cents;
    if (S.aiMode === 'quota') return `<span class="quota low">${fmt(L('Còn {r}/{l} lượt', '{r}/{l} left'), { r: 0, l: 300 })}</span>`;
    if (S.aiMode === 'budget') return `<span class="quota low">AI ${Z.usd(budget)}/${Z.usd(budget)}</span>`;
    const used = 12 + sentCount(), spent = 41 + 3 * sentCount();
    return `<span class="quota" title="${L('Số liệu mô phỏng', 'Simulated usage')}">${fmt(L('Còn {r}/{l} lượt', '{r}/{l} left'), { r: 300 - used, l: 300 })} · AI ${Z.usd(spent)}/${Z.usd(budget)}</span>`;
  };
  const banner = (gate) => {
    const B = {
      guest: [L('Đăng nhập để trò chuyện với Zuey AI', 'Sign in to chat with Zuey AI'), L('Zuey AI trả lời dựa trên các bài Zuey đã viết. Có nguồn thì dẫn, chưa đủ nguồn thì nói rõ.', 'Zuey AI answers from what Zuey has written. It cites sources, and says so when sources are thin.'), `<button class="btn" data-go="login">${L('Đăng nhập', 'Sign in')}</button><button class="btn ghost" data-go="pricing">${L('Xem các gói', 'See plans')}</button>`],
      noent: [L('Gói hiện tại chưa gồm Zuey AI', 'Your plan does not include Zuey AI'), L('Zuey AI có trong gói Zuey AI ($9/tháng), Kết hợp ($19) và Cộng đồng ($29).', 'Zuey AI is in the Zuey AI ($9/mo), Combo ($19) and Community ($29) plans.'), `<button class="btn" data-go="pricing">${L('Nâng cấp', 'Upgrade')}</button>`],
      unconf: [L('Zuey AI đang tạm nghỉ', 'Zuey AI is resting'), L('Dịch vụ AI chưa được cấu hình xong trên máy chủ. Vui lòng quay lại sau.', 'The AI service is not configured on the server yet. Please come back later.'), ''],
      quota: [L('Bạn đã dùng hết lượt tháng này', 'You have used this month\'s turns'), fmt(L('Gói của bạn có {limit} lượt hỏi mỗi tháng. Lượt sẽ được làm mới sau tháng {month} (giờ Việt Nam).', 'Your plan has {limit} questions a month. Turns refresh after {month} (Vietnam time).'), { limit: 300, month: monthLabel() }), `<button class="btn ghost" data-go="pricing">${L('Xem các gói', 'See plans')}</button>`],
      budget: [L('Bạn đã dùng hết lượt tháng này', 'You have used this month\'s turns'), fmt(L('Gói của bạn có ngân sách AI {usd} mỗi tháng và bạn đã dùng hết. Ngân sách sẽ được làm mới sau tháng {month} (giờ Việt Nam).', 'Your plan has a {usd} monthly AI budget and it is used up. It refreshes after {month} (Vietnam time).'), { usd: Z.signedIn() && Z.plan() ? Z.usd(Z.plan().ai_budget_usd_cents) : '$5', month: monthLabel() }), `<button class="btn ghost" data-go="pricing">${L('Xem các gói', 'See plans')}</button>`],
    }[gate];
    return `<div class="banner" role="note"><h3>${ic(gate === 'guest' ? 'lock' : gate === 'unconf' ? 'clock' : 'spark')} ${B[0]}</h3><p>${B[1]}</p>${B[2] ? `<div class="row">${B[2]}</div>` : ''}</div>`;
  };
  const md = (t) => {
    const out = []; let list = null;
    esc(t).split('\n').forEach((line) => {
      const fmtl = (s) => s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>');
      if (/^- /.test(line)) { if (!list) { list = []; } list.push(`<li>${fmtl(line.slice(2))}</li>`); return; }
      if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
      if (line.trim()) out.push(`<p>${fmtl(line)}</p>`);
    });
    if (list) out.push(`<ul>${list.join('')}</ul>`);
    return out.join('');
  };
  /* ground scripted answers in the real Zuey Reads snapshot (Knowledges has no public article yet) */
  const pickReads = (q) => {
    const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
    const scored = D.reads.items.map((r, i) => {
      const hay = `${r.title} ${r.summary || ''} ${r.description || ''}`.toLowerCase();
      return { i, s: words.reduce((n, w) => n + (hay.includes(w) ? 1 : 0), 0) };
    }).sort((a, b) => b.s - a.s);
    return scored.slice(0, 2).map((x) => x.i);
  };
  const firstSentence = (s) => (s || '').replace(/\s+/g, ' ').split(/(?<=[.!?])\s/)[0].slice(0, 220);
  const compose = (q) => {
    const ql = q.toLowerCase(), idx = pickReads(q), r = idx.map((i) => D.reads.items[i]);
    const src = idx.map((i) => ({ kind: 'read', i }));
    if (S.samples) { const a = SAMPLES.find((x) => ql.split(/\s+/).some((w) => w.length > 3 && x.title.toLowerCase().includes(w))) || SAMPLES[0]; src.unshift({ kind: 'art', id: a.id }); }
    if (/khối|tương tác|interactive|block|chi phí|cost/.test(ql)) {
      return { text: L('Mình dựng một khối tương tác nhỏ để bạn kéo thử mức effort và xem token, thời gian, độ kỹ thay đổi ra sao.\n\nSố liệu trong khối chỉ để minh hoạ tỉ lệ, không phải số đo thật. Ý chính lấy từ bài **' + r[0].title + '**: tăng effort khi việc cần suy luận nhiều bước, giữ thấp cho việc lặp lại.', 'Here is a small interactive block: drag the effort level and watch tokens, time and depth change.\n\nNumbers are illustrative ratios, not measurements. The idea comes from **' + r[0].title + '**: raise effort for multi-step reasoning, keep it low for routine work.'), src, art: true };
    }
    if (/bắt đầu|start|chọn|pick/.test(ql)) {
      return { text: L('Nếu mới bắt đầu, mình gợi ý ba bước nhỏ:\n\n- **Chọn một việc lặp lại mỗi tuần**, ví dụ tóm tắt cuộc họp hay viết mô tả sản phẩm.\n- **Cho AI làm bản nháp đầu**, bạn chỉ sửa. Ghi lại chỗ nào phải sửa nhiều nhất.\n- **Sau hai tuần, đo lại** thời gian tiết kiệm được rồi mới mở rộng sang việc khác.\n\nHai bài trong Zuey Reads bên dưới nói kỹ về cách giao việc cho agent. Bạn đang làm nghề gì? Mình sẽ gợi ý việc đầu tiên cụ thể hơn.', 'If you are just starting, try three small steps:\n\n- **Pick one task you repeat weekly**, like meeting notes or product copy.\n- **Let AI draft first** and you edit. Note where you edit most.\n- **After two weeks, measure** the time saved before expanding.\n\nThe two Zuey Reads below cover delegating to agents in depth. What do you do for work? I can suggest a first task.'), src };
    }
    if (/sản phẩm|product|build/.test(ql)) {
      return { text: L('Kho Knowledges hiện chưa có bài công khai về xây dựng sản phẩm, nên mình tìm trong Zuey Reads. Gần nhất là:\n\n' + r.map((x) => `- **${x.title}**: ${firstSentence(x.summary)}`).join('\n') + '\n\nBạn muốn mổ xẻ khâu nào: ý tưởng, ra mắt hay tăng trưởng?', 'Knowledges has no public post on building products yet, so I searched Zuey Reads. Closest:\n\n' + r.map((x) => `- **${x.title}**: ${firstSentence(x.summary)}`).join('\n') + '\n\nWhich stage do you want to dig into: idea, launch or growth?'), src };
    }
    return { text: L('Mình chưa thấy bài nào của Zuey trả lời trực tiếp câu này. Gần nhất là:\n\n' + r.map((x) => `- **${x.title}**: ${firstSentence(x.summary)}`).join('\n') + '\n\nNếu bạn kể thêm bối cảnh, mình sẽ mổ xẻ cụ thể hơn.', 'I have not found a Zuey post that answers this directly. Closest:\n\n' + r.map((x) => `- **${x.title}**: ${firstSentence(x.summary)}`).join('\n') + '\n\nTell me more context and I will dig deeper.'), src };
  };
  const ART_DOC = `<!doctype html><meta charset="utf-8"><style>body{font:14px system-ui,sans-serif;margin:0;padding:14px;background:#fffaf6;color:#231f1c}h3{margin:0 0 10px;font:700 15px Georgia,serif}label{display:block;margin-bottom:10px}input{width:100%}.r{display:grid;grid-template-columns:96px 1fr 56px;gap:8px;align-items:center;margin:8px 0;font-size:12px}.t{background:#ebe3dc;border-radius:7px;height:14px}.b{height:14px;border-radius:7px;background:#c4532a;transition:width .3s}small{color:#6a5f57}</style>
<h3>Effort ↔ chi phí (minh hoạ)</h3><label>Mức effort: <b id="l"></b><input id="s" type="range" min="0" max="3" value="1"></label>
<div class="r"><span>Token suy nghĩ</span><div class="t"><div class="b" id="a"></div></div><span id="av"></span></div>
<div class="r"><span>Thời gian</span><div class="t"><div class="b" id="b" style="background:#3e6b5c"></div></div><span id="bv"></span></div>
<div class="r"><span>Độ kỹ</span><div class="t"><div class="b" id="c" style="background:#6b4fd6"></div></div><span id="cv"></span></div>
<small>Tỉ lệ minh hoạ, không phải số đo thật.</small>
<script>var N=['low','medium','high','max'],T=[1,2.5,5,9],P=[8,15,30,60],Q=[55,72,86,93];function u(){var i=+s.value;l.textContent=N[i];a.style.width=T[i]/9*100+'%';av.textContent='×'+T[i];b.style.width=P[i]/60*100+'%';bv.textContent='~'+P[i]+'s';c.style.width=Q[i]+'%';cv.textContent=Q[i]+'%'}s.oninput=u;u()<\/script>`;
  const srcHTML = (list) => `<div class="srcs"><div class="lbl">${L('Nguồn', 'Sources')}</div>${list.map((s) => {
    if (s.kind === 'art') {
      const a = SAMPLES.find((x) => x.id === s.id); if (!a) return '';
      const tag = a.paid ? (Z.canReadFull() ? L('Bài trả phí', 'Paid post') : L('Bài trả phí · chỉ dùng phần xem trước', 'Paid post · preview only')) : L('Miễn phí', 'Free');
      return `<a href="#" data-art="${a.id}">${ic(a.paid ? 'lock' : 'doc')}<span>${esc(a.title)}</span><span class="tag">${tag}</span><span class="tag sample">${L('Mẫu', 'Sample')}</span></a>`;
    }
    const r = D.reads.items[s.i];
    return `<a href="${esc(r.url)}" target="_blank" rel="noopener">${ic('book')}<span>${esc(r.title)}</span><span class="tag">Reads · ${esc(r.source_kind)}</span></a>`;
  }).join('')}</div>`;
  const artHTML = (m) => `<div class="artifact" data-artblock="${m.id}"><div class="ah">${ic('sliders')}<b>${L('Khối tương tác', 'Interactive block')} · effort ↔ cost</b>
    <button class="btn sm ghost" data-afull="${m.id}" title="${L('Mở toàn màn hình', 'Open full screen')}">${ic('ext')}</button><button class="btn sm ghost" data-areload="${m.id}" title="${L('Chạy lại', 'Reload')}">${ic('refresh')}</button></div>
    <div class="run"><button class="btn acc" data-arun="${m.id}">${ic('play')} ${L('Chạy demo', 'Run demo')}</button></div>
    <p class="an">${L('Chạy trong sandbox cô lập; mạng chỉ qua proxy được duyệt.', 'Runs in an isolated sandbox; network only through the approved proxy.')}</p></div>`;
  const frame = (h) => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.title = L('Khối tương tác', 'Interactive block'); f.srcdoc = ART_DOC; if (h) f.style.height = h; return f; };
  const msgHTML = (m, w) => {
    if (m.role === 'me') return `<div class="msg me">${esc(m.text)}</div>`;
    const busy = w.state.busy && w.state.busy.mid === m.id;
    let inner;
    if (m.error) inner = `<div class="ai-err" role="alert"><b>${L('Chưa nhận được câu trả lời', 'No answer received')}</b>${esc((ERR[m.error] || ERR.generic)())}<div class="row" style="margin-top:8px"><button class="btn sm" data-retry="${m.id}">${ic('refresh')} ${L('Thử lại', 'Retry')}</button></div></div>`;
    else if (busy && w.state.busy.phase === 'thinking') inner = `<div class="thinking" role="status"><span class="dots" aria-hidden="true"><span></span><span></span><span></span></span><span>${L('Zuey đang suy nghĩ…', 'Zuey is thinking…')}</span><small data-sec></small></div>`;
    else inner = `<div class="txt${busy ? ' caret' : ''}">${md(m.text)}</div>${m.stopped ? `<p class="stopped">${L('Đã dừng câu trả lời.', 'Answer stopped.')}</p>` : ''}${!busy && m.sources && m.sources.length ? srcHTML(m.sources) : ''}${!busy && m.art ? artHTML(m) : ''}`;
    return `<div class="msg ai" data-mid="${m.id}"><div class="who">Zuey AI</div>${inner}</div>`;
  };
  const greetHTML = () => `<div class="msg ai"><div class="who">Zuey AI</div><p>${L('Bạn đang mắc ở bước nào? Mình cùng tìm nguồn và mổ xẻ nhé.', 'Where are you stuck? Let us find sources and dig in.')}</p></div>`;
  const chatHTML = (w) => { const s = cur(); return !s || !s.msgs.length ? greetHTML() : s.msgs.map((m) => msgHTML(m, w)).join(''); };
  const paintChat = (w) => {
    const c = w.body.querySelector('[data-chat]'); if (!c) return;
    c.innerHTML = chatHTML(w); tickSec(w);
    const sc = w.body.querySelector('.ai-scroll'); sc.scrollTop = sc.scrollHeight;
  };
  const tickSec = (w) => {
    const el = w.body.querySelector('[data-sec]');
    if (el && w.state.busy) el.textContent = fmt(L('{s} giây · câu chữ đầu tiên thường mất 8–11 giây', '{s}s · first words usually take 8–11s'), { s: Math.floor((Date.now() - w.state.busy.t0) / 1000) });
  };
  const stopStream = (w, silent) => {
    const b = w.state.busy; if (!b) return;
    b.timers.forEach(clearTimeout); clearInterval(b.iv); clearInterval(b.sec);
    const m = cur() && cur().msgs.find((x) => x.id === b.mid);
    if (m && !silent) { m.stopped = true; m.pending = false; }
    w.state.busy = null; aiSave(); Z.M.react(null);
    if (!silent) W.rerender('ai');
  };
  const send = (w, text) => {
    text = (text || '').trim();
    if (!text || w.state.busy || aiGate()) return;
    let s = cur();
    if (!s) { s = { id: Z.uid(), title: text.slice(0, 48), at: Date.now(), msgs: [] }; AIS.sessions.unshift(s); AIS.cur = s.id; }
    const ans = { id: Z.uid(), role: 'ai', text: '', pending: true, q: text };
    s.msgs.push({ id: Z.uid(), role: 'me', text }, ans);
    w.state.draft = ''; aiSave();
    run(w, ans);
  };
  const run = (w, ans) => {
    const b = (w.state.busy = { mid: ans.id, phase: 'thinking', t0: Date.now(), timers: [] });
    ans.error = null; ans.text = ''; ans.stopped = false;
    W.rerender('ai'); Z.M.react('thinking');
    b.sec = setInterval(() => tickSec(w), 1000);
    b.timers.push(setTimeout(() => {
      clearInterval(b.sec);
      if (S.aiMode === 'error') {
        ans.error = 'ai_timeout'; ans.pending = false; w.state.busy = null; aiSave();
        Z.M.react('surprised'); Z.set({ aiMode: 'normal' });
        return;
      }
      const a = compose(ans.q);
      const toks = a.text.split(/(\s+)/); let i = 0;
      b.phase = 'streaming'; paintChat(w); Z.M.react('talk');
      b.iv = setInterval(() => {
        ans.text += toks.slice(i, i + 3).join(''); i += 3;
        const el = w.body.querySelector(`[data-mid="${ans.id}"] .txt`);
        if (el) el.innerHTML = md(ans.text); else paintChat(w);
        const sc = w.body.querySelector('.ai-scroll'); if (sc) sc.scrollTop = sc.scrollHeight;
        if (i >= toks.length) {
          clearInterval(b.iv); ans.pending = false; ans.sources = a.src; ans.art = !!a.art;
          w.state.busy = null; aiSave(); Z.M.react('happy'); W.rerender('ai');
        }
      }, 45);
    }, 2600));
  };
  const sessionMenu = (anchor, w, id) => {
    const s = AIS.sessions.find((x) => x.id === id); if (!s) return;
    Z.menu(anchor, [
      { label: L('Đổi tên', 'Rename'), icon: 'edit', on: () => {
        const d = Z.dialog({ title: L('Đổi tên cuộc trò chuyện', 'Rename conversation'), body: `<form class="stack"><input class="input" name="t" maxlength="80" value="${esc(s.title)}"><div class="row" style="justify-content:flex-end"><button type="button" class="btn ghost" data-c>${L('Huỷ', 'Cancel')}</button><button class="btn">${L('Lưu', 'Save')}</button></div></form>`, mount: (dd) => dd.querySelector('input').select() });
        d.querySelector('[data-c]').onclick = () => d.close();
        d.querySelector('form').onsubmit = (e) => { e.preventDefault(); s.title = e.target.t.value.trim() || s.title; aiSave(); d.close(); W.rerender('ai'); };
      } },
      { label: L('Xoá', 'Delete'), icon: 'trash', on: () => Z.confirm({ title: L('Xoá cuộc trò chuyện này?', 'Delete this conversation?'), body: L('Tin nhắn và khối tương tác trong cuộc trò chuyện sẽ bị xoá vĩnh viễn.', 'Messages and interactive blocks in it are permanently deleted.'), ok: L('Xoá', 'Delete'), danger: true, onOk: () => {
        if (w.state.busy && AIS.cur === id) stopStream(w, true);
        AIS.sessions = AIS.sessions.filter((x) => x.id !== id); if (AIS.cur === id) AIS.cur = null; aiSave(); W.rerender('ai'); Z.toast(L('Đã xoá cuộc trò chuyện.', 'Conversation deleted.'));
      } }) },
    ], { alignRight: true });
  };
  const exportAll = () => {
    const json = JSON.stringify({ exported_at: new Date().toISOString(), sessions: AIS.sessions.map((s) => ({ id: s.id, title: s.title, messages: s.msgs.map((m) => ({ role: m.role === 'me' ? 'user' : 'assistant', content: m.text })) })) }, null, 2);
    const d = Z.dialog({ title: L('Tải tất cả (JSON)', 'Download all (JSON)'), wide: true, body: `<p class="small" style="color:var(--muted)">${L('Bản thật tải file JSON. Khung artifact chặn tải file nên demo hiển thị nội dung để sao chép.', 'The live site downloads a JSON file. This frame blocks downloads, so the demo shows the content to copy.')}</p><textarea class="textarea mono" rows="10" readonly>${esc(json)}</textarea><div class="row" style="justify-content:flex-end"><button class="btn" data-cp>${ic('copy')} ${L('Sao chép', 'Copy')}</button></div>` });
    d.querySelector('[data-cp]').onclick = () => Z.copy(json);
  };
  W.reg('ai', {
    min: { w: 380, h: 420 },
    icon: () => `<span class="g ai">${ic('spark')}</span>`,
    title: () => 'zuey-ai — chat',
    rect: (aw, ah) => ({ x: 452, y: 14, w: aw >= 1400 ? Math.min(540, aw - 918) : Math.min(600, aw - 588), h: Math.min(ah - 14, 680) }),
    mount(w) { w.state.loading = true; setTimeout(() => { w.state.loading = false; W.rerender('ai'); }, 600); },
    onClose(w) { stopStream(w, true); },
    render(body, w, arg) {
      if (arg && arg !== w.state.lastArg) { w.state.lastArg = arg; if (arg.ask) w.state.pendingAsk = arg.ask; if (arg.newChat && !w.state.busy) AIS.cur = null; }
      if (w.state.loading) { body.innerHTML = `<div class="empty" style="color:var(--muted-inv)"><span class="dots"><span></span><span></span><span></span></span>${L('Đang tải Zuey AI…', 'Loading Zuey AI…')}</div>`; return; }
      const gate = aiGate(), busy = !!w.state.busy, s = cur();
      const side = Z.signedIn();
      body.style.padding = '0';
      body.innerHTML = `<div class="aiw${side ? '' : ' nos'}">
        ${side ? `<aside class="ai-side" aria-label="${L('Cuộc trò chuyện', 'Conversations')}"><button class="btn sm acc new" data-new>${ic('plus')} ${L('Trò chuyện mới', 'New chat')}</button>
          <ul>${AIS.sessions.length ? AIS.sessions.map((x) => `<li aria-current="${x.id === AIS.cur}"><button data-sess="${x.id}">${esc(x.title || L('Chưa đặt tên', 'Untitled'))}</button><button class="more" data-smore="${x.id}" aria-label="${L('Tuỳ chọn', 'Options')}">${ic('more')}</button></li>`).join('') : `<li class="small muted" style="padding:8px 10px">${L('Chưa có cuộc trò chuyện nào.', 'No conversations yet.')}</li>`}</ul>
          <div class="foot"><button data-export>${ic('download')} ${L('Tải tất cả (JSON)', 'Download all (JSON)')}</button><a href="https://zuey.me/chat" target="_blank" rel="noopener">${ic('ext')} ${L('Mở trang chat', 'Open chat page')}</a></div></aside>` : ''}
        <div class="ai-main">
          <div class="ai-head"><div><div class="eyebrow">A little more Zuey</div><h2>Zuey AI</h2><p class="lead small">${L('Một góc nhìn khác. Từ những gì Zuey đã viết.', 'Another angle. From what Zuey has written.')}</p></div>
            <div class="row" style="justify-content:flex-end">${quotaPill()}${side ? `<button class="chip sessm" data-sessmenu aria-label="${L('Cuộc trò chuyện', 'Conversations')}">${ic('chat')} ${AIS.sessions.length}</button>` : ''}</div></div>
          ${gate ? banner(gate) : ''}
          <div class="ai-scroll"><div class="chat" data-chat aria-live="polite"></div></div>
          <p class="privacy">${L('Chat được lưu riêng cho bạn; admin chỉ truy cập khi có lý do và mọi lần truy cập đều được ghi lại.', 'Chats are private to you; admins access them only with a reason and every access is logged.')}</p>
          <div class="composer">
            ${!gate && (!s || !s.msgs.length) ? `<div class="sugg">${SUG().map((x) => `<button class="chip" data-sug="${esc(x)}">${esc(x)}</button>`).join('')}</div>` : ''}
            <div class="field"><label class="sr" for="ai-in">${L('Câu hỏi cho Zuey', 'Question for Zuey')}</label><textarea id="ai-in" rows="1" placeholder="${L('Kể tôi nghe điều bạn đang nghĩ…', 'Tell me what you are thinking…')}"${gate ? ' disabled' : ''}></textarea>
              <button class="send${busy ? ' stop' : ''}" data-send${gate && !busy ? ' disabled' : ''}>${busy ? ic('stop') + ' ' + L('Dừng', 'Stop') : ic('send') + ' ' + L('Hỏi Zuey', 'Ask Zuey')}</button></div>
            <div class="hint"><span>${L('Enter để gửi · Shift+Enter xuống dòng · Esc để dừng', 'Enter to send · Shift+Enter for newline · Esc to stop')}</span><span>${L('Demo: câu trả lời dựng sẵn từ Zuey Reads', 'Demo: scripted answers from Zuey Reads')}</span></div>
          </div></div></div>`;
      paintChat(w);
      const ta = body.querySelector('textarea');
      ta.value = w.state.draft || '';
      const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; };
      ta.oninput = () => { w.state.draft = ta.value; grow(); };
      ta.onkeydown = (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(w, ta.value); }
        if (e.key === 'Escape' && w.state.busy) { e.preventDefault(); e.stopPropagation(); stopStream(w); }
      };
      if (w.state.pendingAsk && !gate && !busy) { const q = w.state.pendingAsk; w.state.pendingAsk = null; setTimeout(() => send(w, q), 120); }
      else if (w.state.pendingAsk) { ta.value = w.state.draft = w.state.pendingAsk; w.state.pendingAsk = null; }
      body.onclick = (e) => {
        const t = e.target.closest('button,a[data-art]'); if (!t) return;
        const d = t.dataset;
        if ('send' in d) return busy ? stopStream(w) : send(w, ta.value);
        if (d.sug) return send(w, d.sug);
        if (d.go) return W.open(d.go);
        if ('new' in d) { if (busy) stopStream(w, true); AIS.cur = null; aiSave(); return W.rerender('ai'); }
        if (d.sess) { if (busy) stopStream(w, true); AIS.cur = d.sess; aiSave(); return W.rerender('ai'); }
        if (d.smore) return sessionMenu(t, w, d.smore);
        if ('export' in d) return exportAll();
        if ('sessmenu' in d) return Z.menu(t, [{ label: L('Trò chuyện mới', 'New chat'), icon: 'plus', on: () => { if (busy) stopStream(w, true); AIS.cur = null; W.rerender('ai'); } }, { sep: true }, ...AIS.sessions.map((x) => ({ label: x.title || L('Chưa đặt tên', 'Untitled'), checked: x.id === AIS.cur, on: () => { if (busy) stopStream(w, true); AIS.cur = x.id; aiSave(); W.rerender('ai'); } })), { sep: true }, { label: L('Tải tất cả (JSON)', 'Download all (JSON)'), icon: 'download', on: exportAll }], { alignRight: true });
        if (d.retry) { const m = cur().msgs.find((x) => x.id === d.retry); if (m) run(w, m); return; }
        if (d.art) { e.preventDefault(); return W.open('knowledges', { read: d.art }); }
        if (d.arun || d.areload) { const blk = body.querySelector(`[data-artblock="${d.arun || d.areload}"]`); const old = blk.querySelector('.run, iframe'); old.replaceWith(frame()); return; }
        if (d.afull) { const dd = Z.dialog({ title: L('Khối tương tác', 'Interactive block'), wide: true, body: '' }); dd.querySelector('.db').append(frame('60vh')); dd.querySelector('.db').append(Z.h(`<p class="small" style="color:var(--muted)">${L('Chạy trong sandbox cô lập; mạng chỉ qua proxy được duyệt.', 'Runs in an isolated sandbox; network only through the approved proxy.')}</p>`)); }
      };
    },
  });
  Z.ask = (q) => W.open('ai', { ask: q });

  /* ======================= Knowledges ======================= */
  const SAMPLES = ZART.list;
  Z.SAMPLES = SAMPLES;
  const CATS = ['AI Engineering', 'Sản phẩm', 'Build in Public', 'Cộng đồng'];
  const artUrl = (a) => `https://zuey.me/knowledges/${a.id}`;
  const canRead = (a) => ZART.access(a, S).full;
  const hl = (t, q) => { const e = esc(t); if (!q) return e; const i = e.toLowerCase().indexOf(esc(q).toLowerCase()); return i < 0 ? e : e.slice(0, i) + '<mark>' + e.slice(i, i + q.length) + '</mark>' + e.slice(i + q.length); };
  const artMenu = (anchor, a) => Z.menu(anchor, [
    { header: L('Chia sẻ', 'Share') },
    { label: L('Mở ở tab mới', 'Open in new tab'), icon: 'ext', href: `article.html#${a.id}` },
    { label: L('Sao chép Markdown', 'Copy Markdown'), icon: 'doc', on: () => Z.copy(`# ${a.title}\n\n${a.excerpt}\n\n${artUrl(a)}`) },
    { label: L('Sao chép link Markdown', 'Copy Markdown link'), icon: 'copy', on: () => Z.copy(`[${a.title}](${artUrl(a)})`) },
    ...(canRead(a) ? [{ label: L('Sao chép toàn văn (riêng tư)', 'Copy full text (private)'), small: L('chỉ dùng cho bạn', 'just for you'), icon: 'lock', on: () => { Z.copy(ZART.plainText(a)); Z.toast(L('Chỉ dùng cho bạn; đừng chia sẻ phần trả phí.', 'For you only; do not share paid content.'), 3600); } }] : []),
    { label: fmt(L('Hỏi {n} về bài này', 'Ask {n} about this post'), { n: 'Zuey AI' }), icon: 'spark', on: () => Z.ask(fmt(L('Tóm tắt giúp mình bài “{t}”', 'Summarize “{t}” for me'), { t: a.title })) },
    { label: L('Chia sẻ…', 'Share…'), icon: 'share', on: () => Z.share(artUrl(a), a.title) },
  ], { alignRight: true });
  W.reg('knowledges', {
    min: { w: 360, h: 360 },
    light: true,
    icon: () => '<span class="g paper">K</span>',
    title: (w) => (w.state.read ? `knowledges/${w.state.read}.md` : 'knowledges/'),
    rect: (aw, ah) => ({ w: 640, h: Math.min(ah - 14, 640) }),
    render(body, w, arg) {
      const st = w.state;
      if (arg && arg !== st.lastArg) { st.lastArg = arg; if (arg.read) { st.read = arg.read; if (!S.samples) Z.set({ samples: true }); } if (arg.q != null) { st.q = arg.q; st.read = null; } }
      st.cat = st.cat || 'all'; st.ent = st.ent || 'all'; st.sort = st.sort || 'new'; st.q = st.q || '';
      w.el.querySelector('.title').textContent = this.title(w);
      const a = st.read && SAMPLES.find((x) => x.id === st.read);
      if (a && S.samples) return this.reader(body, w, a);
      const list = S.samples ? SAMPLES.filter((x) => (st.cat === 'all' || x.cat === st.cat) && (st.ent === 'all' || (st.ent === 'paid') === x.paid) && (!st.q || `${x.title} ${x.excerpt} ${x.tags.join(' ')}`.toLowerCase().includes(st.q.toLowerCase()))) : [];
      list.sort((x, y) => st.sort === 'old' ? x.date.localeCompare(y.date) : st.sort === 'az' ? x.title.localeCompare(y.title, 'vi') : y.date.localeCompare(x.date));
      body.innerHTML = `${head("Zuey's Knowledges", L('Ghi chép của Duy', 'Duy\'s notes'), L('Ghi chép, biểu đồ, sơ đồ và khảo sát của Duy Nguyen.', 'Notes, charts, diagrams and surveys by Duy Nguyen.'))}
        <div class="kn-tools"><label class="sr" for="kn-q">${L('Tìm bài', 'Search posts')}</label><input id="kn-q" class="input" type="search" placeholder="${L('Tìm theo chủ đề, công cụ…', 'Search by topic, tool…')}" value="${esc(st.q)}">
          <button class="btn ghost" data-ft aria-expanded="${!!st.open}">${ic('filter')} ${L('Tìm & lọc', 'Search & filter')}</button></div>
        <div class="row small muted" style="margin-top:8px"><span class="tag">${L('Tìm theo từ khoá', 'Keyword search')}</span><span>${S.samples ? plural(list.length, 'bài', 'post') : ''}</span>${S.samples ? demoTag(L('Đang hiển thị bài mẫu', 'Showing sample posts')) : ''}</div>
        ${st.open ? `<div class="filters">
          <div><h4>${L('Chuyên mục', 'Category')}</h4><div class="row">${[['all', L('Tất cả', 'All')], ...CATS.map((c) => [c, c])].map(([v, t]) => `<button class="chip" data-cat="${esc(v)}" aria-pressed="${st.cat === v}">${esc(t)}</button>`).join('')}</div></div>
          <div><h4>${L('Nhãn & độ cập nhật', 'Labels & freshness')}</h4><div class="row">${[['all', L('Mọi nhãn', 'All labels')], ['free', L('Miễn phí', 'Free')], ['paid', L('Trả phí', 'Paid')]].map(([v, t]) => `<button class="chip" data-ent="${v}" aria-pressed="${st.ent === v}">${t}</button>`).join('')}</div></div>
          <div><h4>${L('Sắp xếp', 'Sort')}</h4><select class="select" data-sort>${[['new', L('Mới nhất', 'Newest')], ['old', L('Cũ nhất', 'Oldest')], ['az', 'A–Z'], ['rel', L('Liên quan nhất', 'Most relevant')]].map(([v, t]) => `<option value="${v}"${st.sort === v ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
          <div class="row" style="justify-content:flex-end"><button class="btn sm ghost" data-reset>${L('Đặt lại', 'Reset')}</button><button class="btn sm" data-apply>${L('Áp dụng', 'Apply')}</button></div></div>` : ''}
        <div class="arts">${!S.samples
          ? `<div class="empty"><span class="g paper">K</span><b>${L('Chưa có bài viết nào được xuất bản.', 'No posts published yet.')}</b><span class="small">${L('Đây là trạng thái thật của zuey.me hôm nay. Bật bài mẫu để xem thẻ bài, bộ lọc, trình đọc và paywall.', 'This is zuey.me today. Turn on sample posts to review cards, filters, the reader and the paywall.')}</span><button class="btn sm" data-samples>${L('Bật bài mẫu (demo)', 'Show sample posts (demo)')}</button></div>`
          : list.length ? list.map((x) => `<article class="art" data-read="${x.id}" tabindex="0" role="button" aria-label="${esc(x.title)}">
              <div class="top"><span class="ent ${x.paid ? 'paid' : 'free'}" aria-label="${x.paid ? L('Bài trả phí', 'Paid post') : L('Bài miễn phí', 'Free post')}">${ic(x.paid ? 'lock' : 'unlock')}</span><h3>${hl(x.title, st.q)}</h3><button class="icon-btn" data-amenu="${x.id}" aria-label="${L('Chia sẻ', 'Share')}">${ic('more')}</button></div>
              <p>${esc(x.excerpt)}</p>
              <div class="meta"><span class="tag">${esc(x.cat)}</span><span>${fmt(L('{n} phút', '{n} min'), { n: x.min })}</span><span>·</span><span>${Z.date(x.date)}</span>${x.tags.map((t) => `<span>#${t}</span>`).join('')}<span class="tag sample">${L('Mẫu', 'Sample')}</span></div></article>`).join('')
          : `<div class="empty">${L('Không có bài nào khớp bộ lọc. Thử bỏ bớt điều kiện.', 'No posts match. Try removing filters.')}</div>`}</div>
        ${S.samples ? `<div class="row" style="margin-top:14px;justify-content:space-between"><a class="btn sm ghost" href="https://zuey.me/knowledges" target="_blank" rel="noopener">${L('Xem tất cả bài viết', 'View all posts')} ↗</a><button class="btn sm ghost" data-samples>${L('Tắt bài mẫu', 'Hide samples')}</button></div>` : ''}`;
      const q = body.querySelector('#kn-q');
      q.oninput = () => { st.q = q.value; const pos = q.selectionStart; W.rerender('knowledges'); const n = body.querySelector('#kn-q'); n.focus(); n.setSelectionRange(pos, pos); };
      const sel = body.querySelector('[data-sort]'); if (sel) sel.onchange = () => { st.sort = sel.value; };
      body.onkeydown = (e) => { if (e.key === 'Enter' && e.target.dataset.read) { st.read = e.target.dataset.read; W.rerender('knowledges'); } };
      body.onclick = (e) => {
        const t = e.target.closest('button,[data-read]'); if (!t) return;
        const d = t.dataset;
        if (d.amenu) { e.stopPropagation(); return artMenu(t, SAMPLES.find((x) => x.id === d.amenu)); }
        if ('samples' in d) return Z.set({ samples: !S.samples });
        if ('ft' in d) { st.open = !st.open; return W.rerender('knowledges'); }
        if (d.cat) { st.cat = d.cat; return W.rerender('knowledges'); }
        if (d.ent) { st.ent = d.ent; return W.rerender('knowledges'); }
        if ('reset' in d) { Object.assign(st, { cat: 'all', ent: 'all', sort: 'new', q: '' }); return W.rerender('knowledges'); }
        if ('apply' in d) { st.open = false; return W.rerender('knowledges'); }
        if (d.read) { st.read = d.read; return W.rerender('knowledges'); }
      };
    },
    reader(body, w, a) {
      const acc = ZART.access(a, S), SEC = ZART.sections(a);
      const lc = acc.full ? null : ZART.lockCopy(acc, Z.planName());
      const pick = (x) => x[S.lang === 'vi' ? 0 : 1];
      const cta = lc ? `<div class="lockbox" role="region" aria-label="${esc(pick(lc.h))}"><span class="ent paid">${ic('lock')}</span><h3>${esc(pick(lc.h))}</h3><p class="small muted">${esc(pick(lc.p))}</p>
        <div class="row" style="justify-content:center">${acc.reason === 'guest' ? `<button class="btn" data-go="login">${L('Đăng ký miễn phí', 'Sign up free')}</button><button class="btn ghost" data-go="login">${L('Đăng nhập', 'Sign in')}</button>` : `<button class="btn" data-go="pricing">${acc.reason === 'plan' ? L('Nâng cấp gói', 'Upgrade plan') : L('Xem các gói', 'See plans')}</button>${Z.signedIn() ? '' : `<button class="btn ghost" data-go="login">${L('Đăng nhập', 'Sign in')}</button>`}`}</div>
        <p class="small muted">${fmt(L('Đang đọc phần xem trước · {n}/{t} phần bị khoá', 'Reading the preview · {n}/{t} sections locked'), { n: SEC.length - acc.open, t: SEC.length })}</p></div>` : '';
      body.innerHTML = `<article class="reader" lang="vi">
        <div class="rd-bar"><button class="btn sm ghost" data-back>${ic('back')} ${L('Tất cả bài', 'All posts')}</button><span class="mb-sp"></span>
          <a class="btn sm ghost" href="article.html#${a.id}" target="_blank" rel="noopener" title="${L('Trang bài viết riêng, có đủ thẻ SEO', 'Standalone article page with full SEO tags')}">${ic('ext')}<span>${L('Mở ở tab mới', 'Open in new tab')}</span></a>
          <button class="icon-btn" data-amenu aria-label="${L('Chia sẻ', 'Share')}" title="${L('Chia sẻ', 'Share')}">${ic('share')}</button></div>
        <div class="row" style="margin-top:14px"><span class="tag">${esc(a.cat)}</span><span class="tag ${a.paid ? 'paid' : 'free'}">${a.paid ? L('Trả phí', 'Paid') : L('Miễn phí', 'Free')}</span><span class="tag sample">${L('Nội dung mẫu', 'Sample content')}</span></div>
        <h1>${esc(a.title)}</h1>
        <div class="meta"><img class="au" src="assets/avatar.png" alt=""><span>Duy Nguyen</span><span>·</span><time datetime="${a.date}">${Z.date(a.date)}</time>${a.updated !== a.date ? `<span>·</span><span>${L('cập nhật', 'updated')} <time datetime="${a.updated}">${Z.date(a.updated)}</time></span>` : ''}<span>·</span><span>${fmt(L('{n} phút đọc', '{n} min read'), { n: a.min })}</span></div>
        <aside class="tldr"><b>TL;DR</b><p>${esc(a.tldr)}</p></aside>
        <nav class="toc-chips" aria-label="${L('Trong bài', 'In this post')}">${SEC.map((s, i) => `<button data-to="${s.id}"${i >= acc.open ? ` class="lk" title="${L('Bị khoá', 'Locked')}"` : ''}>${i >= acc.open ? ic('lock') : ''}${esc(s.h)}</button>`).join('')}<button data-to="faq">FAQ</button></nav>
        <div class="prose">${ZART.bodyHTML(a, acc, cta)}</div>
        <section class="takeaways" aria-labelledby="tk-h"><h2 id="tk-h">${L('Ý chính', 'Key takeaways')}</h2><ul>${a.takeaways.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></section>
        <section class="faq" id="faq" aria-labelledby="faq-h"><h2 id="faq-h">${L('Câu hỏi thường gặp', 'FAQ')}</h2>${a.faq.map(([q, x]) => `<details><summary>${esc(q)}</summary><p>${esc(x)}</p></details>`).join('')}</section>
        <div class="rd-foot"><img src="assets/avatar.png" alt=""><div><b>Duy Nguyen</b><span>${L('Viết về AI engineering, sản phẩm và build in public.', 'Writes about AI engineering, products and building in public.')}</span></div><button class="btn sm" data-askart>${ic('spark')} ${fmt(L('Hỏi {n} về bài này', 'Ask {n}'), { n: 'Zuey AI' })}</button></div>
      </article>`;
      body.scrollTop = 0;
      const sv = body.querySelector('[data-survey]');
      if (sv) sv.onchange = () => sv.querySelectorAll('label').forEach((l) => { const p = l.querySelector('.pct'); p.textContent = p.dataset.p + '%'; l.querySelector('.fill').style.width = p.dataset.p + '%'; });
      body.onclick = (e) => {
        const t = e.target.closest('button'); if (!t) return;
        const d = t.dataset;
        if ('back' in d) { w.state.read = null; return W.rerender('knowledges'); }
        if ('amenu' in d) return artMenu(t, a);
        if ('askart' in d) return Z.ask(fmt(L('Tóm tắt giúp mình bài “{t}”', 'Summarize “{t}” for me'), { t: a.title }));
        if (d.to) { const s = body.querySelector('#' + d.to); if (s) s.scrollIntoView({ behavior: Z.reduced ? 'auto' : 'smooth', block: 'start' }); return; }
        if (d.go) return W.open(d.go);
      };
    },
  });

  /* ======================= Appearance: mode, accent, wallpaper ======================= */
  const WPS = () => [['gradient', L('Than hồng', 'Ember')], ['dusk', L('Hoàng hôn', 'Dusk')], ['forest', L('Rừng', 'Forest')], ['ocean', L('Biển', 'Ocean')], ['aurora', L('Cực quang', 'Aurora')], ['mono', L('Trơn', 'Plain')], ['video', L('Video loop', 'Video loop')], ['image', L('Ảnh của bạn', 'Your photo')]];
  const ACC_N = () => ({ ember: L('Cam đất', 'Ember'), rose: L('Hồng', 'Rose'), violet: L('Tím', 'Violet'), ocean: L('Xanh biển', 'Ocean'), forest: L('Xanh lá', 'Forest'), amber: L('Hổ phách', 'Amber') });
  const MODES = () => [['dark', L('Tối', 'Dark')], ['light', L('Sáng', 'Light')], ['auto', L('Theo hệ thống', 'System')]];
  /* used by the window, the desktop drop target and the file picker */
  Z.useWallFile = (file, at) => Z.wallFromFile(file).then((r) => {
    Z.setLook({ bg: 'image' }, at);
    if (!r.saved) Z.toast(L('Ảnh quá lớn để lưu: chỉ dùng trong phiên này.', 'Too large to keep: used for this session only.'), 3600);
  }).catch((e) => Z.toast(e.message === 'type' ? L('Hãy chọn một tệp ảnh.', 'Pick an image file.') : L('Không đọc được ảnh này.', 'Could not read this image.'), 3200));
  W.reg('appearance', {
    min: { w: 340, h: 380 },
    icon: () => `<span class="g look">${ic('palette')}</span>`,
    title: () => 'appearance.prefs',
    rect: (aw, ah) => ({ w: 580, h: Math.min(ah - 14, 660) }),
    render(body) {
      const img = Z.wallImg(), cur = S.bg === 'image' && !img ? 'gradient' : S.bg;
      body.innerHTML = `${head(L('Giao diện', 'Appearance'), L('Giao diện & hình nền', 'Look & wallpaper'), L('Đổi chế độ sáng tối, màu nhấn và hình nền. Lưu trên thiết bị này.', 'Switch light or dark, accent and wallpaper. Saved on this device.'))}
        <section class="ap-sec"><h3 id="ap-mode">${L('Chế độ', 'Mode')} <span class="kbh">${Z.kbd('Alt T')}</span></h3>
          <div class="ap-modes" role="radiogroup" aria-labelledby="ap-mode">${MODES().map(([v, t]) => `<button role="radio" aria-checked="${(S.theme || 'dark') === v}" data-mode="${v}"><span class="ap-prev ${v}" aria-hidden="true"><i></i><b></b><em></em></span><span>${t}</span></button>`).join('')}</div></section>
        <section class="ap-sec"><h3 id="ap-acc">${L('Màu nhấn', 'Accent')}</h3>
          <div class="ap-acc" role="radiogroup" aria-labelledby="ap-acc">${Object.entries(Z.ACCENTS).map(([k, c]) => `<button role="radio" aria-checked="${(S.accent || 'ember') === k}" data-accent="${k}" style="--sw:${c[0]};--sw2:${c[2]}" aria-label="${ACC_N()[k]}" title="${ACC_N()[k]}"></button>`).join('')}<span class="small muted">${ACC_N()[S.accent || 'ember']}</span></div></section>
        <section class="ap-sec"><h3 id="ap-wp">${L('Hình nền', 'Wallpaper')}</h3>
          <div class="ap-wps" role="radiogroup" aria-labelledby="ap-wp">${WPS().map(([v, t]) => `<button role="radio" aria-checked="${cur === v}" data-pick="${v}"><span class="wp-th" data-wp="${v}"${v === 'image' && img ? ` style="--wp-img:url('${img}')"` : ''}>${v === 'video' ? '<video src="assets/loop.mp4" muted loop playsinline autoplay preload="metadata" aria-hidden="true"></video>' : ''}${v === 'image' && !img ? ic('upload') : ''}</span><span>${t}</span></button>`).join('')}</div>
          <div class="row" style="margin-top:12px"><label class="btn sm ghost">${ic('upload')} ${img ? L('Đổi ảnh…', 'Change photo…') : L('Tải ảnh lên…', 'Upload a photo…')}<input type="file" accept="image/*" class="sr" data-file></label><span class="small muted">${L('hoặc kéo thả một ảnh vào màn hình', 'or drop an image anywhere on the desktop')}</span></div>
          ${['image', 'video'].includes(cur) ? `<label class="f ap-dim"><span>${L('Làm tối hình nền', 'Dim wallpaper')} <output>${S.wpDim == null ? 30 : S.wpDim}%</output></span><input type="range" min="0" max="70" step="5" value="${S.wpDim == null ? 30 : S.wpDim}" data-dim></label>` : ''}</section>
        <div class="row" style="justify-content:space-between;margin-top:14px"><span class="small muted">${L('Ảnh tải lên chỉ nằm trong trình duyệt này.', 'Uploaded photos stay in this browser.')}</span><button class="btn sm ghost" data-reset>${L('Khôi phục mặc định', 'Restore defaults')}</button></div>`;
      const refocus = (sel) => requestAnimationFrame(() => { const b = document.querySelector(`.win[data-id="appearance"] ${sel}`); if (b) b.focus({ preventScroll: true }); });
      body.onclick = (e) => {
        const t = e.target.closest('button'); if (!t) return;
        const d = t.dataset, at = Z.centerOf(t);
        if (d.mode) { Z.setLook({ theme: d.mode }, at); return refocus(`[data-mode="${d.mode}"]`); }
        if (d.accent) { Z.setLook({ accent: d.accent }, at); return refocus(`[data-accent="${d.accent}"]`); }
        if (d.pick) {
          if (d.pick === 'image' && !Z.wallImg()) return body.querySelector('[data-file]').click();
          Z.setLook({ bg: d.pick }, at); return refocus(`[data-pick="${d.pick}"]`);
        }
        if ('reset' in d) Z.setLook({ theme: 'dark', accent: 'ember', bg: 'gradient', wpDim: 30 }, at);
      };
      /* arrow keys move inside each radio group, like native radios */
      body.onkeydown = (e) => {
        const t = e.target.closest('[role=radio]'); if (!t) return;
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key]; if (!step) return;
        e.preventDefault();
        const all = [...t.parentElement.querySelectorAll('[role=radio]')], n = all[(all.indexOf(t) + step + all.length) % all.length];
        n.focus(); n.click();
      };
      body.querySelector('[data-file]').onchange = (e) => { const f = e.target.files[0]; if (f) Z.useWallFile(f, Z.centerOf(e.target.parentElement)); };
      const dim = body.querySelector('[data-dim]');
      if (dim) {
        dim.oninput = () => { document.getElementById('desk').style.setProperty('--dim', dim.value); dim.previousElementSibling.querySelector('output').textContent = dim.value + '%'; };
        dim.onchange = () => { S.wpDim = +dim.value; Z.lsSet('zos_demo_v1', S); };
      }
    },
  });

  /* ======================= Zuey Reads ======================= */
  const readDate = (r) => { const d = new Date(r.published || r.created_at); return isNaN(d) ? new Date(r.created_at) : d; };
  W.reg('reads', {
    min: { w: 300, h: 320 },
    light: true,
    icon: () => `<span class="g reads">${ic('book')}</span>`,
    title: () => 'zuey-reads/',
    rect: (aw, ah) => ({ x: aw >= 1400 ? 468 + Math.min(540, aw - 918) : Math.round((aw - 330) / 2), y: 14, w: 330, h: Math.min(ah - 14, 600) }),
    render(body, w) {
      const st = w.state; st.src = st.src || 'all';
      const items = D.reads.items.filter((r) => st.src === 'all' || r.source_kind === st.src);
      const SRC = { web: 'Web', x: 'X', youtube: 'YouTube' };
      body.innerHTML = `${head('Zuey Reads', L('Zuey đang đọc', 'Zuey is reading'), L('Tóm tắt những gì mình đọc.', 'Summaries of what I read.'))}
        <p class="small muted" style="margin-top:4px">${fmt(L('Đồng bộ {t}', 'Synced {t}'), { t: Z.date(D.reads.last_synced_at, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) })}</p>
        <div class="row" style="margin:12px 0 6px" role="group" aria-label="${L('Lọc theo nguồn', 'Filter by source')}"><button class="chip" data-src="all" aria-pressed="${st.src === 'all'}">${L('Tất cả', 'All')} ${D.reads.items.length}</button>${D.reads.sources.map((s) => `<button class="chip" data-src="${s.source_kind}" aria-pressed="${st.src === s.source_kind}">${SRC[s.source_kind] || s.source_kind} ${s.count}</button>`).join('')}</div>
        <div>${items.map((r) => `<article class="read"><img src="${esc(r.cover)}" alt="" loading="lazy"><div style="min-width:0">
          <h3><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></h3>
          <div class="meta"><span class="tag">${SRC[r.source_kind] || r.source_kind}</span><span>${esc(r.domain)}</span>${r.author ? `<span>· ${esc(r.author)}</span>` : ''}<span>· ${Z.date(readDate(r))}</span>${r.word_count ? `<span>· ${fmt(L('{n} phút', '{n} min'), { n: Math.max(1, Math.round(r.word_count / 230)) })}</span>` : ''}</div>
          <details><summary>${L('Tóm tắt', 'Summary')}</summary><p>${esc(r.summary || r.description)}</p></details>
          <div class="acts"><a class="btn sm ghost" href="${esc(r.url)}" target="_blank" rel="noopener">${ic('ext')} ${L('Bài gốc', 'Original')}</a><button class="btn sm ghost" data-ask="${esc(r.title)}">${ic('spark')} ${L('Hỏi Zuey AI', 'Ask Zuey AI')}</button></div></div></article>`).join('')}</div>
        <a class="btn sm ghost" style="margin-top:10px" href="https://zuey.me/reads" target="_blank" rel="noopener">${L('Mở trang Reads', 'Open Reads page')} ↗</a>`;
      body.onclick = (e) => {
        const t = e.target.closest('button'); if (!t) return;
        if (t.dataset.src) { st.src = t.dataset.src; W.rerender('reads'); }
        if (t.dataset.ask) Z.ask(fmt(L('Bài “{t}” nói gì và mình áp dụng được gì?', 'What does “{t}” say and how can I use it?'), { t: t.dataset.ask }));
      };
    },
  });

  /* ======================= AI Workflows ======================= */
  W.reg('workflows', {
    min: { w: 320, h: 300 },
    light: true,
    icon: () => `<span class="g flow">${ic('flow')}</span>`,
    title: () => 'ai-workflows/',
    rect: () => ({ w: 480, h: 400 }),
    render(body) {
      body.innerHTML = `${head(L('Workflow AI', 'AI workflows'), L('Cách mình làm việc với AI', 'How I work with AI'))}
        <div class="empty"><span class="g flow">${ic('flow')}</span><b>${L('Chưa có workflow nào được xuất bản.', 'No workflows published yet.')}</b>
        <span class="small">${L('Khi Duy xuất bản, mỗi workflow là một bài có sơ đồ từng bước, công cụ dùng và prompt mẫu.', 'Once published, each workflow is a post with a step diagram, tools and sample prompts.')}</span>
        <div class="row" style="justify-content:center"><button class="btn sm" data-ask>${ic('spark')} ${L('Hỏi Zuey AI', 'Ask Zuey AI')}</button><button class="btn sm ghost" data-mcp>${ic('plug')} ${L('Kết nối qua MCP', 'Connect via MCP')}</button></div></div>`;
      body.onclick = (e) => { const t = e.target.closest('button'); if (!t) return; if ('ask' in t.dataset) Z.ask(L('Duy dùng AI trong công việc hằng ngày thế nào?', 'How does Duy use AI day to day?')); if ('mcp' in t.dataset) W.open('mcp'); };
    },
  });

  /* ======================= Membership pricing (PricingTable + VietQR order) ======================= */
  W.reg('pricing', {
    min: { w: 360, h: 400 },
    light: true,
    icon: () => '<span class="g price">$</span>',
    title: () => 'membership.pkg',
    rect: (aw, ah) => ({ w: Math.min(960, aw - 140), h: Math.min(ah - 14, 700) }),
    render(body, w) {
      const st = w.state; st.term = st.term || 1;
      const P = D.plans;
      if (st.order) return this.order(body, w);
      body.innerHTML = `<div class="pr-head">
          <div>${head(L('Thành viên', 'Membership'), L('Đọc, hỏi và kết nối', 'Read, ask and connect'))}</div>
          <div class="seg terms" role="group" aria-label="${L('Kỳ hạn', 'Term')}">${P.months.map((m) => { const dp = P.plans[0].prices.find((x) => x.months === m).discount_percent; return `<button data-term="${m}" aria-pressed="${st.term === m}">${fmt(L('{n} tháng', '{n} mo'), { n: m })}${dp ? `<span class="disc">−${dp}%</span>` : ''}</button>`; }).join('')}</div></div>
        <div class="plans">${P.plans.map((p) => {
          const pr = p.prices.find((x) => x.months === st.term), full = p.prices[0].amount_vnd * st.term;
          const mine = Z.signedIn() && S.plan === p.id;
          return `<div class="plan${mine ? ' cur' : p.id === 'combo' ? ' pop-plan' : ''}">
            <div class="row" style="justify-content:space-between"><h3>${esc(p.name)}</h3>${mine ? `<span class="tag free">${L('Gói hiện tại', 'Current plan')}</span>` : p.id === 'combo' ? `<span class="tag paid">${L('Phổ biến', 'Popular')}</span>` : ''}</div>
            <div class="tg">${esc(p.tagline)}</div>
            <div class="pr">${Z.usd(Math.round(pr.amount_usd_cents / st.term))}<small>/${L('tháng', 'mo')}</small></div>
            <div class="tot">${st.term > 1 ? `<s>${Z.vnd(full)}</s> ` : ''}<b>${Z.vnd(pr.amount_vnd)}</b> ${fmt(L('cho {n} tháng', 'for {n} months'), { n: st.term })}</div>
            ${p.ai_budget_usd_cents ? `<div class="small muted">${fmt(L('Ngân sách AI {b}/tháng', 'AI budget {b}/month'), { b: Z.usd(p.ai_budget_usd_cents) })}</div>` : ''}
            <ul>${p.features.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
            <button class="btn block" data-buy="${p.id}"${st.creating ? ' disabled' : ''}>${st.creating === p.id ? L('Đang tạo đơn…', 'Creating order…') : fmt(L('Chọn {plan} · VietQR', 'Choose {plan} · VietQR'), { plan: p.name })}</button>
            ${P.card_plans.includes(p.id) ? `<button class="btn ghost block">${L('Thẻ quốc tế (USD, Dodo)', 'International card (USD, Dodo)')}</button>` : ''}</div>`;
        }).join('')}</div>
        <p class="note" style="margin-top:14px">${L('Áp dụng cho chuyển khoản ngân hàng (VietQR): trả trước, không tự động gia hạn; giảm giá khi trả trước: 3 tháng −5%, 6 tháng −10%, 12 tháng −20%.', 'Bank transfer (VietQR): prepaid, no auto-renew; prepay discounts: 3 months −5%, 6 months −10%, 12 months −20%.')}</p>
        <p class="small muted" style="margin-top:10px">${L('Giá niêm yết bằng USD; số tiền chuyển khoản tính theo VND (làm tròn lên 1.000 ₫ mỗi tháng). Gói được kích hoạt ngay khi hệ thống nhận được chuyển khoản, và cộng dồn nếu bạn gia hạn sớm.', 'Prices are listed in USD; transfers are in VND (rounded up to 1,000 ₫ per month). Plans activate as soon as the transfer arrives and stack if you renew early.')} ${fmt(L('Tỉ giá {r} ₫/USD.', 'Rate {r} ₫/USD.'), { r: P.usd_vnd_rate.toLocaleString('vi-VN') })}</p>
        <p class="small muted" style="margin-top:6px">${L('Thẻ quốc tế (Dodo) đang chờ duyệt nên chưa có nút thanh toán thẻ, giống trang thật.', 'International cards (Dodo) are pending approval, so there is no card button, same as live.')}</p>
        <div class="biz-hero biz-cta"><div><div class="eyebrow">${L('Dành cho doanh nghiệp', 'For business')}</div><b style="font:800 18px var(--serif)">${L('Đưa AI vào công việc thật', 'Put AI to real work')}</b><p class="small muted">${L('Tư vấn một lần $1,999. Toàn bộ $1,999 được trừ vào gói đồng hành 3–6 tháng (phạm vi thống nhất riêng).', 'One-off consulting $1,999, fully credited toward a 3–6 month engagement (scope agreed separately).')}</p></div><button class="btn" data-biz>${L('Tư vấn doanh nghiệp', 'Business consulting')}</button></div>`;
      body.onclick = (e) => {
        const t = e.target.closest('button'); if (!t) return;
        if (t.dataset.term) { st.term = +t.dataset.term; return W.rerender('pricing'); }
        if ('biz' in t.dataset) return W.open('business');
        if (t.dataset.buy) {
          if (!Z.signedIn()) { Z.toast(L('Đăng nhập để tạo đơn chuyển khoản.', 'Sign in to create a transfer order.')); return W.open('login', { next: 'pricing' }); }
          st.creating = t.dataset.buy; W.rerender('pricing');
          setTimeout(() => {
            const p = D.plans.plans.find((x) => x.id === st.creating), pr = p.prices.find((x) => x.months === st.term);
            st.order = { plan: p.id, months: st.term, vnd: pr.amount_vnd, code: 'ZUEY' + Math.random().toString(36).slice(2, 8).toUpperCase(), at: Date.now(), status: 'pending' };
            st.creating = null; W.rerender('pricing');
          }, 900);
        }
      };
    },
    order(body, w) {
      const o = w.state.order, p = Z.plan(o.plan);
      const paid = o.status === 'paid';
      body.innerHTML = `<button class="btn sm ghost" data-back>${ic('back')} ${L('Bảng giá', 'Plans')}</button>
        <div style="max-width:520px;margin:12px auto 0" class="stack">
          ${head('VietQR', fmt(L('Đơn {plan} · {n} tháng', '{plan} order · {n} months'), { plan: esc(p.name), n: o.months }))}
          ${paid ? `<div class="note ok" role="status"><b>${L('Đã nhận chuyển khoản.', 'Transfer received.')}</b> ${fmt(L('Gói {plan} đang hoạt động tới {d}.', '{plan} is active until {d}.'), { plan: esc(p.name), d: Z.date(Date.now() + o.months * 30 * 864e5) })}${o.plan === 'community' ? ' ' + L('Lời mời nhóm Telegram nằm trong Tài khoản → Gói.', 'Your Telegram invite is in Account → Plan.') : ''}</div>
            <div class="row"><button class="btn" data-go="account">${L('Mở Tài khoản', 'Open account')}</button>${o.plan === 'knowledges' ? `<button class="btn ghost" data-go="knowledges">${L('Đọc bài viết', 'Read articles')}</button>` : `<button class="btn ghost" data-go="ai">${L('Chat với Zuey AI', 'Chat with Zuey AI')}</button>`}</div>`
          : `<div class="payrow"><div class="qr" data-q></div>
            <dl class="kv"><dt>${L('Ngân hàng', 'Bank')}</dt><dd>${L('(ẩn trong demo)', '(hidden in demo)')}</dd><dt>${L('Số tài khoản', 'Account')}</dt><dd>${L('(ẩn trong demo)', '(hidden in demo)')}</dd><dt>${L('Số tiền', 'Amount')}</dt><dd><b>${Z.vnd(o.vnd)}</b></dd><dt>${L('Nội dung', 'Reference')}</dt><dd class="mono"><b>${o.code}</b> <button class="btn sm ghost" data-cp="${o.code}">${ic('copy')}</button></dd></dl></div>
            <p class="note">${L('Quét mã bằng app ngân hàng và giữ nguyên nội dung chuyển khoản. Gói được kích hoạt ngay khi hệ thống nhận được tiền; trang này tự cập nhật.', 'Scan with your bank app and keep the reference unchanged. The plan activates as soon as funds arrive; this page updates itself.')}</p>
            <p class="small muted">${L('Mã QR trong demo chỉ chứa mã đơn mẫu, không phải tài khoản thật.', 'The demo QR only encodes a sample order code, not a real account.')}</p>
            <div class="row"><button class="btn acc" data-paid>${L('Mô phỏng: hệ thống nhận chuyển khoản', 'Simulate: transfer received')}</button><button class="btn ghost" data-back>${L('Huỷ đơn', 'Cancel order')}</button></div>`}
        </div>`;
      const q = body.querySelector('[data-q]'); if (q) Z.renderQr(q, `ZUEY-DEMO|${o.code}|${o.vnd}`);
      body.onclick = (e) => {
        const t = e.target.closest('button'); if (!t) return;
        if ('back' in t.dataset) { w.state.order = null; return W.rerender('pricing'); }
        if (t.dataset.cp) return Z.copy(t.dataset.cp);
        if (t.dataset.go) return W.open(t.dataset.go);
        if ('paid' in t.dataset) {
          o.status = 'paid';
          Z.set({ role: Z.isAdmin() ? 'admin' : 'member', plan: o.plan, orders: [{ code: o.code, plan: o.plan, months: o.months, vnd: o.vnd, at: Date.now(), status: 'paid' }, ...(S.orders || [])].slice(0, 5) });
          Z.M.react('happy'); Z.M.say(fmt(L('Chào mừng thành viên {plan}!', 'Welcome, {plan} member!'), { plan: p.name }));
        }
      };
    },
  });

  /* ======================= Business consulting (BookingWidget) ======================= */
  const SLOT_HM = [[9, 0], [10, 30], [14, 0], [15, 30]];
  const slotsAll = () => {
    const out = [], now = Date.now();
    for (let i = 1; i <= 60; i++) {
      const d = new Date(now + i * 864e5);
      const ict = new Date(d.getTime() + 7 * 36e5); const wd = ict.getUTCDay();
      if (wd !== 2 && wd !== 4) continue;
      SLOT_HM.forEach(([h, m]) => out.push(Date.UTC(ict.getUTCFullYear(), ict.getUTCMonth(), ict.getUTCDate(), h - 7, m)));
    }
    return out;
  };
  const dayKey = (t, tz) => new Date(t).toLocaleDateString('en-CA', { timeZone: tz });
  W.reg('business', {
    min: { w: 360, h: 420 },
    light: true,
    icon: () => `<span class="g biz">${ic('brief')}</span>`,
    title: () => 'business.pkg',
    rect: (aw, ah) => ({ w: 640, h: Math.min(ah - 14, 720) }),
    onClose(w) { clearInterval(w.state.cd); },
    render(body, w) {
      const b = (w.state.bk = w.state.bk || { step: 1, tz: Z.TZ, method: 'sepay', form: {} });
      const tzs = [...new Set([Z.TZ, Intl.DateTimeFormat().resolvedOptions().timeZone, 'Asia/Singapore', 'Europe/London', 'America/Los_Angeles'])];
      const slots = slotsAll(), byDay = {};
      slots.forEach((t) => (byDay[dayKey(t, b.tz)] = byDay[dayKey(t, b.tz)] || []).push(t));
      if (!b.month) { const f = Object.keys(byDay)[0]; b.month = f ? f.slice(0, 7) : dayKey(Date.now(), b.tz).slice(0, 7); }
      const steps = [L('Chọn giờ', 'Pick a time'), L('Thông tin', 'Details'), L('Thanh toán', 'Payment'), L('Xác nhận', 'Confirmed')];
      const tfmt = (t) => new Date(t).toLocaleTimeString('vi-VN', { timeZone: b.tz, hour: '2-digit', minute: '2-digit' });
      const dfmt = (t) => new Date(t).toLocaleDateString(S.lang === 'vi' ? 'vi-VN' : 'en-GB', { timeZone: b.tz, weekday: 'long', day: 'numeric', month: 'numeric' });
      let step = '';
      if (b.step === 1) {
        const [y, m] = b.month.split('-').map(Number);
        const first = new Date(Date.UTC(y, m - 1, 1)), days = new Date(Date.UTC(y, m, 0)).getUTCDate(), lead = (first.getUTCDay() + 6) % 7;
        const cells = Array(lead).fill('<span></span>').concat(Array.from({ length: days }, (_, i) => {
          const k = `${b.month}-${String(i + 1).padStart(2, '0')}`, av = !!byDay[k];
          return `<button class="${av ? 'av' : ''}" ${av ? `data-day="${k}"` : 'disabled'} aria-pressed="${b.day === k}" aria-label="${k}${av ? ' · ' + L('có lịch', 'available') : ''}">${i + 1}</button>`;
        }));
        const mLabel = first.toLocaleDateString(S.lang === 'vi' ? 'vi-VN' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
        step = `<div class="row" style="justify-content:space-between"><button class="icon-btn" data-mon="-1" aria-label="${L('Tháng trước', 'Previous month')}">‹</button><b style="text-transform:capitalize">${mLabel}</b><button class="icon-btn" data-mon="1" aria-label="${L('Tháng sau', 'Next month')}">›</button></div>
          <div class="cal" style="margin-top:8px">${(S.lang === 'vi' ? ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'] : ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']).map((d) => `<span class="dow">${d}</span>`).join('')}${cells.join('')}</div>
          <label class="f" style="margin-top:12px">${L('Múi giờ hiển thị', 'Display time zone')}<select class="select" data-tz>${tzs.map((z) => `<option${z === b.tz ? ' selected' : ''}>${z}</option>`).join('')}</select></label>
          <h4 style="margin:14px 0 8px;font:700 14px var(--sans)">${b.day ? L('Khung giờ trống', 'Open slots') + ' · ' + dfmt(byDay[b.day][0]) : L('Chọn một ngày có lịch', 'Pick a day with openings')}</h4>
          ${b.day ? `<div class="slots">${byDay[b.day].map((t) => `<button data-slot="${t}" aria-pressed="${b.slot === t}">${tfmt(t)}</button>`).join('')}</div>` : ''}
          <p class="small muted" style="margin-top:8px">${demoTag(L('Lịch mẫu', 'Sample availability'))} ${L('Lịch thật lấy từ /api/v1/booking/availability (60 ngày tới).', 'Live availability comes from /api/v1/booking/availability (next 60 days).')}</p>
          <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn" data-next${b.slot ? '' : ' disabled'}>${L('Tiếp tục', 'Continue')}</button></div>`;
      } else if (b.step === 2) {
        const f = b.form;
        step = `<form class="stack" data-form novalidate>
          <p class="small muted">${dfmt(b.slot)} · ${tfmt(b.slot)} (${b.tz})</p>
          <label class="f">${L('Họ tên *', 'Full name *')}<input class="input" name="name" required value="${esc(f.name || '')}" autocomplete="name"></label>
          <label class="f">Email *<input class="input" name="email" type="email" required value="${esc(f.email || S.email || '')}" autocomplete="email"></label>
          <label class="f">${L('Công ty', 'Company')}<input class="input" name="company" value="${esc(f.company || '')}" autocomplete="organization"></label>
          <label class="f">${L('Bạn muốn giải quyết vấn đề gì?', 'What do you want to solve?')}<textarea class="textarea" name="problem">${esc(f.problem || '')}</textarea></label>
          <p class="note err" data-err hidden></p>
          <div class="row" style="justify-content:space-between"><button type="button" class="btn ghost" data-prev>${ic('back')} ${L('Chọn lại giờ', 'Pick another time')}</button><button class="btn">${L('Tiếp tục', 'Continue')}</button></div></form>`;
      } else if (b.step === 3 && !b.hold) {
        step = `<div class="stack"><p class="small muted">${dfmt(b.slot)} · ${tfmt(b.slot)} · ${esc(b.form.name)}</p>
          ${[['sepay', L('Chuyển khoản VietQR (SePay)', 'Bank transfer VietQR (SePay)'), Z.vnd(1999 * D.plans.usd_vnd_rate)], ['paypal', L('Thẻ quốc tế / PayPal (USD)', 'Card / PayPal (USD)'), '$1,999']].map(([v, t, s]) => `<label class="meth"><input type="radio" name="m" value="${v}"${b.method === v ? ' checked' : ''}><div><b>${t}</b><span>${s}</span></div></label>`).join('')}
          <p class="note">${L('Khi bấm, khung giờ được giữ cho bạn 15 phút để thanh toán. Hết 15 phút chưa thanh toán, chỗ sẽ được nhả.', 'Your slot is held for 15 minutes while you pay. Unpaid holds are released after that.')}</p>
          <div class="row" style="justify-content:space-between"><button class="btn ghost" data-back2>${ic('back')} ${L('Thông tin', 'Details')}</button><button class="btn acc" data-hold>${L('Giữ chỗ & thanh toán', 'Hold & pay')}</button></div></div>`;
      } else if (b.step === 3) {
        const h = b.hold, left = Math.max(0, h.until - Date.now()), expired = left === 0;
        step = `<div class="stack"><div class="row" style="justify-content:space-between"><span class="tag ${expired ? '' : 'paid'}">${expired ? L('Hết hạn giữ chỗ', 'Hold expired') : L('Đang giữ chỗ — chờ thanh toán', 'Held — awaiting payment')}</span><span class="mono small">${h.code}</span></div>
          <div class="timer" data-timer aria-live="off">${String(Math.floor(left / 6e4)).padStart(2, '0')}:${String(Math.floor(left / 1e3) % 60).padStart(2, '0')}</div>
          <p class="small muted" style="text-align:center">${dfmt(b.slot)} · ${tfmt(b.slot)} (${b.tz})</p>
          ${expired ? `<button class="btn" data-restart>${L('Chọn lại giờ', 'Pick another time')}</button>` : b.method === 'sepay'
            ? `<div class="payrow"><div class="qr" data-q></div><dl class="kv"><dt>${L('Ngân hàng', 'Bank')}</dt><dd>${L('(ẩn trong demo)', '(hidden in demo)')}</dd><dt>${L('Số tài khoản', 'Account')}</dt><dd>${L('(ẩn trong demo)', '(hidden in demo)')}</dd><dt>${L('Số tiền', 'Amount')}</dt><dd><b>${Z.vnd(1999 * D.plans.usd_vnd_rate)}</b></dd><dt>${L('Nội dung', 'Reference')}</dt><dd class="mono"><b>${h.code}</b></dd></dl></div>
               <div class="row"><button class="btn acc" data-pay>${L('Mô phỏng: đã nhận chuyển khoản', 'Simulate: transfer received')}</button><button class="btn ghost" data-restart>${L('Chọn lại giờ', 'Pick another time')}</button></div>`
            : `<button class="btn acc block" data-pay style="background:#0070ba">${L('Thanh toán $1,999 qua PayPal', 'Pay $1,999 with PayPal')}</button><p class="small muted">${L('Demo không mở PayPal; nút sẽ mô phỏng thanh toán thành công.', 'The demo does not open PayPal; the button simulates success.')}</p><button class="btn ghost" data-restart>${L('Chọn lại giờ', 'Pick another time')}</button>`}</div>`;
      } else {
        step = `<div class="stack" style="text-align:center;justify-items:center"><span class="ent free" style="width:48px;height:48px">${ic('check')}</span><h3 style="font:800 22px var(--serif)">${L('Đã xác nhận', 'Confirmed')}</h3>
          <p>${dfmt(b.slot)} · ${tfmt(b.slot)} (${b.tz})</p><p class="small muted">${fmt(L('Mã đặt lịch {c}. Chi tiết được gửi tới {e}.', 'Booking {c}. Details sent to {e}.'), { c: b.hold.code, e: esc(b.form.email) })}</p>
          <p class="small muted">${L('$1,999 được trừ vào gói đồng hành 3–6 tháng nếu bạn tiếp tục.', 'The $1,999 is credited toward a 3–6 month engagement if you continue.')}</p>
          <button class="btn ghost" data-restart>${L('Đặt lịch khác', 'Book another')}</button></div>`;
      }
      body.innerHTML = `<div class="biz-hero"><div class="eyebrow">${L('Dành cho doanh nghiệp', 'For business')}</div><h2 class="h2">${L('Đưa AI vào công việc thật', 'Put AI to real work')}</h2>
          <p class="lead">${L('Tư vấn một lần $1,999. Toàn bộ $1,999 được trừ vào gói đồng hành 3–6 tháng (phạm vi thống nhất riêng).', 'One-off consulting $1,999, fully credited toward a 3–6 month engagement (scope agreed separately).')}</p>
          <p class="credit">${L('Một buổi 1:1 với Duy: rà quy trình, chọn việc nên giao cho AI, dựng thử workflow đầu tiên và kế hoạch 90 ngày.', 'One 1:1 session with Duy: audit workflows, pick what to hand to AI, prototype the first workflow and a 90-day plan.')}</p></div>
        <h3 style="font:800 18px var(--serif);margin-top:18px">${L('Đặt lịch tư vấn', 'Book a consultation')}</h3>
        <ol class="steps">${steps.map((s, i) => `<li${i + 1 === b.step ? ' aria-current="step"' : i + 1 < b.step ? ' class="done"' : ''}>${i + 1}. ${s}</li>`).join('')}</ol>${step}`;
      const q = body.querySelector('[data-q]'); if (q) Z.renderQr(q, `ZUEY-DEMO|${b.hold.code}|BOOKING`);
      clearInterval(w.state.cd);
      if (b.step === 3 && b.hold && b.hold.until > Date.now()) w.state.cd = setInterval(() => {
        const el = body.querySelector('[data-timer]'); const left = Math.max(0, b.hold.until - Date.now());
        if (!el || !el.isConnected) return clearInterval(w.state.cd);
        el.textContent = `${String(Math.floor(left / 6e4)).padStart(2, '0')}:${String(Math.floor(left / 1e3) % 60).padStart(2, '0')}`;
        if (!left) { clearInterval(w.state.cd); W.rerender('business'); }
      }, 1000);
      const tzSel = body.querySelector('[data-tz]'); if (tzSel) tzSel.onchange = () => { b.tz = tzSel.value; b.day = null; b.slot = null; b.month = null; W.rerender('business'); };
      body.querySelectorAll('input[name=m]').forEach((r) => (r.onchange = () => { b.method = r.value; }));
      const form = body.querySelector('[data-form]');
      if (form) form.onsubmit = (e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(form)); b.form = f;
        const err = !f.name.trim() ? L('Vui lòng nhập họ tên.', 'Please enter your name.') : !/^\S+@\S+\.\S+$/.test(f.email) ? L('Email chưa hợp lệ.', 'Email looks invalid.') : '';
        const box = form.querySelector('[data-err]');
        if (err) { box.textContent = err; box.hidden = false; return; }
        b.step = 3; W.rerender('business');
      };
      body.onclick = (e) => {
        const t = e.target.closest('button'); if (!t) return;
        const d = t.dataset;
        if (d.mon) { const [y, m] = b.month.split('-').map(Number); const n = new Date(Date.UTC(y, m - 1 + +d.mon, 1)); b.month = n.toISOString().slice(0, 7); return W.rerender('business'); }
        if (d.day) { b.day = d.day; b.slot = null; return W.rerender('business'); }
        if (d.slot) { b.slot = +d.slot; return W.rerender('business'); }
        if ('next' in d && b.slot) { b.step = 2; return W.rerender('business'); }
        if ('prev' in d) { b.step = 1; return W.rerender('business'); }
        if ('back2' in d) { b.step = 2; return W.rerender('business'); }
        if ('hold' in d) { b.hold = { code: 'BK-' + Math.random().toString(36).slice(2, 8).toUpperCase(), until: Date.now() + 15 * 6e4 }; return W.rerender('business'); }
        if ('pay' in d) { b.step = 4; Z.M.react('happy'); return W.rerender('business'); }
        if ('restart' in d) { w.state.bk = { step: 1, tz: b.tz, method: b.method, form: b.form }; return W.rerender('business'); }
      };
    },
  });

  /* ======================= GitHub activity (GithubActivity) ======================= */
  const GT = () => ({ PushEvent: 'Push', PullRequestEvent: 'Pull request', IssuesEvent: 'Issue', IssueCommentEvent: L('Bình luận', 'Comment'), CreateEvent: L('Tạo', 'Create'), DeleteEvent: L('Xoá', 'Delete'), ReleaseEvent: L('Phát hành', 'Release'), WatchEvent: L('Gắn sao', 'Star'), ForkEvent: 'Fork', PullRequestReviewEvent: 'Review', PullRequestReviewCommentEvent: L('Bình luận review', 'Review comment'), PublicEvent: L('Công khai repo', 'Made public') });
  const ACT = () => ({ merged: L('đã merge', 'merged'), opened: L('mở', 'opened'), closed: L('đóng', 'closed'), reopened: L('mở lại', 'reopened'), labeled: L('gắn nhãn', 'labeled'), created: '', assigned: L('giao việc', 'assigned') });
  const evText = (e) => {
    if (e.type === 'PushEvent') return `${L('Push lên', 'Pushed to')} ${e.ref || 'main'}`;
    if (e.type === 'CreateEvent' || e.type === 'DeleteEvent') return `${e.ref_type || ''} ${e.ref || ''}`.trim() || e.repo;
    return `${e.number ? '#' + e.number + ' ' : ''}${e.title || ''}`.trim() || e.repo;
  };
  /* contribution calendar in the GitHub profile layout: weeks run Sunday → Saturday, 5 levels */
  const N = (n) => Number(n).toLocaleString(S.lang === 'vi' ? 'vi-VN' : 'en-US');
  const calWeeks = (days) => {
    const weeks = []; let wk = [];
    const lead = new Date(days[0][0] + 'T00:00:00Z').getUTCDay();
    for (let i = 0; i < lead; i++) wk.push(null);
    days.forEach((d) => { wk.push(d); if (wk.length === 7) { weeks.push(wk); wk = []; } });
    if (wk.length) weeks.push(wk);
    return weeks;
  };
  const dayLong = (k) => Z.date(k + 'T12:00:00Z', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const cLabel = (d) => (d[1] ? fmt(L('{n} đóng góp vào {date}', '{n} contributions on {date}'), { n: N(d[1]), date: dayLong(d[0]) }) : fmt(L('Không có đóng góp vào {date}', 'No contributions on {date}'), { date: dayLong(d[0]) }));
  const MON = (m) => (S.lang === 'vi' ? `Thg ${m}` : ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]);
  /* one floating tooltip shared by every graph, like GitHub's */
  let cgTip = null;
  const tipOn = (cell) => {
    if (!cgTip) { cgTip = Z.h('<div class="cg-tip" role="tooltip"></div>'); document.body.append(cgTip); }
    cgTip.textContent = cell.getAttribute('aria-label');
    const r = cell.getBoundingClientRect();
    cgTip.style.left = Math.round(Math.min(innerWidth - 8, Math.max(8, r.left + r.width / 2))) + 'px';
    cgTip.style.top = Math.round(r.top - 8) + 'px';
    cgTip.classList.add('on');
  };
  const tipOff = () => { if (cgTip) cgTip.classList.remove('on'); };
  addEventListener('scroll', tipOff, true);
  /* full graph (GitHub window) or a compact one (mobile widget): weeks = how many recent weeks to draw */
  Z.ghGraph = (cal, o = {}) => {
    const all = calWeeks(cal.days), weeks = o.weeks ? all.slice(-o.weeks) : all;
    let prevM = 0, lastLbl = -9;
    const months = weeks.map((wk, i) => {
      const d = wk.find(Boolean), m = +d[0].slice(5, 7);
      const show = m !== prevM && (i === 0 ? wk.filter(Boolean).every((x) => x[0].slice(5, 7) === d[0].slice(5, 7)) && wk[0] : true) && i - lastLbl >= 3;
      prevM = m; if (show) lastLbl = i;
      return show ? `<span class="cg-m" style="grid-column:${i + 2}">${MON(m)}</span>` : '';
    }).join('');
    const dows = o.compact ? '' : [[1, L('T2', 'Mon')], [3, L('T4', 'Wed')], [5, L('T6', 'Fri')]].map(([r, t]) => `<span class="cg-d" style="grid-row:${r + 2}">${t}</span>`).join('');
    const cells = weeks.map((wk, i) => wk.map((d, r) => (d ? `<span class="cg-c" role="gridcell" data-k="${d[0]}" data-l="${d[2]}" style="grid-column:${i + 2};grid-row:${r + 2}" tabindex="-1" aria-label="${esc(cLabel(d))}" aria-selected="${o.sel === d[0]}"></span>` : '')).join('')).join('');
    return `<div class="cg${o.compact ? ' compact' : ''}"><div class="cg-scroll"><div class="cg-grid" ${o.compact ? 'aria-hidden="true"' : `role="grid" aria-label="${esc(L('Lịch đóng góp GitHub', 'GitHub contribution calendar'))}"`} style="--wk:${weeks.length}">${o.compact ? '' : months}${dows}${cells}</div></div>
      ${o.compact ? '' : `<div class="cg-foot"><a href="https://docs.github.com/articles/why-are-my-contributions-not-showing-up-on-my-profile" target="_blank" rel="noopener">${L('GitHub tính đóng góp thế nào?', 'Learn how we count contributions')}</a><span class="cg-lg" aria-hidden="true">${L('Ít', 'Less')}${[0, 1, 2, 3, 4].map((l) => `<i data-l="${l}"></i>`).join('')}${L('Nhiều', 'More')}</span></div>`}</div>`;
  };
  /* wires hover tooltips, roving focus (arrows move a day or a week) and selection */
  Z.ghWire = (root, onPick) => {
    const grid = root.querySelector('.cg-grid'); if (!grid) return;
    const sc = root.querySelector('.cg-scroll');
    const cells = [...grid.querySelectorAll('.cg-c')];
    const sel = grid.querySelector('[aria-selected=true]');
    const cur = sel || cells[cells.length - 1];
    if (cur) cur.tabIndex = 0;
    requestAnimationFrame(() => { if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'center' }); else sc.scrollLeft = sc.scrollWidth; });
    grid.addEventListener('pointerover', (e) => { const c = e.target.closest('.cg-c'); if (c) tipOn(c); });
    grid.addEventListener('pointerleave', tipOff);
    grid.addEventListener('focusin', (e) => { const c = e.target.closest('.cg-c'); if (c) tipOn(c); });
    grid.addEventListener('focusout', tipOff);
    const move = (from, to) => { if (!to) return; from.tabIndex = -1; to.tabIndex = 0; to.focus(); to.scrollIntoView({ block: 'nearest', inline: 'nearest' }); };
    grid.addEventListener('keydown', (e) => {
      const c = e.target.closest('.cg-c'); if (!c) return;
      const i = cells.indexOf(c);
      const step = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[e.key];
      if (step) { e.preventDefault(); move(c, cells[i + step] || (step > 0 ? cells[cells.length - 1] : cells[0])); return; }
      if (e.key === 'Home') { e.preventDefault(); move(c, cells[0]); }
      else if (e.key === 'End') { e.preventDefault(); move(c, cells[cells.length - 1]); }
      else if ((e.key === 'Enter' || e.key === ' ') && onPick) { e.preventDefault(); onPick(c); }
    });
    if (onPick) grid.addEventListener('click', (e) => { const c = e.target.closest('.cg-c'); if (c) { cells.forEach((x) => { x.tabIndex = -1; }); c.tabIndex = 0; onPick(c); } });
  };
  const calStats = (days) => {
    let best = 0, run = 0, top = days[0];
    days.forEach((d) => { run = d[1] ? run + 1 : 0; best = Math.max(best, run); if (d[1] > top[1]) top = d; });
    let cur = 0; for (let i = days.length - 1; i >= 0 && days[i][1]; i--) cur++;
    const active = days.filter((d) => d[1]).length;
    return { best, cur, top, active };
  };
  W.reg('github', {
    min: { w: 360, h: 380 },
    icon: () => `<span class="g gh">${ic('gh')}</span>`,
    title: () => 'zuey-activity.log',
    rect: (aw, ah) => ({ w: Math.min(aw - 32, 820), h: Math.min(ah - 14, 680) }),
    mount(w) { w.state.loading = true; setTimeout(() => { w.state.loading = false; W.rerender('github'); }, 450); },
    render(body, w) {
      const st = w.state, G = D.github, C = G.calendar;
      if (st.loading) { body.innerHTML = `<div class="gh-skel" aria-busy="true"><span class="sk w40"></span><span class="sk w60"></span><div class="sk grid"></div><span class="sr">${L('Đang tải hoạt động GitHub…', 'Loading GitHub activity…')}</span></div>`; return; }
      const s = calStats(C.days);
      body.innerHTML = `<div class="gh-top"><div><div class="eyebrow">GitHub · @${esc(G.user)}</div><h2 class="h2">${L('Zuey đang làm gì', 'What Zuey is doing')}</h2></div>
          <a class="btn sm ghost" href="https://github.com/${esc(G.user)}" target="_blank" rel="noopener">${ic('gh')} ${L('Xem trên GitHub', 'View on GitHub')} ↗</a></div>
        <h3 class="cg-h">${fmt(L('{n} đóng góp trong năm qua', '{n} contributions in the last year'), { n: N(C.total) })}</h3>
        <div class="cg-card">${Z.ghGraph(C, { sel: st.day })}</div>
        <dl class="cg-stats">
          <div><dt>${L('Ngày nhiều nhất', 'Busiest day')}</dt><dd>${N(s.top[1])}<small>${Z.date(s.top[0] + 'T12:00:00Z')}</small></dd></div>
          <div><dt>${L('Ngày có đóng góp', 'Active days')}</dt><dd>${N(s.active)}<small>/ ${N(C.days.length)}</small></dd></div>
          <div><dt>${L('Chuỗi dài nhất', 'Longest streak')}</dt><dd>${N(s.best)}<small>${L('ngày', 'days')}</small></dd></div>
          <div><dt>${L('Chuỗi hiện tại', 'Current streak')}</dt><dd>${N(s.cur)}<small>${L('ngày', 'days')}</small></dd></div>
        </dl>
        <div class="gh-act" aria-live="polite"></div>
        <p class="small muted" style="margin-top:14px">${fmt(L('Lịch đóng góp lấy từ trang profile công khai, cập nhật {time}. Danh sách bên dưới là các sự kiện công khai gần đây (GitHub giữ tối đa 300).', 'Calendar from the public profile, updated {time}. The list below shows recent public events (GitHub keeps up to 300).'), { time: Z.date(C.fetched_at) + ' ' + Z.time(C.fetched_at) })}</p>`;
      const act = body.querySelector('.gh-act');
      const renderAct = () => {
        const T = GT(), AC = ACT();
        const evs = G.events.slice().sort((a, b) => b.created_at.localeCompare(a.created_at));
        const list = st.day ? evs.filter((e) => dayKey(e.created_at, Z.TZ) === st.day) : evs;
        const shown = st.all ? list : list.slice(0, 15);
        const groups = [];
        shown.forEach((e) => { const k = e.created_at.slice(0, 7); let g = groups.find((x) => x.k === k); if (!g) groups.push(g = { k, items: [] }); g.items.push(e); });
        const pushes = (items) => { const r = {}; items.filter((e) => e.type === 'PushEvent').forEach((e) => { r[e.repo] = (r[e.repo] || 0) + (e.commits || 1); }); return Object.entries(r).sort((a, b) => b[1] - a[1]); };
        const dayCount = st.day && C.days.find((d) => d[0] === st.day);
        act.innerHTML = `<div class="gh-ah"><h3>${L('Hoạt động gần đây', 'Contribution activity')}</h3>${st.day ? `<button class="chip" aria-pressed="true" data-alldays>${esc(Z.date(st.day + 'T12:00:00Z'))} · ${L('bỏ lọc', 'clear')} ${ic('x')}</button>` : ''}</div>
          ${st.day && !list.length ? `<div class="note">${fmt(L('{n} đóng góp ngày này, nhưng không còn sự kiện công khai chi tiết (GitHub chỉ giữ 300 sự kiện gần nhất, khoảng 90 ngày).', '{n} contributions that day, but no detailed public events remain (GitHub keeps the latest 300, about 90 days).'), { n: N(dayCount ? dayCount[1] : 0) })}</div>` : ''}
          ${groups.map((g) => { const p = pushes(g.items), max = p.length ? p[0][1] : 1; return `<section class="gh-mo"><h4><span>${esc(Z.date(g.k + '-15T12:00:00Z', { month: 'long', year: 'numeric' }))}</span></h4>
            ${p.length ? `<div class="gh-push"><b>${fmt(L('Đã tạo {c} commit trong {r} repo', 'Created {c} commits in {r} repositories'), { c: N(p.reduce((n, x) => n + x[1], 0)), r: p.length })}</b>${p.slice(0, 5).map(([r, n]) => `<a href="https://github.com/${esc(r)}" target="_blank" rel="noopener"><span class="rp">${esc(r)}</span><span class="cnt">${N(n)}</span><i style="--p:${Math.max(4, Math.round((n / max) * 100))}%"></i></a>`).join('')}</div>` : ''}
            <ul class="evs">${g.items.filter((e) => e.type !== 'PushEvent').map((e) => `<li class="ev"><time datetime="${e.created_at}">${Z.date(e.created_at, { day: 'numeric', month: 'numeric' })} ${Z.time(e.created_at)}</time><div style="min-width:0"><div class="t"><span class="tag">${T[e.type] || e.type.replace('Event', '')}</span>${e.action && AC[e.action] ? `<span class="small muted">${AC[e.action]}</span>` : ''}<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(evText(e))}</a></div><div class="r">${esc(e.repo)}</div></div></li>`).join('')}</ul></section>`; }).join('')}
          ${!st.all && list.length > 15 ? `<button class="btn ghost block" data-all style="margin-top:8px">${fmt(L('Xem tất cả {count} sự kiện', 'See all {count} events'), { count: N(list.length) })}</button>` : ''}`;
      };
      renderAct();
      const card = body.querySelector('.cg-card');
      Z.ghWire(card, (c) => {
        st.day = st.day === c.dataset.k ? null : c.dataset.k; st.all = false;
        card.querySelectorAll('.cg-c[aria-selected=true]').forEach((x) => x.setAttribute('aria-selected', 'false'));
        if (st.day) c.setAttribute('aria-selected', 'true');
        renderAct();
      });
      body.onclick = (e) => {
        const t = e.target.closest('button'); if (!t || !act.contains(t)) return;
        if ('alldays' in t.dataset) { st.day = null; card.querySelectorAll('.cg-c[aria-selected=true]').forEach((x) => x.setAttribute('aria-selected', 'false')); }
        else if ('all' in t.dataset) st.all = true;
        else return;
        renderAct();
      };
    },
  });

  /* ======================= MCP connect ======================= */
  const MCP_TABS = () => [
    ['cc', 'Claude Code', `<p class="small muted">${L('Chạy trong terminal:', 'Run in a terminal:')}</p>`, 'claude mcp add --transport http zuey https://zuey.me/mcp'],
    ['claude', 'Claude', `<p class="small muted">${L('Settings → Connectors → Add custom connector, rồi dán URL:', 'Settings → Connectors → Add custom connector, then paste the URL:')}</p>`, 'https://zuey.me/mcp'],
    ['gpt', 'ChatGPT', `<p class="small muted">${L('Bật developer mode, tạo custom connector với URL:', 'Enable developer mode and add a custom connector with this URL:')}</p>`, 'https://zuey.me/mcp'],
    ['cursor', 'Cursor', `<p class="small muted">${L('Thêm vào', 'Add to')} <code class="mono">.cursor/mcp.json</code>:</p>`, '{\n  "mcpServers": {\n    "zuey": { "url": "https://zuey.me/mcp" }\n  }\n}'],
    ['key', 'API key', `<p class="small muted">${L('Dùng /api/mcp với API key cá nhân:', 'Use /api/mcp with a personal API key:')}</p>`, 'claude mcp add --transport http zuey https://zuey.me/api/mcp --header "Authorization: Bearer <YOUR_ZUEY_API_KEY>"', `<p class="small muted">${L('MCP client hỗ trợ header:', 'MCP clients that support headers:')}</p>`, '{\n  "mcpServers": {\n    "zuey": {\n      "url": "https://zuey.me/api/mcp",\n      "headers": { "Authorization": "Bearer <YOUR_ZUEY_API_KEY>" }\n    }\n  }\n}'],
  ];
  const code = (s) => `<div class="code">${esc(s)}<button class="cp" data-copy="${esc(s)}" aria-label="Copy">${ic('copy')}</button></div>`;
  W.reg('mcp', {
    min: { w: 360, h: 380 },
    icon: () => `<span class="g mcp">${ic('plug')}</span>`,
    title: () => 'mcp-connect',
    rect: () => ({ w: 580, h: 560 }),
    render(body, w) {
      const st = w.state; st.tab = st.tab || 'cc';
      const T = MCP_TABS(), t = T.find((x) => x[0] === st.tab);
      body.innerHTML = `<div class="eyebrow">MCP</div><h2 class="h2">${L('Kết nối Zuey với AI tool', 'Connect Zuey to your AI tool')}</h2>
        <p class="lead">${L('Dùng /mcp với OAuth (đăng nhập và cấp quyền trên trình duyệt) hoặc /api/mcp với API key cá nhân. Ở đây không bao giờ hiển thị key; hãy thay placeholder bằng key của bạn.', 'Use /mcp with OAuth (sign in and grant access in the browser) or /api/mcp with a personal API key. Keys are never shown here; replace the placeholder with yours.')}</p>
        <div class="seg" role="tablist" style="margin-top:14px;flex-wrap:wrap">${T.map(([id, n]) => `<button role="tab" data-tab="${id}" aria-selected="${st.tab === id}">${n}${id === 'cc' ? '' : ''}</button>`).join('')}</div>
        <div class="stack" style="margin-top:12px" role="tabpanel">${st.tab !== 'key' ? `<span class="tag" style="justify-self:start;background:rgba(87,192,132,.18);color:var(--ok-fg)">${L('OAuth (khuyên dùng)', 'OAuth (recommended)')}</span>` : ''}${t[2]}${code(t[3])}${t[4] ? t[4] + code(t[5]) : ''}</div>
        <div class="row" style="margin-top:16px"><button class="btn sm" data-keys>${ic('key')} ${L('Tạo API key cá nhân', 'Create a personal API key')}</button><a class="btn sm ghost" href="https://zuey.me/docs" target="_blank" rel="noopener">${L('API docs', 'API docs')} ↗</a></div>
        <p class="small muted" style="margin-top:10px">${L('Công cụ MCP: tìm bài, đọc bài (theo gói), hỏi Zuey AI, đọc Zuey Reads.', 'MCP tools: search posts, read posts (per plan), ask Zuey AI, read Zuey Reads.')}</p>`;
      body.onclick = (e) => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.tab) { st.tab = b.dataset.tab; return W.rerender('mcp'); }
        if (b.dataset.copy != null) { const old = b.innerHTML; return Z.copy(b.dataset.copy, () => { b.innerHTML = ic('check'); setTimeout(() => (b.innerHTML = old), 1200); }); }
        if ('keys' in b.dataset) return Z.signedIn() ? W.open('account', { tab: 'keys' }) : W.open('login', { next: 'account' });
      };
      body.onkeydown = (e) => {
        if (!e.target.dataset.tab || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
        const ids = T.map((x) => x[0]); const i = (ids.indexOf(st.tab) + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
        st.tab = ids[i]; W.rerender('mcp'); body.querySelector(`[data-tab="${ids[i]}"]`).focus();
      };
    },
  });

  /* ======================= Sign in (MemberAuth) ======================= */
  const signIn = (email, next) => {
    Z.set({ role: S.role === 'admin' ? 'admin' : 'member', email: email || S.email || 'ban@example.com' });
    W.close('login'); Z.toast(L('Đã đăng nhập (demo).', 'Signed in (demo).'));
    Z.M.react('wave');
    if (next) W.open(next);
  };
  W.reg('login', {
    min: { w: 340, h: 420 },
    light: true,
    icon: () => `<span class="g acct">${ic('user')}</span>`,
    title: () => 'sign-in',
    rect: () => ({ w: 420, h: 560 }),
    render(body, w, arg) {
      const st = w.state; if (arg && arg.next) st.next = arg.next;
      if (Z.signedIn()) { body.innerHTML = `<div class="empty"><span class="ent free">${ic('check')}</span><b>${L('Bạn đã đăng nhập.', 'You are signed in.')}</b><button class="btn sm" data-acc>${L('Mở Tài khoản', 'Open account')}</button></div>`; body.onclick = (e) => { if (e.target.closest('[data-acc]')) W.open('account'); }; return; }
      body.innerHTML = st.sent
        ? `<div class="stack"><span class="g ai" style="width:48px;height:48px">${ic('mail')}</span><h2 class="h2">${L('Kiểm tra hộp thư', 'Check your inbox')}</h2>
          <p>${fmt(L('Đã gửi liên kết đăng nhập tới {email}. Liên kết có hiệu lực trong 15 phút và chỉ dùng được một lần.', 'We sent a sign-in link to {email}. It works for 15 minutes, once.'), { email: `<b>${esc(st.sent)}</b>` })}</p>
          <p class="small muted">${L('Không thấy email? Kiểm tra mục Spam/Quảng cáo, hoặc gửi lại sau một phút.', 'No email? Check Spam/Promotions, or resend in a minute.')}</p>
          <button class="btn acc" data-magic>${L('Mô phỏng: mở liên kết trong email', 'Simulate: open the email link')}</button>
          <button class="btn ghost" data-other>${L('Dùng email khác', 'Use another email')}</button></div>`
        : `<div class="stack"><h2 class="h2">${L('Đăng nhập Zuey', 'Sign in to Zuey')}</h2><p class="muted">${L('Không cần mật khẩu. Tài khoản mới được tạo tự động ở lần đăng nhập đầu tiên.', 'No password. New accounts are created on first sign-in.')}</p>
          <form class="stack" data-f novalidate><label class="f">Email<input class="input" name="email" type="email" autocomplete="email" placeholder="ban@congty.vn" required></label><p class="note err" data-err hidden></p><button class="btn">${ic('mail')} ${L('Gửi liên kết đăng nhập', 'Email me a sign-in link')}</button></form>
          <div class="row" style="gap:10px;color:var(--muted)"><hr style="flex:1;border:0;border-top:1px solid var(--hair)"><span class="small">${L('hoặc', 'or')}</span><hr style="flex:1;border:0;border-top:1px solid var(--hair)"></div>
          <button class="btn ghost" data-oauth="Google"><b style="color:#4285f4">G</b> ${L('Tiếp tục với Google', 'Continue with Google')}</button>
          <button class="btn ghost" data-oauth="GitHub">${ic('gh')} ${L('Tiếp tục với GitHub', 'Continue with GitHub')}</button>
          <p class="small muted">${L('Khi đăng nhập, bạn đồng ý để Zuey lưu email và lịch sử đăng nhập để bảo vệ tài khoản. Xem', 'By signing in you let Zuey store your email and sign-in history to protect your account. See')} <a href="https://zuey.me/privacy" target="_blank" rel="noopener" style="text-decoration:underline">${L('Quyền riêng tư', 'Privacy')}</a>.</p>
          <p class="small muted">${demoTag()} ${L('Demo không gửi email và không mở Google/GitHub.', 'The demo sends no email and opens no Google/GitHub.')}</p></div>`;
      const f = body.querySelector('[data-f]');
      if (f) f.onsubmit = (e) => {
        e.preventDefault(); const v = f.email.value.trim();
        if (!/^\S+@\S+\.\S+$/.test(v)) { const b = f.querySelector('[data-err]'); b.textContent = L('Email chưa hợp lệ.', 'Email looks invalid.'); b.hidden = false; return; }
        st.sent = v; W.rerender('login');
      };
      body.onclick = (e) => {
        const t = e.target.closest('button'); if (!t) return;
        if ('magic' in t.dataset) return signIn(st.sent, st.next);
        if ('other' in t.dataset) { st.sent = null; return W.rerender('login'); }
        if (t.dataset.oauth) { t.disabled = true; t.textContent = L('Đang chuyển hướng…', 'Redirecting…'); setTimeout(() => signIn('', st.next), 700); }
      };
    },
  });

  /* ======================= Account (AccountApp) ======================= */
  const ACC_TABS = () => [['profile', L('Hồ sơ', 'Profile'), 'user'], ['email', 'Email', 'mail'], ['plan', L('Gói', 'Plan'), 'card'], ['keys', L('Khoá API', 'API keys'), 'key'], ['devices', L('Thiết bị', 'Devices'), 'device'], ['activity', L('Hoạt động', 'Activity'), 'activity'], ['data', L('Dữ liệu', 'Data'), 'db']];
  W.reg('account', {
    min: { w: 380, h: 380 },
    light: true,
    icon: () => `<span class="g acct">${ic('user')}</span>`,
    title: () => 'account',
    rect: (aw, ah) => ({ w: 760, h: Math.min(ah - 14, 600) }),
    render(body, w, arg) {
      const st = w.state; if (arg && arg.tab) st.tab = arg.tab; st.tab = st.tab || 'profile';
      st.keys = st.keys || Z.lsGet('zos_keys_v1', []);
      if (!Z.signedIn()) { body.innerHTML = `<div class="empty"><span class="g acct">${ic('user')}</span><b>${L('Đăng nhập để xem tài khoản', 'Sign in to see your account')}</b><button class="btn sm" data-login>${L('Đăng nhập', 'Sign in')}</button></div>`; body.onclick = (e) => { if (e.target.closest('[data-login]')) W.open('login', { next: 'account' }); }; return; }
      const email = S.email || 'ban@example.com', plan = Z.plan();
      const sec = {
        profile: `<h3>${L('Hồ sơ', 'Profile')}</h3><div class="row"><span class="mb-acct" style="display:grid;place-items:center;width:52px;height:52px;border-radius:50%;background:var(--accent);color:#fff;font:800 20px var(--serif)">${esc(email[0].toUpperCase())}</span><div><b>${esc(email.split('@')[0])}</b><div class="small muted">${esc(email)}</div></div></div>
          <label class="f">${L('Tên hiển thị', 'Display name')}<input class="input" value="${esc(email.split('@')[0])}"></label>
          <h3 style="font-size:15px">${L('Tài khoản liên kết', 'Linked accounts')}</h3><div class="row"><span class="chip">Google · ${L('chưa liên kết', 'not linked')}</span><span class="chip">GitHub · ${L('chưa liên kết', 'not linked')}</span></div>`,
        email: `<h3>Email</h3><p>${L('Email hiện tại', 'Current email')}: <b>${esc(email)}</b></p><form class="stack" data-chg><label class="f">${L('Email mới', 'New email')}<input class="input" type="email" name="e" required></label><button class="btn" style="justify-self:start">${L('Gửi email xác nhận', 'Send confirmation')}</button></form><p class="small muted">${L('Email chỉ đổi sau khi bạn bấm liên kết xác nhận gửi tới địa chỉ mới.', 'The email changes only after you confirm via the new address.')}</p>`,
        plan: `<h3>${L('Gói', 'Plan')}</h3>${plan && S.role === 'member' && S.plan !== 'none' ? `<div class="card"><b style="font:800 18px var(--serif)">${esc(plan.name)}</b> <span class="tag free">${L('Đang hoạt động', 'Active')}</span><p class="small muted">${fmt(L('Hết hạn {d} · gia hạn sớm sẽ cộng dồn', 'Expires {d} · early renewals stack'), { d: Z.date(Date.now() + 30 * 864e5) })}</p>${plan.ai_budget_usd_cents ? `<p class="small">${fmt(L('Ngân sách AI {b}/tháng', 'AI budget {b}/month'), { b: Z.usd(plan.ai_budget_usd_cents) })}</p>` : ''}</div>` : Z.isAdmin() ? `<div class="card"><b>Admin</b> · ${L('toàn quyền, không giới hạn AI', 'full access, unlimited AI')}</div>` : `<div class="card">${L('Bạn chưa có gói nào.', 'You have no plan yet.')}</div>`}
          <button class="btn" style="justify-self:start" data-go="pricing">${S.plan !== 'none' ? L('Gia hạn / đổi gói', 'Renew / change plan') : L('Xem các gói', 'See plans')}</button>
          ${S.plan === 'community' || Z.isAdmin() ? `<div class="card"><b>${ic('send')} ${L('Nhóm kín trên Telegram', 'Private Telegram group')}</b><p class="small muted">${L('Lời mời dùng một lần, gắn với tài khoản của bạn. Có nhóm tiếng Việt và tiếng Anh.', 'Single-use invites tied to your account. Vietnamese and English groups.')}</p><div class="row"><button class="btn sm" data-tg>${L('Lấy lời mời nhóm tiếng Việt', 'Get Vietnamese invite')}</button><button class="btn sm ghost" data-tg>${L('Nhóm tiếng Anh', 'English group')}</button></div></div>` : ''}
          <h3 style="font-size:15px">${L('Thẻ quốc tế (Dodo)', 'International card (Dodo)')}</h3><p class="small muted">${L('Chưa có đăng ký thẻ. Thanh toán thẻ sẽ mở khi Dodo duyệt tài khoản.', 'No card subscription. Card payments open once Dodo approves the account.')}</p>
          <h3 style="font-size:15px">${L('Đơn hàng chuyển khoản', 'Bank transfer orders')}</h3>
          ${(S.orders || []).length ? `<div class="tblw"><table class="tbl"><thead><tr><th>${L('Mã', 'Code')}</th><th>${L('Gói', 'Plan')}</th><th>${L('Số tiền', 'Amount')}</th><th>${L('Trạng thái', 'Status')}</th></tr></thead><tbody>${S.orders.map((o) => `<tr><td class="mono">${o.code}</td><td>${esc(Z.planName(o.plan))} · ${o.months}${L('th', 'mo')}</td><td>${Z.vnd(o.vnd)}</td><td><span class="tag free">${L('Đã thanh toán', 'Paid')}</span></td></tr>`).join('')}</tbody></table></div>` : `<p class="small muted">${L('Chưa có đơn nào.', 'No orders yet.')}</p>`}`,
        keys: `<h3>${L('Khoá API', 'API keys')}</h3><p class="small muted">${Z.isAdmin() ? L('Admin có thể tạo key đọc/ghi.', 'Admins can create read/write keys.') : L('Key thành viên chỉ đọc, dùng cho /api/mcp và REST API.', 'Member keys are read-only, for /api/mcp and the REST API.')}</p>
          <form class="row grow" data-newkey><input class="input" name="n" placeholder="${L('Tên key, ví dụ: Cursor laptop', 'Key name, e.g. Cursor laptop')}" required><button class="btn">${ic('plus')} ${L('Tạo key', 'Create key')}</button></form>
          ${st.newKey ? `<div class="note ok"><b>${L('Key mới đã tạo.', 'New key created.')}</b> ${L('Bản thật chỉ hiện key đúng một lần ở đây. Demo không tạo key thật.', 'The live site shows the key exactly once here. The demo creates no real key.')}<div class="code" style="margin-top:8px">zk_demo_••••••••••••</div></div>` : ''}
          ${st.keys.length ? `<div class="tblw"><table class="tbl"><thead><tr><th>${L('Tên', 'Name')}</th><th>${L('Quyền', 'Scope')}</th><th>${L('Tạo lúc', 'Created')}</th><th></th></tr></thead><tbody>${st.keys.map((k) => `<tr><td>${esc(k.n)}<div class="small muted mono">zk_…${k.s}</div></td><td>${Z.isAdmin() ? 'read/write' : 'read'}</td><td>${Z.date(k.at)}</td><td><button class="btn sm ghost" data-revoke="${k.id}">${L('Thu hồi', 'Revoke')}</button></td></tr>`).join('')}</tbody></table></div>` : `<p class="small muted">${L('Chưa có key nào.', 'No keys yet.')}</p>`}
          <button class="btn sm ghost" style="justify-self:start" data-go="mcp">${ic('plug')} ${L('Hướng dẫn kết nối MCP', 'MCP setup guide')}</button>`,
        devices: `<h3>${L('Thiết bị', 'Devices')}</h3><div class="tblw"><table class="tbl"><thead><tr><th>${L('Thiết bị', 'Device')}</th><th>${L('Lần cuối', 'Last seen')}</th><th></th></tr></thead><tbody><tr><td>${esc(navigator.userAgent.includes('Mac') ? 'macOS' : navigator.userAgent.includes('Android') ? 'Android' : navigator.userAgent.includes('iPhone') ? 'iPhone' : 'Windows')} · ${L('trình duyệt này', 'this browser')}</td><td>${L('Bây giờ', 'Now')}</td><td><span class="tag free">${L('Hiện tại', 'Current')}</span></td></tr></tbody></table></div><button class="btn sm ghost" style="justify-self:start" data-others>${L('Đăng xuất khỏi thiết bị khác', 'Sign out other devices')}</button>`,
        activity: `<h3>${L('Hoạt động', 'Activity')}</h3><div class="tblw"><table class="tbl"><thead><tr><th>${L('Sự kiện', 'Event')}</th><th>${L('Thời gian', 'Time')}</th></tr></thead><tbody><tr><td>${L('Đăng nhập bằng liên kết email', 'Signed in with email link')}</td><td>${Z.date(Date.now(), { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}</td></tr>${(S.orders || []).map((o) => `<tr><td>${fmt(L('Kích hoạt gói {p}', 'Activated {p}'), { p: esc(Z.planName(o.plan)) })}</td><td>${Z.date(o.at, { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}</td></tr>`).join('')}</tbody></table></div><p class="small muted">${demoTag()} ${L('Bản thật liệt kê đăng nhập, đổi email, tạo/thu hồi key và thanh toán.', 'Live lists sign-ins, email changes, key changes and payments.')}</p>`,
        data: `<h3>${L('Dữ liệu', 'Data')}</h3><p class="small muted">${L('Tải toàn bộ dữ liệu của bạn (hồ sơ, gói, đơn, chat) dạng JSON.', 'Download all your data (profile, plans, orders, chats) as JSON.')}</p><button class="btn sm" style="justify-self:start" data-export>${ic('download')} ${L('Xuất dữ liệu', 'Export data')}</button>
          <div class="card" style="border-color:#f6c9c6"><b style="color:var(--err-ink)">${L('Xoá tài khoản', 'Delete account')}</b><p class="small muted">${L('Xoá vĩnh viễn hồ sơ, chat và khoá API. Đơn đã thanh toán được giữ theo luật kế toán.', 'Permanently deletes your profile, chats and API keys. Paid orders are kept for accounting.')}</p><form class="row grow" data-del><input class="input" name="c" placeholder="${L('Gõ XOÁ để xác nhận', 'Type DELETE to confirm')}"><button class="btn acc">${L('Xoá tài khoản', 'Delete account')}</button></form></div>`,
      };
      body.innerHTML = `<div class="acct-pane"><nav aria-label="${L('Mục tài khoản', 'Account sections')}">${ACC_TABS().map(([id, t, i]) => `<button data-tab="${id}" aria-current="${st.tab === id}">${ic(i)} ${t}</button>`).join('')}<hr style="border:0;border-top:1px solid var(--hair);margin:6px 0"><button data-logout>${ic('logout')} ${L('Đăng xuất', 'Sign out')}</button></nav><section>${sec[st.tab]}</section></div>`;
      const nk = body.querySelector('[data-newkey]');
      if (nk) nk.onsubmit = (e) => { e.preventDefault(); st.keys.unshift({ id: Z.uid(), n: nk.n.value.trim(), s: Math.random().toString(36).slice(2, 6), at: Date.now() }); Z.lsSet('zos_keys_v1', st.keys); st.newKey = true; W.rerender('account'); };
      const chg = body.querySelector('[data-chg]');
      if (chg) chg.onsubmit = (e) => { e.preventDefault(); Z.toast(fmt(L('Đã gửi email xác nhận tới {e} (demo).', 'Confirmation sent to {e} (demo).'), { e: chg.e.value })); chg.reset(); };
      const del = body.querySelector('[data-del]');
      if (del) del.onsubmit = (e) => { e.preventDefault(); if (!/^(XOÁ|XÓA|DELETE)$/i.test(del.c.value.trim())) return Z.toast(L('Gõ đúng XOÁ để xác nhận.', 'Type DELETE exactly.')); Z.set({ role: 'guest', plan: 'none', email: '', orders: [] }); W.close('account'); Z.toast(L('Đã xoá tài khoản (demo).', 'Account deleted (demo).')); };
      body.onclick = (e) => {
        const t = e.target.closest('button'); if (!t) return;
        const d = t.dataset;
        if (d.tab) { st.tab = d.tab; st.newKey = false; return W.rerender('account'); }
        if (d.go) return W.open(d.go);
        if ('logout' in d) { Z.set({ role: 'guest', plan: 'none' }); W.close('account'); return Z.toast(L('Đã đăng xuất.', 'Signed out.')); }
        if (d.revoke) { st.keys = st.keys.filter((k) => k.id !== d.revoke); Z.lsSet('zos_keys_v1', st.keys); return W.rerender('account'); }
        if ('tg' in d) return Z.toast(L('Bản thật tạo link mời Telegram dùng một lần (bot cấp).', 'Live creates a single-use Telegram invite via the bot.'), 3600);
        if ('others' in d) return Z.toast(L('Đã đăng xuất các thiết bị khác (demo).', 'Other devices signed out (demo).'));
        if ('export' in d) return Z.toast(L('Bản thật tải file JSON; khung artifact chặn tải file.', 'Live downloads a JSON file; this frame blocks downloads.'), 3600);
      };
    },
  });

  /* ======================= Launchpad (all 20 links) ======================= */
  W.reg('launchpad', {
    min: { w: 360, h: 360 },
    icon: () => `<span class="g links">${ic('grid')}</span>`,
    title: () => 'Launchpad',
    rect: (aw, ah) => ({ w: Math.min(900, aw - 140), h: Math.min(ah - 14, 620) }),
    render(body, w) {
      const st = w.state; st.q = st.q || '';
      const all = Z.allLinks().filter((l) => !st.q || `${l.title} ${l.desc_en} ${l.desc_vi}`.toLowerCase().includes(st.q.toLowerCase()));
      const G = [['blogs', L('Blog & bài viết', 'Blogs & publications')], ['products', L('Sản phẩm & công cụ AI', 'Products & AI tools')], ['companies', L('Sáng lập & điều hành', 'Founded & run')]];
      body.innerHTML = `<label class="sr" for="lp-q">${L('Tìm liên kết', 'Search links')}</label><input id="lp-q" class="input" type="search" placeholder="${L('Tìm sản phẩm, công ty…', 'Search products, companies…')}" value="${esc(st.q)}">
        ${G.map(([g, t]) => { const ls = all.filter((l) => l.group === g); return ls.length ? `<h3 class="eyebrow" style="margin:16px 0 8px">${t} · ${ls.length}</h3><div class="lc-grid" data-g="${g}"></div>` : ''; }).join('')}
        ${all.length ? '' : `<div class="empty" style="color:var(--muted-inv)">${L('Không có liên kết phù hợp.', 'No matching links.')}</div>`}`;
      G.forEach(([g]) => { const host = body.querySelector(`[data-g="${g}"]`); if (host) all.filter((l) => l.group === g).forEach((l) => host.append(Z.linkCard(l))); });
      const q = body.querySelector('#lp-q');
      q.oninput = () => { st.q = q.value; const p = q.selectionStart; W.rerender('launchpad'); const n = body.querySelector('#lp-q'); n.focus(); n.setSelectionRange(p, p); };
    },
  });
})();
