import type { APIRoute } from 'astro';
import { getProfile } from '../db/store';

export const GET: APIRoute = async ({ locals }) => {
  const d1 = locals.runtime?.env?.DB;
  const profile = await getProfile(d1);

  const md = `# Profile: ${profile.name} (${profile.handle})

## About (English)
${profile.intro_en}

## Giới thiệu (Tiếng Việt)
${profile.intro_vi}

## Contact Information
- Email: ${profile.email}
- Website: https://zuey.me
- Avatar: ${profile.avatar_url}
- X: https://x.com/goon_nguyen
- GitHub: https://github.com/mrgoonie
- Substack: https://faafospecialist.substack.com/
`;

  return new Response(md, {
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
    },
  });
};
