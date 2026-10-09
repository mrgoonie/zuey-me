import { AppError, jsonOk, readJsonObject } from '../../../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../../../lib/members/account';
import { requireCan } from '../../../../../../../lib/members/policy';
import { createStreamAsset, listAssets, uploadR2Asset } from '../../../../../../../lib/courses/course-asset-store';
import { requireCourse } from '../../../../../../../lib/courses/course-store';

export const GET = memberRoute(async ({ params }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  return jsonOk(await listAssets(d1, course.id), 200, NO_STORE);
});

/**
 * Admin: register media. JSON { kind: 'video', stream_uid, name, duration_seconds? } for a Cloudflare
 * Stream video; multipart (file, kind: audio|file, name?, duration_seconds?) uploads to private R2.
 */
export const POST = memberRoute(async ({ request, params }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  const course = await requireCourse(d1, params.course ?? '');
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'multipart/form-data') {
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new AppError(400, 'invalid_field', 'file is required', { field: 'file' });
    const duration = Number(form.get('duration_seconds'));
    const name = form.get('name');
    return jsonOk(await uploadR2Asset(d1, env, course, {
      file, kind: form.get('kind'), name: typeof name === 'string' ? name : undefined,
      durationSeconds: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    }), 201, NO_STORE);
  }
  const body = await readJsonObject(request);
  if (!body) throw new AppError(400, 'invalid_json', 'Send JSON for a Stream video or multipart/form-data for a file');
  return jsonOk(await createStreamAsset(d1, course, body), 201, NO_STORE);
});
