import type { APIRoute } from 'astro';
import { AppError, errorResponse, jsonError, jsonOk } from '../../../../../lib/http';
import { getRevisionDocument, listRevisions } from '../../../../../lib/blocks/articles';
import { localeParam } from '../../../../../lib/blocks/params';
import { requireAdminActor } from '../../../../../lib/taxonomy/admin';

/**
 * Admin: revision history (?lang= filters one edition). With ?revision=N&lang=xx returns that stored
 * document; restore it by saving it as the edition's draft (PUT /api/v1/articles/{slug}).
 */
export const GET: APIRoute = async ({ params, request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    await requireAdminActor(request, env);
    const url = new URL(request.url);
    const locale = localeParam(url);
    const revisionRaw = url.searchParams.get('revision');
    if (revisionRaw !== null) {
      const revision = Number(revisionRaw);
      if (!Number.isInteger(revision) || revision < 1) throw new AppError(400, 'invalid_field', 'revision must be a positive integer', { field: 'revision' });
      if (!locale) throw new AppError(400, 'invalid_field', 'lang is required with revision', { field: 'lang' });
      const doc = await getRevisionDocument(env.DB, params.slug ?? '', locale, revision);
      if (!doc) return jsonError(404, 'not_found', 'Revision not found');
      return jsonOk(doc);
    }
    return jsonOk(await listRevisions(env.DB, params.slug ?? '', locale));
  } catch (err) {
    return errorResponse(err);
  }
};
