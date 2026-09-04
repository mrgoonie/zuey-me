import type { APIRoute } from 'astro';
import { getLinks, createLink } from '../../../../db/store';
import { authenticateRequest } from '../../../../lib/auth';
import type { D1DatabaseLike } from '../../../../db/store';

export const GET: APIRoute = async ({ locals }) => {
  const runtime = (locals as { runtime?: { env?: { DB?: D1DatabaseLike } } })?.runtime;
  const d1 = runtime?.env?.DB;

  const links = await getLinks(d1);
  return new Response(JSON.stringify({ success: true, data: links }), {
    headers: { 'Content-Type': 'application/json' },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const runtime = (locals as { runtime?: { env?: { DB?: D1DatabaseLike } } })?.runtime;
  const d1 = runtime?.env?.DB;

  const auth = await authenticateRequest(request, d1);
  if (!auth.authenticated) {
    return new Response(JSON.stringify({ success: false, error: auth.error }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    if (!body || typeof body !== 'object' || !body.title_en || !body.url || !body.section) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields: title_en, url, section (blogs|companies|products|socials)'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const created = await createLink({
      section: body.section,
      title_en: body.title_en,
      title_vi: body.title_vi || body.title_en,
      subtitle_en: body.subtitle_en,
      subtitle_vi: body.subtitle_vi,
      url: body.url,
      icon: body.icon,
      is_active: body.is_active !== undefined ? Boolean(body.is_active) : true,
    }, d1);

    return new Response(JSON.stringify({ success: true, data: created }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
