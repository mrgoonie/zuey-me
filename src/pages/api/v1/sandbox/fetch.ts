import type { APIRoute } from 'astro';
import { clientIp, requireMembersDb } from '../../../../lib/members/runtime';
import { resolvePrincipal } from '../../../../lib/members/policy';
import { AppError, errorResponse, jsonOk, readJsonObject } from '../../../../lib/http';
import {
  SANDBOX_RATE_LIMIT_ANON, SANDBOX_RATE_LIMIT_MEMBER, anonymousRateKey, consumeSandboxRateLimit, parseAllowlist, proxySandboxFetch,
} from '../../../../lib/ai/sandbox-proxy';
import { aiRuntime } from '../../../../lib/ai/runtime';

/**
 * Fetch broker for sandboxed interactive blocks. Body: {url, method?: 'GET'}.
 * HTTPS GET to SANDBOX_FETCH_ALLOWLIST hosts only; no cookies or credentials are forwarded;
 * 512 KB / 8 s caps; rate limited per member (or per IP for anonymous readers).
 */
export const POST: APIRoute = async ({ request, locals }) => {
  try {
    const env = locals.runtime?.env ?? {};
    const d1 = requireMembersDb(env);
    const body = await readJsonObject(request);
    if (!body) throw new AppError(400, 'invalid_json', 'Body must be a JSON object {url}');
    const principal = await resolvePrincipal(request, env);
    if (principal.credentialError) {
      throw new AppError(principal.credentialError.status, principal.credentialError.code, principal.credentialError.message);
    }
    const key = principal.userId ? `u:${principal.userId}` : await anonymousRateKey(clientIp(request), env);
    const limit = principal.userId ? SANDBOX_RATE_LIMIT_MEMBER : SANDBOX_RATE_LIMIT_ANON;
    if (!(await consumeSandboxRateLimit(d1, key, limit, aiRuntime.now()))) {
      throw new AppError(429, 'rate_limited', `At most ${limit} sandbox requests per minute`);
    }
    const result = await proxySandboxFetch(body.url, body.method, { allowlist: parseAllowlist(env) });
    return jsonOk(result, 200, { 'Cache-Control': 'private, no-store' });
  } catch (err) {
    return errorResponse(err);
  }
};
