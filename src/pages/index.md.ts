import type { APIRoute } from 'astro';
import { getProfile, getLinks } from '../db/store';
import type { D1DatabaseLike } from '../db/store';

export const GET: APIRoute = async ({ locals }) => {
  const runtime = (locals as { runtime?: { env?: { DB?: D1DatabaseLike } } })?.runtime;
  const d1 = runtime?.env?.DB;

  const profile = await getProfile(d1);
  const links = await getLinks(d1);

  let md = `# ${profile.name} (${profile.handle})\n\n`;
  md += `> ${profile.intro_en}\n\n`;
  md += `Avatar: ${profile.avatar_url}\n`;
  md += `Email: [${profile.email}](mailto:${profile.email})\n`;
  md += `Website: [https://zuey.me](https://zuey.me)\n\n`;

  md += `## Blogs\n`;
  links.filter(l => l.section === 'blogs').forEach(l => {
    md += `- [${l.title_en}](${l.url})${l.subtitle_en ? ` — ${l.subtitle_en}` : ''}\n`;
  });

  md += `\n## Companies (Found by me!)\n`;
  links.filter(l => l.section === 'companies').forEach(l => {
    md += `- [${l.title_en}](${l.url})${l.subtitle_en ? ` — ${l.subtitle_en}` : ''}\n`;
  });

  md += `\n## Products\n`;
  links.filter(l => l.section === 'products').forEach(l => {
    md += `- [${l.title_en}](${l.url})${l.subtitle_en ? ` — ${l.subtitle_en}` : ''}\n`;
  });

  return new Response(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
