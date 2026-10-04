/* Sample Knowledges posts shared by Zuey OS and the standalone article page.
   Text is illustrative. Locked sections never ship their text to a reader who cannot open them: only headings and a skeleton. */
window.ZART = (() => {
  'use strict';
  const SITE = 'https://zuey.me';
  const AUTHOR = { name: 'Duy Nguyen', handle: '@goonnguyen', url: SITE, avatar: 'assets/avatar.png', sameAs: ['https://x.com/goon_nguyen', 'https://github.com/mrgoonie', 'https://youtube.com/@imzuey', 'https://fb.com/mrgoonie', 'https://www.threads.net/@imzuey'] };
  const list = [
    { id: 'k1', title: 'Chia effort cho Claude Code sao cho hợp lý', cat: 'AI Engineering', paid: false, min: 6, date: '2026-09-28', updated: '2026-10-02', tags: ['claude-code', 'effort'], block: 'bars',
      excerpt: 'Khi nào nên để agent nghĩ lâu, khi nào cần trả lời nhanh: cách mình chia mức effort theo loại việc.',
      tldr: 'Việc tra cứu, sửa nhỏ dùng effort thấp; thiết kế, debug khó và review dùng effort cao. Đo thời gian và chi phí trước khi đổi mặc định.',
      takeaways: ['Chia việc theo độ mơ hồ, không theo độ dài.', 'Effort cao đáng tiền nhất ở bước thiết kế và review.', 'Ghi log chi phí mỗi tuần để chỉnh lại ngưỡng.'],
      faq: [['Effort cao có luôn cho kết quả tốt hơn?', 'Không. Với việc rõ ràng, effort cao chủ yếu tốn thời gian và token mà kết quả gần như không đổi.'], ['Nên bắt đầu từ mức nào?', 'Bắt đầu ở mức trung bình, rồi tăng riêng cho các bước thiết kế, debug và review.']] },
    { id: 'k2', title: '12 tháng Build in Public: con số và bài học', cat: 'Build in Public', paid: true, min: 11, date: '2026-09-20', updated: '2026-09-20', tags: ['bip', 'growth'], block: 'bars',
      excerpt: 'Nhìn lại một năm chia sẻ công khai: điều gì kéo người theo dõi, điều gì chỉ tốn thời gian.',
      tldr: 'Chia sẻ đều đặn quá trình làm thật kéo người theo dõi tốt hơn mọi mẹo tăng trưởng; số liệu minh bạch tạo niềm tin nhanh nhất.',
      takeaways: ['Lịch đăng đều quan trọng hơn bài “viral”.', 'Số liệu thật (kể cả xấu) được chia sẻ nhiều nhất.', 'Cộng đồng nhỏ, đúng người có giá trị hơn lượt xem.'],
      faq: [['Build in Public có hợp với sản phẩm B2B?', 'Có, nếu bạn chia sẻ cách giải quyết vấn đề của khách hàng thay vì chỉ khoe doanh thu.'], ['Bao lâu thì thấy kết quả?', 'Thường sau 3–6 tháng đăng đều mới có lượng người theo dõi ổn định.']] },
    { id: 'k3', title: 'Từ ý tưởng tới MCP server trong một buổi chiều', cat: 'AI Engineering', paid: true, min: 9, date: '2026-09-12', updated: '2026-09-15', tags: ['mcp', 'workflow'], block: 'flow',
      excerpt: 'Quy trình mình dùng để biến một API nội bộ thành công cụ mà Claude, ChatGPT và Cursor gọi được.',
      tldr: 'Bắt đầu từ 2–3 thao tác người dùng hay làm nhất, bọc API sẵn có thành tool MCP có mô tả rõ, rồi thêm OAuth sau khi đã chạy được.',
      takeaways: ['Mô tả tool tốt quan trọng hơn số lượng tool.', 'Dùng lại API và quyền sẵn có, đừng viết lại logic.', 'Thử với nhiều client (Claude, ChatGPT, Cursor) trước khi công bố.'],
      faq: [['Cần OAuth ngay từ đầu không?', 'Không bắt buộc. API key cá nhân đủ để thử; OAuth nên có trước khi mở cho người dùng.'], ['Một MCP server nên có bao nhiêu tool?', 'Ít và rõ: 3–8 tool với mô tả cụ thể thường hiệu quả hơn vài chục tool chồng chéo.']] },
    { id: 'k4', title: 'Khảo sát: bạn dùng AI agent cho việc gì?', cat: 'Cộng đồng', paid: false, min: 3, date: '2026-09-05', updated: '2026-09-05', tags: ['survey', 'agent'], block: 'survey',
      excerpt: 'Một khảo sát nhỏ trong cộng đồng Build in Public VN. Chọn một đáp án để xem kết quả.',
      tldr: 'Viết và tóm tắt vẫn là việc phổ biến nhất; lập trình đứng thứ hai và tăng nhanh nhất trong cộng đồng.',
      takeaways: ['Viết & tóm tắt dẫn đầu.', 'Lập trình tăng nhanh nhất.', 'Chăm sóc khách hàng còn ít người dùng agent.'],
      faq: [['Khảo sát lấy mẫu thế nào?', 'Thành viên cộng đồng Build in Public VN tự nguyện trả lời; kết quả chỉ mang tính tham khảo.'], ['Có xuất được dữ liệu không?', 'Thành viên có thể xuất kết quả dạng CSV từ trang khảo sát.']] },
    { id: 'k5', title: 'Chọn stack edge cho sản phẩm một người làm', cat: 'Sản phẩm', paid: true, min: 8, date: '2026-08-27', updated: '2026-09-01', tags: ['cloudflare', 'stack'], block: 'flow',
      excerpt: 'Vì sao mình chuyển các sản phẩm nhỏ sang chạy ở edge, và những giới hạn cần biết trước.',
      tldr: 'Edge giúp một người vận hành nhiều sản phẩm với chi phí thấp, nhưng cần chấp nhận giới hạn runtime và thiết kế dữ liệu từ đầu.',
      takeaways: ['Chỉ dùng Web API chuẩn trong code chạy ở edge.', 'Thiết kế dữ liệu cho D1/SQLite từ đầu.', 'Đo độ trễ thật ở nơi người dùng ở.'],
      faq: [['Edge có thay được server truyền thống?', 'Với phần lớn web app nhỏ thì có; việc nặng CPU hoặc chạy lâu vẫn cần server hoặc hàng đợi.'], ['Chi phí khởi đầu bao nhiêu?', 'Thường nằm trong gói miễn phí cho tới khi có lượng truy cập đáng kể.']] },
    { id: 'k6', title: 'Prompt cache và hoá đơn AI hằng tháng', cat: 'AI Engineering', paid: false, min: 5, date: '2026-08-15', updated: '2026-08-20', tags: ['cost', 'cache'], block: 'bars',
      excerpt: 'Ghi chép về cách giữ cache ổn định để chi phí AI không tăng vọt khi dùng agent cả ngày.',
      tldr: 'Giữ phần đầu prompt cố định (hệ thống, công cụ, tài liệu) và chỉ thêm nội dung mới ở cuối để cache trúng nhiều nhất.',
      takeaways: ['Đặt nội dung ít thay đổi ở đầu prompt.', 'Tránh chèn thời gian hay ID ngẫu nhiên vào phần cố định.', 'Theo dõi tỉ lệ cache hit hằng ngày.'],
      faq: [['Cache giảm được bao nhiêu chi phí?', 'Tuỳ khối lượng; phần đọc từ cache rẻ hơn nhiều so với token đầu vào thường.'], ['Cache hết hạn khi nào?', 'Sau một khoảng thời gian không dùng; giữ nhịp gọi đều giúp cache còn ấm.']] },
  ];
  /* body: intro paragraphs + sections; the figure block sits in "Cách làm" */
  const sections = (a) => [
    { id: 'boi-canh', h: 'Bối cảnh', p: ['Mình chạy nhiều sản phẩm cùng lúc với một đội rất nhỏ, nên mọi quy trình đều phải đủ gọn để một người duy trì được.', 'Trước khi đổi cách làm, mình ghi lại thời gian và chi phí của hai tuần gần nhất để có mốc so sánh.'] },
    { id: 'cach-lam', h: 'Cách làm', p: ['Bắt đầu từ một việc nhỏ, đo trước và sau, rồi mới mở rộng. Mỗi bước có checklist để cả agent và người cùng đọc được.', 'Khi một bước chạy ổn trong một tuần, mình mới đưa nó thành mặc định cho cả nhóm.'], block: true },
    { id: 'bai-hoc', h: 'Bài học', p: ['Đừng tối ưu sớm. Giữ log để lần sau so sánh. Và luôn hỏi: việc này có cần làm không?', 'Phần lớn cải thiện đến từ việc bỏ bớt bước thừa, không phải từ công cụ mới.'] },
  ];
  const intro = (a) => [a.excerpt, 'Bài này ghi lại cách mình làm thật trong vài tháng gần đây, kèm những chỗ đã sai và phải sửa.'];
  const plans = ['knowledges', 'combo', 'community'];
  /* who can read what: guests read a preview of every post; paid posts need a Knowledges, Combo or Community plan */
  const access = (a, s) => {
    const admin = s.role === 'admin', member = s.role === 'member' || admin;
    if (admin || (member && (!a.paid || plans.includes(s.plan)))) return { full: true, open: sections(a).length };
    return { full: false, open: a.paid ? 0 : 1, reason: !member ? (a.paid ? 'guest-paid' : 'guest') : 'plan' };
  };
  const words = (a) => [...intro(a), ...sections(a).flatMap((s) => [s.h, ...s.p]), ...a.faq.flat()].join(' ').split(/\s+/).length;
  const url = (a) => `${SITE}/knowledges/${a.id}`;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const blockHTML = (a) => {
    if (a.block === 'bars') {
      const v = [['T1', 38], ['T2', 52], ['T3', 47], ['T4', 66], ['T5', 74], ['T6', 91]];
      return `<figure><div class="bars">${v.map(([k, n]) => `<div><b><span>${n}</span><i style="height:${Math.round(n * 0.8)}%"></i></b><span>${k}</span></div>`).join('')}</div><figcaption>Biểu đồ mẫu · số liệu minh hoạ</figcaption></figure>`;
    }
    if (a.block === 'flow') return '<figure><div class="flow"><span>Ý tưởng</span><em>→</em><span>API</span><em>→</em><span>MCP tool</span><em>→</em><span>Claude · ChatGPT · Cursor</span></div><figcaption>Sơ đồ mẫu</figcaption></figure>';
    const opts = [['Viết & tóm tắt', 41], ['Lập trình', 33], ['Nghiên cứu', 17], ['Chăm sóc khách', 9]];
    return `<figure><form class="survey" data-survey>${opts.map(([o, p], i) => `<label><span class="fill" style="width:0"></span><input type="radio" name="sv" value="${i}"><span>${o}</span><span class="pct" data-p="${p}"></span></label>`).join('')}</form><figcaption>Khảo sát mẫu · kết quả minh hoạ</figcaption></figure>`;
  };
  /* skeleton lines for a locked section: widths vary so it reads as text, but no words are sent */
  const skel = (n, seed) => Array.from({ length: n }, (_, i) => `<span class="sk-l" style="width:${[96, 88, 93, 72, 90, 64, 85][(i + seed) % 7]}%"></span>`).join('');
  /* cta: the sign-up or plan box laid over the blurred, locked part */
  const bodyHTML = (a, acc, cta) => {
    const S = sections(a);
    const open = S.slice(0, acc.open), shut = S.slice(acc.open);
    const sec = (s) => `<section id="${s.id}" aria-labelledby="${s.id}-h"><h2 id="${s.id}-h">${esc(s.h)}</h2>${s.p.map((p) => `<p>${esc(p)}</p>`).join('')}${s.block ? blockHTML(a) : ''}</section>`;
    return `${intro(a).map((p) => `<p>${esc(p)}</p>`).join('')}${open.map(sec).join('')}
      ${shut.length ? `<div class="lock-wrap"><div class="paywalled" data-locked>${shut.map((s, i) => `<section id="${s.id}" aria-labelledby="${s.id}-h"><h2 id="${s.id}-h">${esc(s.h)}</h2><div class="sk-p" aria-hidden="true">${skel(s.block ? 9 : 5, i)}</div></section>`).join('')}</div>${cta || ''}</div>` : ''}`;
  };
  /* copy for the box over the locked part, by reason */
  const lockCopy = (acc, planName) => ({
    guest: { h: ['Đăng ký miễn phí để đọc hết bài', 'Sign up free to read the whole post'], p: ['Tạo tài khoản zuey.me miễn phí để đọc trọn các bài miễn phí, lưu bài và hỏi Zuey AI về nội dung.', 'Create a free zuey.me account to read free posts in full, save posts and ask Zuey AI about them.'] },
    'guest-paid': { h: ['Bài dành cho thành viên Knowledges', 'For Knowledges members'], p: ['Gói Knowledges, Kết hợp và Cộng đồng mở toàn bộ bài trả phí. Gói Zuey AI chỉ đọc phần xem trước.', 'Knowledges, Combo and Community unlock paid posts in full. The Zuey AI plan reads previews only.'] },
    plan: { h: ['Nâng cấp để đọc hết bài', 'Upgrade to read the whole post'], p: [`Gói hiện tại (${planName || '—'}) chỉ đọc phần xem trước. Gói Knowledges, Kết hợp và Cộng đồng mở toàn bộ bài trả phí.`, `Your current plan (${planName || '—'}) reads previews only. Knowledges, Combo and Community unlock paid posts.`] },
  })[acc.reason];
  /* everything a crawler and an answer engine needs, rendered server-side on zuey.me */
  const seo = (a, acc) => {
    const u = url(a), desc = a.tldr, img = `${SITE}/og/knowledges/${a.id}.png`;
    const locked = !acc.full;
    const article = {
      '@context': 'https://schema.org', '@type': 'BlogPosting', headline: a.title, description: desc, image: img, url: u, mainEntityOfPage: u,
      inLanguage: 'vi-VN', datePublished: a.date, dateModified: a.updated, articleSection: a.cat, keywords: a.tags.join(', '), wordCount: words(a), timeRequired: `PT${a.min}M`,
      author: { '@type': 'Person', name: AUTHOR.name, url: AUTHOR.url, sameAs: AUTHOR.sameAs },
      publisher: { '@type': 'Organization', name: 'zuey.me', url: SITE, logo: { '@type': 'ImageObject', url: `${SITE}/favicon.png` } },
      isAccessibleForFree: !a.paid && !locked,
      ...(locked ? { hasPart: { '@type': 'WebPageElement', isAccessibleForFree: false, cssSelector: '.paywalled' } } : {}),
      abstract: a.tldr,
    };
    const crumbs = { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [['Zuey', SITE], ['Knowledges', `${SITE}/knowledges`], [a.cat, `${SITE}/knowledges?cat=${encodeURIComponent(a.cat)}`], [a.title, u]].map(([name, item], i) => ({ '@type': 'ListItem', position: i + 1, name, item })) };
    const faq = { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: a.faq.map(([q, ans]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: ans } })) };
    const meta = [
      ['title', `${a.title} · Zuey's Knowledges`],
      ['meta', { name: 'description', content: desc }],
      ['link', { rel: 'canonical', href: u }],
      ['link', { rel: 'alternate', type: 'text/markdown', href: `${u}.md`, title: 'Markdown' }],
      ['link', { rel: 'alternate', hreflang: 'vi', href: u }],
      ['meta', { name: 'robots', content: 'index, follow, max-snippet:-1, max-image-preview:large' }],
      ['meta', { name: 'author', content: AUTHOR.name }],
      ['meta', { property: 'og:type', content: 'article' }],
      ['meta', { property: 'og:title', content: a.title }],
      ['meta', { property: 'og:description', content: desc }],
      ['meta', { property: 'og:url', content: u }],
      ['meta', { property: 'og:image', content: img }],
      ['meta', { property: 'og:locale', content: 'vi_VN' }],
      ['meta', { property: 'article:published_time', content: a.date }],
      ['meta', { property: 'article:modified_time', content: a.updated }],
      ['meta', { property: 'article:section', content: a.cat }],
      ...a.tags.map((t) => ['meta', { property: 'article:tag', content: t }]),
      ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
      ['meta', { name: 'twitter:creator', content: '@goon_nguyen' }],
    ];
    return { meta, ld: [article, crumbs, faq] };
  };
  const plainText = (a) => [a.title, ...intro(a), ...sections(a).flatMap((s) => [s.h, ...s.p])].join('\n\n');
  return { SITE, AUTHOR, list, sections, intro, access, bodyHTML, lockCopy, seo, url, words, esc, plainText, find: (id) => list.find((x) => x.id === id) };
})();
