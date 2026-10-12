import type { APIRoute } from 'astro';
import { errorResponse, jsonOk } from '../../../../../lib/http';
import { NO_STORE } from '../../../../../lib/members/account';
import { requireMembersDb } from '../../../../../lib/members/runtime';
import { consumeUploadTicket } from '../../../../../lib/media/media-upload-sources';

/**
 * One-time image upload: `PUT` the raw file to the URL from `media_upload_url` (MCP) or
 * `POST /api/v1/admin/media/upload-url`. The token in the path is the only credential.
 */
export const PUT: APIRoute = async ({ request, params, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    const result = await consumeUploadTicket(requireMembersDb(env), env, params.token ?? '', request.body);
    return jsonOk(result, 201, NO_STORE);
  } catch (err) {
    return errorResponse(err);
  }
};
