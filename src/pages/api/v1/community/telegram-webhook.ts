import type { APIRoute } from 'astro';
import { errorResponse, jsonOk, readJsonObject } from '../../../../lib/http';
import { requireMembersDb } from '../../../../lib/members/runtime';
import { handleTelegramUpdate } from '../../../../lib/experience/community';

/** Telegram Bot API webhook (chat_member updates), authenticated by X-Telegram-Bot-Api-Secret-Token. */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    const d1 = requireMembersDb(env);
    const update = await readJsonObject(request);
    const outcome = await handleTelegramUpdate(d1, env, request.headers.get('x-telegram-bot-api-secret-token'), update);
    return jsonOk({ outcome });
  } catch (err) {
    return errorResponse(err);
  }
};
