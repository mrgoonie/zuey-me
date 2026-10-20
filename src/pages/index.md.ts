import type { APIRoute } from 'astro';
import { getProfile, getLinks } from '../db/store';
import { zueyOsAgentGuideMarkdown } from '../components/os/agent-surfaces';

export const GET: APIRoute = async ({ locals }) => {
  const d1 = locals.runtime?.env?.DB;
  const profile = await getProfile(d1);
  const links = await getLinks(d1);

  let md = `# ${profile.name} (${profile.handle})\n\n`;
  md += `> ${profile.intro_en}\n\n`;
  md += `Avatar: ${profile.avatar_url}\n`;
  md += `Email: [${profile.email}](mailto:${profile.email})\n`;
  md += `Website: [https://zuey.me](https://zuey.me)\n\n`;
  md += `${zueyOsAgentGuideMarkdown()}\n`;

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

  md += `\n## Buy a membership, course or consultation\n`;
  md += `- [Checkout guide for AI agents](https://zuey.me/checkout.md) — helps a human pay; agents never pay or accept terms for them\n`;

  return new Response(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
