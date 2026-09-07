import type { APIRoute } from 'astro';
import { getProfile, getLinks } from '../db/store';

export const GET: APIRoute = async ({ locals }) => {
  const d1 = locals.runtime?.env?.DB;
  const profile = await getProfile(d1);
  const links = await getLinks(d1);

  const blogs = links.filter(l => l.section === 'blogs');
  const companies = links.filter(l => l.section === 'companies');
  const products = links.filter(l => l.section === 'products');

  const content = `# ${profile.name} (${profile.handle})
> "F*ck Around & Find Out" Specialist 😎 CTO/Co-founder@TOPGROUP, DIGITOP & XINCHAO Live Music. Founder of "Build in Public VN" Community.

Official profile, links, ventures, products, and developer APIs for Duy Nguyen (/zuey/).

## Contact & Links
- Website: https://zuey.me
- Email: ${profile.email}
- Avatar: ${profile.avatar_url}
- X (Twitter): https://x.com/goon_nguyen
- GitHub: https://github.com/mrgoonie
- Facebook: https://fb.com/mrgoonie
- Instagram: https://www.instagram.com/imzuey
- Threads: https://www.threads.com/@imzuey
- YouTube: https://www.youtube.com/@goonnguyen

## Blogs
${blogs.map(b => `- [${b.title_en}](${b.url}): ${b.subtitle_en || 'Newsletter'}`).join('\n')}

## Companies & Ventures
${companies.map(c => `- [${c.title_en}](${c.url}): ${c.subtitle_en || 'Company'}`).join('\n')}

## Products & AI Tools
${products.map(p => `- [${p.title_en}](${p.url}): ${p.subtitle_en || 'Product'}`).join('\n')}

## AI & Developer Surface
- API Reference: https://zuey.me/docs (Scalar interactive docs)
- OpenAPI Specification: https://zuey.me/api/openapi.json
- MCP Server: https://zuey.me/api/mcp (SSE & Streamable JSON-RPC)
- Markdown Profile: https://zuey.me/index.md
- Markdown Catalog: https://zuey.me/links.md
- Full LLM Context: https://zuey.me/llms-full.txt
`;

  return new Response(content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
