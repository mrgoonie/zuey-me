import type { APIRoute } from 'astro';
import { isOAuthProvider, startMemberOAuth } from '../../../../lib/members/oauth';

/** Starts member sign-in with Google or GitHub: GET /api/members/auth/google?next=/account. */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const provider = params.provider;
  if (!isOAuthProvider(provider)) return new Response('Not found', { status: 404 });
  return startMemberOAuth(request, locals.runtime?.env ?? {}, provider);
};
