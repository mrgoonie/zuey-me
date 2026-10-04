/* Real zuey.me content and components shared by the three proposals (no build step). */
(function () {
  var Z = (window.Z = {});

  Z.profile = {
    name: 'Duy Nguyen /zuey/',
    short: 'Duy Nguyen',
    handle: '@goonnguyen',
    avatar: 'avatar.png',
    bio: '“F*ck Around & Find Out” Specialist 😎 CTO/Co-founder @TOPGROUP, DIGITOP, XINCHAO Live Music, AgentKit & NextLevelBuilder. Founder of “Build in Public VN” Community.',
  };
  Z.socials = [
    ['instagram', 'https://www.instagram.com/imzuey', 'Instagram'],
    ['tiktok', 'https://www.tiktok.com/@mrgoonvn', 'TikTok'],
    ['whatsapp', 'https://wa.me/imzuey', 'WhatsApp'],
    ['youtube', 'https://youtube.com/@imzuey', 'YouTube'],
    ['facebook', 'https://fb.com/mrgoonie', 'Facebook'],
    ['threads', 'https://www.threads.com/@imzuey', 'Threads'],
    ['x', 'https://x.com/goon_nguyen', 'X'],
  ];
  Z.blogs = [
    ['FA&FO Specialist', 'English', 'Substack newsletter on AI engineering, products & experiments', 'https://faafospecialist.substack.com/'],
    ['My Solo Playbook', 'Tiếng Việt', 'Hành trình xây dựng sản phẩm và chia sẻ thực chiến', 'https://goonnguyen.substack.com/'],
  ];
  Z.offers = [
    ['Articles', 'Notes, charts and surveys', '/articles'],
    ['Zuey Reads', 'What I am reading, summarized', '/reads'],
    ['AI Workflows', 'How I work with AI', '/workflows'],
    ['For Business', '1:1 consultation · $1,999', '/business'],
  ];
  Z.ventures = [
    ['topgroup', 'TOP Group', 'Leading production & creative technology conglomerate', 'https://wearetopgroup.com'],
    ['xinchao', 'Xin Chào Live Music', 'Connecting top Vietnamese artists and global music', 'https://xinchao.world'],
    ['digitop', 'Digitop', 'Digital agency & AI-driven development house', 'https://digitop.ai'],
    ['nextlevel', 'Next Level Builder', 'Venture builder for high-velocity products', 'https://nextlevelbuilder.io'],
    ['tose', 'TOSE', 'Fast, reliable cloud infrastructure', 'https://tose.sh'],
    ['bipvn', 'Build in Public VN', 'The #1 community for indie hackers in Vietnam', 'https://bip.vn'],
  ];
  Z.products = [
    ['agentkit', 'AgentKit.best', 'AI engineering framework for autonomous agents', 'https://agentkit.best'],
    ['dewee', 'Dewee.sh', 'Agent runtime for human-AI teamwork', 'https://dewee.sh'],
    ['goclaw', 'GoClaw.sh', 'Go runtime gateway for distributed agents', 'https://goclaw.sh'],
    ['tose', 'tose.sh', 'Edge cloud deployment & serverless', 'https://tose.sh'],
    ['indieboosting', 'IndieBoosting', 'SaaS distribution network for indie hackers', 'https://indieboosting.com'],
    ['uupm', 'uupm.cc', 'UI UX Pro Max design skill', 'https://uupm.cc'],
    ['agentwiki', 'AgentWiki.cc', 'Docs publishing for AI agents', 'https://agentwiki.cc'],
    ['agentbrain', 'AgentBrain.sh', 'Shared memory for AI swarms', 'https://agentbrain.sh'],
    ['skillx', 'SkillX.sh', 'Open agent skill registry', 'https://skillx.sh'],
    ['findyourai', 'FindYourAI.tools', 'Curated AI tools directory', 'https://findyourai.tools'],
    ['vidcap', 'VidCap', 'AI video captioning', 'https://vidcap.zuey.me'],
    ['reviewweb', 'ReviewWeb.site', 'SEO audit & site health', 'https://reviewweb.site'],
  ];
  // Live /api/v1/reads items (titles, authors and covers as synced from AnyMD).
  Z.reads = [
    { t: 'Best AI agent harnesses and how I use them (pi, omp, Zcode)', a: '0xSero', k: 'YouTube', w: 4855, img: 'covers/read-1.jpg', u: 'https://m.youtube.com/watch?v=eo0As3rieA8', s: 'Pi, OMP và Zcode: codebase nhỏ, sub-agent, cache hit rate và cách chạy nhiều model cùng lúc.' },
    { t: 'Using Claude Code: Spending your effort', a: 'Thariq', k: 'X', w: 1929, img: 'covers/read-2.jpg', u: 'https://x.com/trq212/status/2103576349499855160', s: 'Mức effort quyết định model kiểm chứng và test edge case kỹ tới đâu.' },
    { t: 'Your MCP Doesn’t Need 30 Tools: It Needs Code', a: 'Armin Ronacher', k: 'Web', img: 'covers/read-3.png', u: 'https://lucumr.pocoo.org/2025/8/18/code-mcps/', s: 'Thay vì 30 tool rời, cho agent một môi trường để viết code.' },
    { t: 'MCP vs CLI: Benchmarking Tools for Coding Agents', a: 'Mario Zechner', k: 'Web', img: 'covers/read-4.jpg', u: 'https://mariozechner.at/posts/2025-08-15-mcp-vs-cli/', s: 'Benchmark MCP và CLI cho coding agent.' },
    { t: 'What if you don’t need MCP at all?', a: 'Mario Zechner', k: 'Web', img: 'covers/read-5.png', u: 'https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/', s: 'Nếu agent không cần MCP thì sao?' },
    { t: 'OpenAI Understands Something Important and Rare', a: 'David George', k: 'X', img: 'covers/read-6.jpg', u: 'https://x.com/davidgeorge83/status/2104576086101426620', s: 'Góc nhìn của a16z về chiến lược của OpenAI.' },
    { t: 'Pi Durable', a: 'Earendil', k: 'Web', img: 'covers/read-7.png', u: 'https://earendil.com/posts/pi-durable/', s: 'Earendil giới thiệu Pi Durable.' },
    { t: 'Automating eval design and hillclimbing with Claude', a: 'Lance Martin', k: 'Web', img: '', u: 'https://claude.dev/blog/automating-eval-design-and-hillclimbing/', s: 'Tự động hoá thiết kế eval và hillclimbing với Claude.' },
  ];
  Z.plans = [
    ['knowledges', 'Knowledges', 9, 'Đọc toàn bộ bài viết'],
    ['ai', 'Zuey AI', 9, 'Chat với Zuey AI'],
    ['combo', 'Kết hợp', 19, 'Cả hai'],
    ['community', 'Cộng đồng', 29, 'Kết hợp + nhóm kín với Duy'],
  ];
  Z.discount = { 1: 0, 3: 5, 6: 10, 12: 20 };
  Z.rate = 26000;
  Z.vnd = function (usd, months) {
    var monthly = Math.ceil((usd * Z.rate) / 1000) * 1000;
    return Math.ceil((monthly * months * (100 - Z.discount[months])) / 100 / 1000) * 1000;
  };
  Z.fmtVnd = function (n) { return n.toLocaleString('vi-VN') + ' ₫'; };
  Z.suggestions = ['MCP hay CLI cho coding agent?', 'Effort trong Claude Code là gì?', 'Bắt đầu build in public thế nào?', 'AgentKit khác gì ClaudeKit?'];

  /* Brand icons, mirroring src/components/BrandIcons.tsx. */
  var SOCIAL = {
    x: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>',
    facebook: '<svg viewBox="0 0 24 24" fill="#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>',
    youtube: '<svg viewBox="0 0 24 24" fill="#FF0000"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
    instagram: '<svg viewBox="0 0 24 24"><defs><radialGradient id="igg" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="matrix(24 0 0 24 2.4 22.8)"><stop stop-color="#FD5"/><stop offset=".5" stop-color="#FF543E"/><stop offset="1" stop-color="#C837AB"/></radialGradient></defs><rect width="24" height="24" rx="6" fill="url(#igg)"/><path d="M12 7a5 5 0 100 10 5 5 0 000-10zm0 8.2a3.2 3.2 0 110-6.4 3.2 3.2 0 010 6.4zm5.2-8.4a1.2 1.2 0 11-2.4 0 1.2 1.2 0 012.4 0z" fill="#fff"/></svg>',
    tiktok: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.24 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z"/></svg>',
    threads: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 7.847c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.65Zm1.003-11.69c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221z"/></svg>',
    whatsapp: '<svg viewBox="0 0 24 24" fill="#25D366"><path d="M12.031 0C5.385 0 0 5.385 0 12.031c0 2.122.554 4.19 1.608 6.012L.055 24l6.113-1.603c1.761.96 3.751 1.467 5.863 1.467 6.646 0 12.031-5.385 12.031-12.033C24.062 5.385 18.677 0 12.031 0zm7.042 16.994c-.292.818-1.464 1.5-2.034 1.595-.54.09-1.246.128-2.012-.118-.466-.149-1.066-.346-1.84-.68-3.238-1.402-5.334-4.66-5.496-4.877-.162-.217-1.31-1.745-1.31-3.328 0-1.583.83-2.361 1.123-2.686.292-.325.64-.407.854-.407.214 0 .428.002.614.011.199.01.463-.075.723.548.267.639.914 2.228.995 2.39.08.163.134.354.027.571-.107.217-.16.353-.32.541-.16.188-.337.42-.48.563-.16.16-.328.334-.141.654.187.32.83 1.368 1.782 2.215 1.226 1.092 2.259 1.43 2.58 1.59.32.16.507.134.693-.08.187-.214.799-.933 1.013-1.253.214-.32.427-.267.72-.16.293.107 1.866.88 2.186 1.04.32.16.533.24.613.373.08.134.08.773-.213 1.591z"/></svg>',
    substack: '<svg viewBox="0 0 24 24"><path d="M22.539 8.242H1.46V5.406h21.08v2.836zM1.46 10.812V24L12 18.11 22.54 24V10.812H1.46zM22.54 0H1.46v2.836h21.08V0z" fill="#FF6719"/></svg>',
  };
  var BRAND = {
    topgroup: ['#000', '<span style="font-size:.26em;color:#a3a3a3;display:block">TOP</span><span style="font-size:.3em">GROUP</span>'],
    xinchao: ['#000', '<span style="font-size:.24em;color:#F4D03F;display:block">XIN</span><span style="font-size:.24em;color:#F4D03F">CHÀO</span>'],
    digitop: ['#000', '<svg viewBox="0 0 32 32" style="width:80%;height:80%" fill="none"><circle cx="16" cy="16" r="14" stroke="#00E5FF" stroke-width="2.5" stroke-dasharray="6 4"/><circle cx="16" cy="16" r="8" stroke="#00E5FF" stroke-width="2"/><circle cx="16" cy="16" r="3" fill="#00E5FF"/></svg>'],
    nextlevel: ['linear-gradient(45deg,#7e22ce,#6366f1)', '<span style="font-size:.32em">NLB</span>'],
    tose: ['#0ea5e9', '<svg viewBox="0 0 24 24" style="width:60%;height:60%"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" fill="#fff"/></svg>'],
    bipvn: ['linear-gradient(135deg,#312e81,#581c87,#020617)', '<span style="font:700 .28em var(--mono)">#bip</span>'],
    agentkit: ['linear-gradient(135deg,#f97316,#d97706,#dc2626)', '<span style="font-size:.34em">AK</span>'],
    dewee: ['#059669', '<span style="font-size:.45em">🐾</span>'],
    goclaw: ['#0891b2', '<span style="font-size:.45em">🦀</span>'],
    indieboosting: ['linear-gradient(45deg,#9333ea,#ec4899)', '<span style="font-size:.45em">🚀</span>'],
    uupm: ['linear-gradient(90deg,#7c3aed,#c026d3)', '<span style="font-size:.45em">✨</span>'],
    agentwiki: ['#2563eb', '<span style="font-size:.45em">📖</span>'],
    agentbrain: ['#4338ca', '<span style="font-size:.45em">🧠</span>'],
    skillx: ['#f59e0b', '<span style="font-size:.45em">⚡</span>'],
    findyourai: ['#0d9488', '<span style="font-size:.45em">🔍</span>'],
    vidcap: ['#f43f5e', '<span style="font-size:.45em">🎬</span>'],
    reviewweb: ['#047857', '<span style="font-size:.45em">📊</span>'],
  };
  Z.icon = function (key, size) {
    size = size || 32;
    if (SOCIAL[key]) return '<span class="bi" style="width:' + size + 'px;height:' + size + 'px;border-radius:0;background:none;color:inherit">' + SOCIAL[key].replace('<svg', '<svg style="width:100%;height:100%"') + '</span>';
    var b = BRAND[key] || ['#a8a29e', key.slice(0, 2).toUpperCase()];
    return '<span class="bi" style="width:' + size + 'px;height:' + size + 'px;background:' + b[0] + ';font-size:' + size + 'px">' + b[1] + '</span>';
  };

  /* Top bar with the live HomeShell controls. */
  var I = {
    weather: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v2M4.93 4.93l1.41 1.41M20 12h2M19.07 4.93l-1.41 1.41M15.95 12.5A4 4 0 1 0 8 12"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20"/></svg>',
    cmd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
  };
  Z.I = I;
  Z.topbar = function (opts) {
    opts = opts || {};
    return '<header class="zt"><a class="wm" href="#">zuey.me <small>Duy Nguyen</small></a>' +
      '<button class="chip" data-weather aria-pressed="false">' + I.weather + '<span class="lbl">Weather</span></button>' +
      '<button class="chip">' + I.globe + '<span class="lbl">VI</span></button>' +
      '<button class="chip" data-cmd>' + I.cmd + '<span class="lbl">Commands</span><kbd>Ctrl K</kbd></button>' +
      '<a class="chip" href="#">' + I.user + '<span class="lbl">Account</span></a>' +
      '<button class="chip" data-mascot-toggle aria-pressed="true" title="Ẩn/hiện Zuey">' + I.eye + '</button></header>';
  };

  /* Rain backdrop. */
  Z.rain = function (host, on) {
    var r = host.querySelector(':scope > .rain');
    if (!on) { if (r) r.remove(); return; }
    if (r) return;
    r = document.createElement('div'); r.className = 'rain'; r.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 90; i++) {
      var d = document.createElement('i');
      d.style.left = Math.random() * 100 + '%';
      d.style.animationDuration = 0.5 + Math.random() * 0.5 + 's';
      d.style.animationDelay = -Math.random() * 2 + 's';
      r.appendChild(d);
    }
    host.prepend(r);
  };

  /* Sprite player using the cell grid and frame timings of public/mascot/manifest.json. */
  var F = {
    'idle-0': [0, 0], 'idle-blink': [1, 0], 'idle-breathe': [2, 0], 'idle-1': [3, 0],
    'walk-0': [0, 1], 'walk-1': [1, 1], 'walk-2': [2, 1], 'walk-3': [3, 1],
    'wave-0': [0, 2], 'wave-1': [1, 2], 'wave-2': [2, 2], 'wave-3': [3, 2],
    thinking: [0, 3], happy: [1, 3], surprised: [2, 3], talking: [3, 3],
  };
  var A = {
    idle: { loop: 1, f: [['idle-0', 1400], ['idle-blink', 140], ['idle-breathe', 700], ['idle-1', 1100]] },
    walk: { loop: 1, f: [['walk-0', 125], ['walk-1', 125], ['walk-2', 125], ['walk-3', 125]] },
    wave: { f: [['wave-0', 120], ['wave-1', 160], ['wave-2', 320], ['wave-1', 160], ['wave-2', 320], ['wave-3', 200]] },
    talk: { loop: 1, f: [['talking', 180], ['idle-0', 140]] },
    thinking: { f: [['thinking', 1600]] },
    happy: { f: [['happy', 1400]] },
    surprised: { f: [['surprised', 1200]] },
  };
  var reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  Z.reduced = reduced;
  Z.Mascot = function (el, size) {
    this.el = el; this.size = size; this.timer = 0; this.anim = '';
    el.classList.add('mascot');
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', 'Zuey, nhân vật đồng hành');
    this.resize(size);
    this.play('idle');
  };
  Z.Mascot.prototype.resize = function (size) {
    this.size = size;
    this.el.style.width = size + 'px'; this.el.style.height = size + 'px';
    this.el.style.backgroundSize = size * 4 + 'px ' + size * 4 + 'px';
    if (this.cur) this.show(this.cur);
  };
  Z.Mascot.prototype.show = function (name) {
    var c = F[name]; this.cur = name;
    this.el.style.backgroundPosition = -c[0] * this.size + 'px ' + -c[1] * this.size + 'px';
  };
  Z.Mascot.prototype.play = function (name, then) {
    var self = this, a = A[name] || A.idle, i = 0;
    clearTimeout(this.timer); this.anim = name;
    if (reduced) { this.show(a.f[0][0]); if (!a.loop) this.timer = setTimeout(function () { self.play(then || 'idle'); }, 1400); return; }
    var until = a.loop && name === 'talk' ? Date.now() + 2600 : Infinity;
    (function step() {
      self.show(a.f[i][0]);
      self.timer = setTimeout(function () {
        i++;
        if (i >= a.f.length) {
          if (!a.loop || Date.now() > until) return self.play(then || 'idle');
          i = 0;
        }
        step();
      }, a.f[i][1]);
    })();
  };

  /* Live public GitHub activity of @mrgoonie (same source as GithubActivity.tsx). */
  // Falls back to a snapshot (type, repo, time only) where the live API is blocked or rate limited.
  Z.github = function (cb) {
    var get = function (url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); };
    get('https://api.github.com/users/mrgoonie/events/public?per_page=100')
      .catch(function () { return get('github-events.json'); })
      .then(function (ev) { cb(null, ev); })
      .catch(function (e) { cb(e); });
  };
  Z.heatmap = function (events, days) {
    days = days || 35;
    var counts = {}, today = new Date(); today.setHours(0, 0, 0, 0);
    (events || []).forEach(function (e) { var d = e.created_at.slice(0, 10); counts[d] = (counts[d] || 0) + 1; });
    var html = '', total = 0;
    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(today); d.setDate(d.getDate() - i);
      var key = d.toISOString().slice(0, 10), n = counts[key] || 0; total += n;
      var l = n === 0 ? 0 : n < 3 ? 1 : n < 6 ? 2 : n < 12 ? 3 : 4;
      html += '<span data-l="' + l + '" title="' + key + ': ' + n + ' sự kiện"></span>';
    }
    return { html: '<div class="heat">' + html + '</div>', total: total };
  };
  Z.eventLabel = function (e) {
    var t = { PushEvent: 'Pushed', PullRequestEvent: 'Pull request', IssuesEvent: 'Issue', IssueCommentEvent: 'Commented', CreateEvent: 'Created', ReleaseEvent: 'Released', WatchEvent: 'Starred', ForkEvent: 'Forked', PullRequestReviewEvent: 'Reviewed' }[e.type] || e.type.replace('Event', '');
    return t + ' · ' + e.repo.name;
  };
  Z.ago = function (iso) {
    var m = Math.round((Date.now() - new Date(iso)) / 60000);
    return m < 60 ? m + ' phút trước' : m < 1440 ? Math.round(m / 60) + ' giờ trước' : Math.round(m / 1440) + ' ngày trước';
  };

  /* Wires the topbar chips (weather, mascot toggle) and the Ctrl/⌘K palette like the live CommandPalette. */
  Z.controls = function (o) {
    var w = document.querySelector('[data-weather]'), m = document.querySelector('[data-mascot-toggle]');
    w.onclick = function () { var on = w.getAttribute('aria-pressed') !== 'true'; w.setAttribute('aria-pressed', on); Z.rain(o.rainHost, on); if (o.onWeather) o.onWeather(on); };
    m.onclick = function () { var on = m.getAttribute('aria-pressed') !== 'true'; m.setAttribute('aria-pressed', on); document.body.classList.toggle('hidden-mascot', !on); };
    var cmds = o.commands || [['Hỏi Zuey AI', 'Chat'], ['Zuey Reads', 'Trang'], ['Articles', 'Trang'], ['Xem gói thành viên', 'Gói'], ['Đặt lịch tư vấn', 'Business'], ['Đổi ngôn ngữ', 'VI · EN · 中文 · 한국어 · 日本語'], ['Thời tiết & nền', 'Weather'], ['MCP & API', 'Developer']];
    var pal = document.createElement('div');
    pal.className = 'pal'; pal.setAttribute('role', 'dialog'); pal.setAttribute('aria-label', 'Commands');
    pal.innerHTML = '<div class="box"><input placeholder="Gõ lệnh hoặc tìm…" aria-label="Tìm lệnh"><div></div></div>';
    document.body.appendChild(pal);
    var input = pal.querySelector('input'), list = pal.querySelector('.box > div');
    function render() { var v = input.value.toLowerCase(); list.innerHTML = cmds.filter(function (c) { return c[0].toLowerCase().indexOf(v) > -1; }).map(function (c) { return '<a href="' + (c[2] || '#') + '">' + c[0] + '<span>' + c[1] + '</span></a>'; }).join(''); }
    function open() { pal.classList.add('on'); input.value = ''; render(); input.focus(); }
    document.querySelector('[data-cmd]').onclick = open;
    input.oninput = render;
    list.onclick = function () { pal.classList.remove('on'); };
    addEventListener('keydown', function (e) { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); open(); } if (e.key === 'Escape') pal.classList.remove('on'); });
    pal.onclick = function (e) { if (e.target === pal) pal.classList.remove('on'); };
  };

  /* Demo answers for the sign-in gated Zuey AI chat. */
  Z.answer = function (text) {
    return /mcp|cli/i.test(text)
      ? 'Với coding agent, Zuey nghiêng về CLI + code: model viết script ngắn thay vì gọi 30 tool rời, ít token và dễ debug. MCP hợp khi cần auth và khám phá tool.<div class="src"><a href="#">MCP vs CLI ↗</a><a href="#">Your MCP Doesn’t Need 30 Tools ↗</a></div>'
      : 'Đăng nhập để mình trả lời từ bài viết của Zuey, kèm nguồn. Gói AI $9/tháng, 300 lượt hỏi.<div class="src"><a href="#">Đăng nhập</a><a href="#">Xem gói</a></div>';
  };

  /* Broken remote covers fall back to a warm tile instead of a broken image. */
  Z.cover = function (src, alt) {
    return src ? '<img src="' + src + '" alt="' + (alt || '') + '" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement(\'span\'),{className:\'cover-fallback\'}))">' : '<span class="cover-fallback"></span>';
  };
  Z.esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
})();
