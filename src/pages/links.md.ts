import type { APIRoute } from 'astro';
import { getLinks } from '../db/store';

export const GET: APIRoute = async ({ locals }) => {
  const d1 = locals.runtime?.env?.DB;
  const links = await getLinks(d1);

  let md = `# Curated Links Index — Duy Nguyen /zuey/\n\n`;

  const sections: Array<{ id: 'blogs' | 'companies' | 'products'; title: string }> = [
    { id: 'blogs', title: 'Blogs & Publications' },
    { id: 'companies', title: 'Companies & Organizations' },
    { id: 'products', title: 'Products & AI Engineering Tools' },
  ];

  for (const sec of sections) {
    md += `## ${sec.title}\n`;
    const secLinks = links.filter(l => l.section === sec.id);
    for (const l of secLinks) {
      md += `### [${l.title_en}](${l.url})\n`;
      if (l.subtitle_en) md += `- Description: ${l.subtitle_en}\n`;
      if (l.subtitle_vi) md += `- Mô tả: ${l.subtitle_vi}\n`;
      md += `- URL: ${l.url}\n\n`;
    }
  }

  return new Response(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
