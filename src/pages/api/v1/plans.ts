import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../lib/http';
import { plansCatalog } from '../../../lib/members/account';

/** Public plan catalog: monthly USD prices, entitlements and VND prepay amounts when billing is configured. */
export const GET: APIRoute = async ({ locals }) => {
  try {
    return jsonOk(plansCatalog(locals.runtime?.env ?? {}), 200, { 'Cache-Control': 'public, max-age=300' });
  } catch (err) {
    return errorResponse(err);
  }
};
