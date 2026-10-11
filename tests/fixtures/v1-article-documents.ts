/**
 * Schema v1 article documents as they are stored today, one per shape that existing articles use.
 * The compatibility test renders them through every surface and compares against snapshots recorded
 * before the block registry existed, so a refactor can never silently change how stored articles read.
 */

const YT = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

/** Every v1 block type at least once, with optional fields both set and omitted. */
export const KITCHEN_SINK = {
  version: 1,
  blocks: [
    { id: 'h1', type: 'heading', level: 1, text: 'Tổng quan **bài viết**' },
    { id: 'p1', type: 'paragraph', text: 'Đoạn mở đầu với *nghiêng*, ~~gạch~~, ==tô sáng==, `code` và [link](https://zuey.me).\nDòng thứ hai.' },
    { id: 'h2', type: 'heading', level: 2, text: 'Danh sách' },
    { id: 'l1', type: 'list', style: 'bullet', items: ['Một', 'Hai **đậm**'] },
    { id: 'l2', type: 'list', style: 'number', items: ['Bước 1', 'Bước 2'] },
    { id: 'c1', type: 'checklist', items: [{ text: 'Xong', checked: true }, { text: 'Chưa', checked: false }] },
    { id: 'q1', type: 'quote', text: 'Trích dẫn hay', cite: 'Ai đó' },
    { id: 'q2', type: 'quote', text: 'Không nguồn' },
    { id: 'co1', type: 'callout', tone: 'info', text: 'Lưu ý' },
    { id: 'co2', type: 'callout', tone: 'tip', text: 'Mẹo có icon', icon: 'rocket' },
    { id: 'co3', type: 'callout', tone: 'warn', text: 'Cảnh báo' },
    { id: 'code1', type: 'code', language: 'ts', code: 'const x: number = 1;\nconsole.log(x);' },
    { id: 'code2', type: 'code', language: '', code: 'plain text' },
    { id: 'd1', type: 'divider' },
    { id: 'img1', type: 'image', url: 'https://media.zuey.me/a.png', alt: 'Ảnh A', caption: 'Chú thích A', width: 800, height: 1200 },
    { id: 'img2', type: 'image', url: 'https://media.zuey.me/b.png', alt: '' },
    { id: 'e1', type: 'embed', url: YT, provider: 'youtube', caption: 'Video' },
    { id: 'e2', type: 'embed', url: 'https://example.com/page', provider: 'generic' },
    { id: 't1', type: 'table', headers: ['Tên', 'Giá'], rows: [['A', '**1**'], ['B|x', '2']] },
    { id: 'ch1', type: 'chart', kind: 'bar', title: 'Doanh thu', labels: ['Q1', 'Q2'], series: [{ name: '2025', data: [1, 2] }, { name: '2026', data: [3, 4] }] },
    { id: 'ch2', type: 'chart', kind: 'pie', labels: ['A', 'B'], series: [{ name: 'S', data: [60, 40] }] },
    { id: 'dg1', type: 'diagram', syntax: 'mermaid', source: 'graph TD\n  A --> B', caption: 'Luồng' },
    { id: 's1', type: 'survey', question: 'Bạn thích gì?', options: [{ id: 'o1', label: 'Mèo' }, { id: 'o2', label: 'Chó' }], allowMultiple: true },
    {
      id: 'lay1', type: 'layout', variant: 'bento', cols: { base: 1, md: 2, lg: 3 }, gap: 'lg',
      children: [
        { span: { base: 1, md: 2, lg: 2 }, rowSpan: 2, blocks: [{ id: 'lp1', type: 'paragraph', text: 'Ô lớn' }] },
        { span: 1, blocks: [{ id: 'li1', type: 'icon', name: 'lightbulb', size: 'lg', tone: 'accent', label: 'Ý tưởng', align: 'center' }] },
        {
          blocks: [{
            id: 'lay2', type: 'layout', variant: 'columns', cols: { base: 1, md: 2, lg: 2 },
            children: [{ blocks: [{ id: 'lp2', type: 'paragraph', text: 'Lồng 1' }] }, { blocks: [{ id: 'lp3', type: 'paragraph', text: 'Lồng 2' }] }],
          }],
        },
      ],
    },
    { id: 'int1', type: 'interactive', title: 'Demo', html: '<p>Hi</p>', css: 'p{color:red}', js: 'console.log(1)', height: 300, caption: 'Thử nhé' },
    { id: 'm1', type: 'math', tex: 'E = mc^2', caption: 'Einstein' },
    {
      id: 'g1', type: 'gallery', caption: 'Album',
      images: [{ url: 'https://media.zuey.me/g1.png', alt: 'G1', width: 640, height: 480, caption: 'Một' }, { url: 'https://media.zuey.me/g2.png', alt: 'G2' }],
    },
    { id: 'au1', type: 'audio', url: 'https://media.zuey.me/a.mp3', title: 'Podcast', caption: 'Tập 1' },
    { id: 'v1', type: 'video', url: 'https://media.zuey.me/v.mp4', poster: 'https://media.zuey.me/p.png', title: 'Clip' },
    { id: 'f1', type: 'file', url: 'https://media.zuey.me/doc.pdf', name: 'tai-lieu.pdf', sizeBytes: 123456, caption: 'Tài liệu' },
    { id: 'f2', type: 'file', url: 'https://media.zuey.me/data.csv', name: 'data.csv' },
    { id: 'bm1', type: 'bookmark', url: 'https://example.com/post', title: 'Bài hay', description: 'Mô tả', image: 'https://example.com/i.png', siteName: 'Example' },
    { id: 'bm2', type: 'bookmark', url: 'https://example.org/' },
    {
      id: 'tg1', type: 'toggle', summary: 'Xem **thêm**', open: true,
      blocks: [{ id: 'tp1', type: 'paragraph', text: 'Bên trong' }, { id: 'tc1', type: 'code', language: 'js', code: 'let a = 1;' }],
    },
    { id: 'i1', type: 'icon', name: 'sparkles', size: 'md', tone: 'default' },
  ],
} as const;

/** A typical prose article: the shape most stored articles have. */
export const PROSE_ARTICLE = {
  version: 1,
  blocks: [
    { id: 'a1', type: 'heading', level: 1, text: 'Mở đầu' },
    { id: 'a2', type: 'paragraph', text: 'Một đoạn văn dài vừa phải để kiểm tra trọng số paywall. '.repeat(6) },
    { id: 'a3', type: 'image', url: 'https://media.zuey.me/cover.jpg', alt: 'Bìa', width: 1600, height: 900 },
    { id: 'a4', type: 'heading', level: 2, text: 'Phần thành viên' },
    { id: 'a5', type: 'paragraph', text: 'Nội dung dành cho thành viên. '.repeat(10) },
    { id: 'a6', type: 'heading', level: 2, text: 'Kết luận' },
    { id: 'a7', type: 'paragraph', text: 'Hết bài.' },
  ],
} as const;

/** A stored document with blocks that today's rules reject; reads recover it block by block. */
export const LEGACY_STORED = {
  version: 1,
  blocks: [
    { id: 'p1', type: 'paragraph', text: 'Giữ lại' },
    { id: 'e1', type: 'embed', url: YT, provider: 'vimeo', caption: 'Sai nhà cung cấp' },
    { id: 'h1', type: 'heading', level: 9, text: 'Cấp sai' },
    { id: 'x1', type: 'section', blocks: 'not-an-array' },
    { id: 't1', type: 'toggle', summary: 'Mở', blocks: [{ id: 'x2', type: 'nope' }, { id: 'p2', type: 'paragraph', text: 'Bên trong' }] },
  ],
} as const;
