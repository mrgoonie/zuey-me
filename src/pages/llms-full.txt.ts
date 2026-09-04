import type { APIRoute } from 'astro';
import { getProfile, getLinks } from '../db/store';
import type { D1DatabaseLike } from '../db/store';

export const GET: APIRoute = async ({ locals }) => {
  const runtime = (locals as { runtime?: { env?: { DB?: D1DatabaseLike } } })?.runtime;
  const d1 = runtime?.env?.DB;

  const profile = await getProfile(d1);
  const links = await getLinks(d1);

  const content = `# Full Context: ${profile.name} (${profile.handle})
Website: https://zuey.me
Email: ${profile.email}

## Biography
English:
${profile.intro_en}

Tiếng Việt:
${profile.intro_vi}

## All Curated Links & Ecosystem

### 1. Blogs & Writings
${links.filter(l => l.section === 'blogs').map(l => `#### ${l.title_en}
- URL: ${l.url}
- Description (EN): ${l.subtitle_en || 'N/A'}
- Mô tả (VI): ${l.subtitle_vi || 'N/A'}
- Clicks tracked: ${l.click_count || 0}
`).join('\n')}

### 2. Companies & Organizations ("Found by me!")
${links.filter(l => l.section === 'companies').map(l => `#### ${l.title_en}
- URL: ${l.url}
- Description (EN): ${l.subtitle_en || 'N/A'}
- Mô tả (VI): ${l.subtitle_vi || 'N/A'}
- Clicks tracked: ${l.click_count || 0}
`).join('\n')}

### 3. Products & AI Engineering Tools
${links.filter(l => l.section === 'products').map(l => `#### ${l.title_en}
- URL: ${l.url}
- Description (EN): ${l.subtitle_en || 'N/A'}
- Mô tả (VI): ${l.subtitle_vi || 'N/A'}
- Clicks tracked: ${l.click_count || 0}
`).join('\n')}

## Developer, Agent & MCP Surface
- Interactive Scalar Documentation: https://zuey.me/docs
- REST API v1 Base: https://zuey.me/api/v1
- MCP Endpoint: https://zuey.me/api/mcp
- NPM CLI: \`npm install -g zuey-cli\`
- Claude / AgentKit Skill: \`skills/zuey-me/SKILL.md\`
`;

  return new Response(content, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
