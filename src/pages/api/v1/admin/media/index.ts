import { AppError, jsonOk, readJsonObject } from '../../../../../lib/http';
import { NO_STORE, memberRoute } from '../../../../../lib/members/account';
import { requireCan } from '../../../../../lib/members/policy';
import { principalActor } from '../../../../../lib/taxonomy/admin';
import { MAX_IMAGE_BYTES, imageBlock, listMediaAssets, storeImage } from '../../../../../lib/media/media-asset-store';
import { decodeBase64Image, importImageFromUrl, readBounded } from '../../../../../lib/media/media-upload-sources';

/** Admin: images on the media CDN, newest first (`q` filters alt text and keys). */
export const GET = memberRoute(async ({ url }, { d1, principal }) => {
  requireCan(principal, 'admin');
  const num = (key: string) => {
    const v = Number(url.searchParams.get(key));
    return Number.isFinite(v) && v > 0 ? v : undefined;
  };
  const res = await listMediaAssets(d1, { q: url.searchParams.get('q') ?? undefined, limit: num('limit'), page: num('page') });
  return jsonOk({ ...res, items: res.items.map(asset => ({ ...asset, block: imageBlock(asset) })) }, 200, NO_STORE);
});

/**
 * Admin: store an image on the media CDN. Multipart (`file`, `alt?`) from the Studio, or JSON
 * `{url, alt?}` to import a public https image, or `{data_base64, alt?}` for a small inline image.
 */
export const POST = memberRoute(async ({ request }, { d1, env, principal }) => {
  requireCan(principal, 'admin');
  const actor = principalActor(principal);
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'multipart/form-data') {
    // formData() buffers the whole body, so refuse oversized uploads before reading it.
    const declared = Number(request.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES + 64 * 1024) {
      throw new AppError(413, 'file_too_large', `Images must be at most ${MAX_IMAGE_BYTES / 1024 / 1024} MB`);
    }
    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw new AppError(400, 'invalid_field', 'file is required', { field: 'file' });
    const bytes = await readBounded(file.stream());
    return jsonOk(await storeImage(d1, env, bytes, { alt: form.get('alt'), actor }), 201, NO_STORE);
  }
  const body = await readJsonObject(request);
  if (!body) throw new AppError(400, 'invalid_json', 'Send JSON {url} or {data_base64}, or multipart/form-data with a file');
  if (body.url !== undefined) return jsonOk(await importImageFromUrl(d1, env, body.url, { alt: body.alt, actor }), 201, NO_STORE);
  return jsonOk(await storeImage(d1, env, decodeBase64Image(body.data_base64), { alt: body.alt, actor }), 201, NO_STORE);
});
