-- Seed initial profile
INSERT INTO profiles (id, name, handle, email, avatar_url, intro_en, intro_vi, theme)
VALUES (
  'main',
  'Duy Nguyen /zuey/',
  '@goonnguyen',
  'hi@zuey.me',
  'https://cdn.zuey.me/avatar.png',
  '"F*ck Around & Find Out" Specialist 😎 CTO/Co-founder@TOPGROUP, DIGITOP, XINCHAO Live Music, AgentKit & NextLevelBuilder. Founder of "Build in Public VN" Community (Facebook).',
  'Chuyên gia "F*ck Around & Find Out" 😎 CTO/Đồng sáng lập@TOPGROUP, DIGITOP, XINCHAO Live Music, AgentKit & NextLevelBuilder. Nhà sáng lập cộng đồng "Build in Public VN" (Facebook).',
  'ivory'
) ON CONFLICT(id) DO UPDATE SET
  name = excluded.name,
  intro_en = excluded.intro_en,
  intro_vi = excluded.intro_vi;

-- Seed initial links
INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'blog-en',
  'blogs',
  '✍️ FA&FO Specialist - English',
  '✍️ Chuyên gia FA&FO - Tiếng Anh',
  'Substack Newsletter on AI engineering, products & experiments',
  'Bản tin Substack về kỹ nghệ AI, sản phẩm & thử nghiệm',
  'https://faafospecialist.substack.com/',
  'substack',
  1,
  1,
  320
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'blog-vi',
  'blogs',
  '✍️ My Solo Playbook - Vietnamese',
  '✍️ Sổ tay Solo Builder - Tiếng Việt',
  'Hành trình xây dựng sản phẩm và chia sẻ thực chiến',
  'Hành trình xây dựng sản phẩm và chia sẻ thực chiến',
  'https://goonnguyen.substack.com/',
  'substack',
  2,
  1,
  512
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'company-topgroup',
  'companies',
  'The Outstanding Production Group (T.O.P Viet Nam)',
  'The Outstanding Production Group (T.O.P Việt Nam)',
  'Leading production & creative technology conglomerate',
  'Tập đoàn sản xuất & công nghệ sáng tạo hàng đầu',
  'https://wearetopgroup.com',
  'topgroup',
  1,
  1,
  890
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'company-xinchao',
  'companies',
  'Xin Chào Live Music - A Professional Music Organization Platform',
  'Xin Chào Live Music - Nền tảng tổ chức biểu diễn âm nhạc chuyên nghiệp',
  'Connecting top Vietnamese artists and global music experiences',
  'Kết nối nghệ sĩ Việt Nam hàng đầu và trải nghiệm âm nhạc quốc tế',
  'https://xinchao.world',
  'xinchao',
  2,
  1,
  670
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'company-digitop',
  'companies',
  'Digitop - Crafting Award-winning Digital Assets',
  'Digitop - Thiết kế và phát triển tài sản số đạt giải thưởng',
  'Digital agency & AI-driven development house',
  'Digital agency và công ty công nghệ chuyên sâu AI',
  'https://digitop.ai',
  'digitop',
  3,
  1,
  745
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'company-nextlevel',
  'companies',
  'NEXT LEVEL BUILDER',
  'NEXT LEVEL BUILDER',
  'Venture builder turning ideas into high-velocity products',
  'Venture builder biến ý tưởng thành sản phẩm đột phá',
  'https://nextlevelbuilder.io',
  'nextlevel',
  4,
  1,
  420
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'company-tose',
  'companies',
  'TOSE - Fast, Reliable Cloud Infrastructure',
  'TOSE - Hạ tầng đám mây tốc độ cao và ổn định',
  'Modern hosting and developer cloud platform',
  'Nền tảng lưu trữ và hạ tầng đám mây cho lập trình viên',
  'https://tose.sh',
  'tose',
  5,
  1,
  380
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'company-bipvn',
  'companies',
  '"Build in Public VN" Community',
  'Cộng đồng "Build in Public VN"',
  'The #1 community for indie hackers and makers in Vietnam',
  'Cộng đồng #1 dành cho indie hacker và nhà sáng tạo tại Việt Nam',
  'https://bip.vn',
  'bipvn',
  6,
  1,
  1450
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'prod-agentkit',
  'products',
  'AgentKit.best (formerly ClaudeKit.cc)',
  'AgentKit.best (tiền thân ClaudeKit.cc)',
  'The complete AI engineering framework to build autonomous agents',
  'Khung kỹ nghệ AI hoàn chỉnh để xây dựng và vận hành AI agent',
  'https://agentkit.best',
  'agentkit',
  1,
  1,
  1210
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'prod-dewee',
  'products',
  'Dewee.sh (formerly GoClaw.sh)',
  'Dewee.sh (tiền thân GoClaw.sh)',
  'Enterprise AI agent runtime platform for human-AI teamwork',
  'Nền tảng runtime AI agent doanh nghiệp cho sự cộng tác người - AI',
  'https://dewee.sh',
  'dewee',
  2,
  1,
  980
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'prod-goclaw',
  'products',
  'GoClaw.sh',
  'GoClaw.sh',
  'High-performance Go runtime gateway for distributed agents',
  'Gateway runtime Go hiệu năng cao cho hệ thống agent phân tán',
  'https://goclaw.sh',
  'goclaw',
  3,
  1,
  430
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'prod-tose',
  'products',
  'tose.sh',
  'tose.sh',
  'Edge cloud deployment and serverless orchestration',
  'Hạ tầng deploy edge và điều phối serverless',
  'https://tose.sh',
  'tose',
  4,
  1,
  310
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'prod-indieboosting',
  'products',
  'IndieBoosting.com',
  'IndieBoosting.com',
  'The 1st SaaS distribution network for indie hackers',
  'Mạng lưới phân phối SaaS số 1 cho các nhà sáng lập',
  'https://indieboosting.com',
  'indieboosting',
  5,
  1,
  620
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'prod-uupm',
  'products',
  'uupm.cc (UI UX Pro Max Skill)',
  'uupm.cc (Kỹ năng UI UX Pro Max)',
  'AI skill that designs and crafts world-class web and mobile interfaces',
  'Kỹ năng AI thiết kế giao diện web & mobile chuẩn quốc tế',
  'https://uupm.cc',
  'uupm',
  6,
  1,
  870
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'prod-agentwiki',
  'products',
  'AgentWiki.cc',
  'AgentWiki.cc',
  'Static documentation and knowledge publishing platform for AI agents',
  'Nền tảng xuất bản tài liệu tĩnh và tri thức cho AI agents',
  'https://agentwiki.cc',
  'agentwiki',
  7,
  1,
  390
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'prod-agentbrain',
  'products',
  'AgentBrain.sh',
  'AgentBrain.sh',
  'Shared memory and semantic intelligence layer for AI swarms',
  'Bộ nhớ dùng chung và lớp trí tuệ ngữ nghĩa cho đội ngũ AI',
  'https://agentbrain.sh',
  'agentbrain',
  8,
  1,
  340
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'prod-skillx',
  'products',
  'SkillX.sh',
  'SkillX.sh',
  'Open agent skill registry and instant execution runtime',
  'Kho lưu trữ kỹ năng mở và môi trường thực thi tức thì cho agent',
  'https://skillx.sh',
  'skillx',
  9,
  1,
  290
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'prod-findyourai',
  'products',
  'FindYourAI.tools',
  'FindYourAI.tools',
  'Curated directory of high-productivity AI tools and prompt systems',
  'Danh bạ tuyển chọn công cụ AI năng suất cao và hệ thống prompt',
  'https://findyourai.tools',
  'findyourai',
  10,
  1,
  530
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'prod-vidcap',
  'products',
  'VidCap.zuey.me',
  'VidCap.zuey.me',
  'AI video captioning and viral subtitle generation',
  'Tự động tạo phụ đề video và phụ đề viral bằng AI',
  'https://vidcap.zuey.me',
  'vidcap',
  11,
  1,
  410
) ON CONFLICT(id) DO NOTHING;

INSERT INTO links (id, section, title_en, title_vi, subtitle_en, subtitle_vi, url, icon, order_index, is_active, click_count)
VALUES (
  'prod-reviewweb',
  'products',
  'ReviewWeb.site',
  'ReviewWeb.site',
  'Automated SEO audit, backlink intelligence and site health diagnostic',
  'Kiểm toán SEO tự động, phân tích backlink và chuẩn đoán website',
  'https://reviewweb.site',
  'reviewweb',
  12,
  1,
  480
) ON CONFLICT(id) DO NOTHING;

