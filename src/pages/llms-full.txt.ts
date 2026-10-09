import type { APIRoute } from 'astro';
import { getProfile, getLinks } from '../db/store';
import { renderVideoLines } from '../lib/videos/markdown';
import { listVideos } from '../lib/videos/store';

export const GET: APIRoute = async ({ locals }) => {
  const d1 = locals.runtime?.env?.DB;
  const profile = await getProfile(d1);
  const links = await getLinks(d1);
  const videos = d1 ? (await listVideos(d1, { limit: 200 }).catch(() => ({ items: [] }))).items : [];

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

## Zueytube (curated YouTube videos)
Channel: https://www.youtube.com/@imzuey · Markdown: https://zuey.me/videos.md · Transcripts: GET https://zuey.me/api/v1/videos/{id}
${videos.length ? renderVideoLines(videos, 'https://zuey.me') : '- No videos yet.'}

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
