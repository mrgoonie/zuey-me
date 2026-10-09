import { AppError, jsonOk } from '../../../../lib/http';
import { memberRoute } from '../../../../lib/members/account';
import { getCertificate } from '../../../../lib/courses/course-certificates';

/** Public verification of a completion certificate. */
export const GET = memberRoute(async ({ params }, { d1, env }) => {
  const cert = await getCertificate(d1, env, params.code ?? '');
  if (!cert) throw new AppError(404, 'not_found', 'Certificate not found');
  return jsonOk(cert, 200, { 'Cache-Control': 'public, max-age=300' });
});
