import type { APIRoute } from 'astro';
import { checkChannelAccess, parseChannelAccessInput, requireChannelAccessService } from '../../../../lib/channel-access/check';
import { AppError, errorResponse, jsonError, jsonOk, readJsonObject } from '../../../../lib/http';
import { requireMembersDb } from '../../../../lib/members/runtime';

/** dewee Channel Access Gate verifier over HTTP (same decision as the MCP tool `channel_access_check`). Service key only. */
export const POST: APIRoute = async ({ request, locals }) => {
  const env = locals.runtime?.env ?? {};
  try {
    await requireChannelAccessService(request, env);
    const body = await readJsonObject(request);
    if (!body) throw new AppError(400, 'invalid_json', 'Body must be a JSON object');
    const input = parseChannelAccessInput(body);
    return jsonOk(await checkChannelAccess(requireMembersDb(env), env, input), 200, { 'Cache-Control': 'no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};

export const GET: APIRoute = () => jsonError(405, 'method_not_allowed', 'Use POST');
