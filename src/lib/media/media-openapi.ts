import { adminSecurity, errorResponses } from '../openapi/types';
import type { OpenApiFragment } from '../openapi/types';
import { MAX_IMAGE_BYTES, MEDIA_PUBLIC_ORIGIN } from './media-asset-store';
import { MAX_INLINE_BYTES } from './media-upload-sources';

const TAG = 'Media';
const MB = 1024 * 1024;
const errorRef = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };
const envelope = (data: unknown) => ({
  'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data } } },
});
const storedResponse = { description: 'Stored (or the existing asset with identical bytes)', content: envelope({ $ref: '#/components/schemas/MediaStored' }) };
const storeErrors = {
  '413': { description: `Larger than ${MAX_IMAGE_BYTES / MB} MB (inline base64: ${MAX_INLINE_BYTES / MB} MB)`, content: errorRef },
  '415': { description: 'Not a PNG, JPEG, GIF, WebP or AVIF image (SVG is refused)', content: errorRef },
  '503': { description: 'MEDIA (R2) or DB binding not configured', content: errorRef },
};

export const mediaOpenApi: OpenApiFragment = {
  tag: {
    name: TAG,
    description: `Article images on the public media CDN (${MEDIA_PUBLIC_ORIGIN}). Keys are content-addressed, so identical bytes are stored once. Each upload returns an image block to insert into an article document. MCP: media_upload_url, media_import, media_upload, media_reconcile, media_list, media_delete.`,
  },
  paths: {
    '/api/v1/admin/media': {
      get: {
        tags: [TAG],
        summary: 'List media (admin)',
        security: adminSecurity,
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Filter by alt text or object key' },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
        ],
        responses: {
          '200': {
            description: 'Newest first',
            content: envelope({
              type: 'object',
              properties: {
                items: { type: 'array', items: { allOf: [{ $ref: '#/components/schemas/MediaAsset' }, { type: 'object', properties: { block: { $ref: '#/components/schemas/MediaImageBlock' } } }] } },
                total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' },
              },
            }),
          },
          ...errorResponses,
        },
      },
      post: {
        tags: [TAG],
        summary: 'Upload or import an image (admin)',
        description: 'Scripts send JSON (`url` to import a public https image without following redirects, or `data_base64` for a small image). The Studio sends multipart with `file`. For large files from a script, use an upload URL instead.',
        security: adminSecurity,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  url: { type: 'string', format: 'uri', description: 'https URL of the image to import' },
                  data_base64: { type: 'string', description: 'Base64 or data: URL (used when url is absent)' },
                  alt: { type: 'string', maxLength: 500 },
                },
              },
            },
            'multipart/form-data': {
              schema: { type: 'object', required: ['file'], properties: { file: { type: 'string', format: 'binary' }, alt: { type: 'string' } } },
            },
          },
        },
        responses: { '201': storedResponse, ...errorResponses, '502': { description: 'The import URL failed or redirected', content: errorRef }, ...storeErrors },
      },
    },
    '/api/v1/admin/media/upload-url': {
      post: {
        tags: [TAG],
        summary: 'Create a one-time upload URL (admin)',
        description: 'Valid 15 minutes and for one successful upload. `PUT` the raw file to `upload_url` (e.g. `curl --upload-file image.png <upload_url>`).',
        security: adminSecurity,
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { alt: { type: 'string', maxLength: 500 } } } } } },
        responses: {
          '201': {
            description: 'Upload URL',
            content: envelope({
              type: 'object',
              properties: {
                upload_url: { type: 'string' }, method: { type: 'string', enum: ['PUT'] }, expires_at: { type: 'string', format: 'date-time' },
                max_bytes: { type: 'integer' }, accepted_types: { type: 'array', items: { type: 'string' } }, curl: { type: 'string' },
              },
            }),
          },
          ...errorResponses,
          '503': storeErrors['503'],
        },
      },
    },
    '/api/v1/admin/media/{id}': {
      delete: {
        tags: [TAG],
        summary: 'Delete an image (admin)',
        security: adminSecurity,
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, description: 'Media asset id (`med_…`)' }],
        responses: {
          '200': { description: 'Deleted', content: envelope({ type: 'object', properties: { deleted: { type: 'boolean' }, id: { type: 'string' }, url: { type: 'string' } } }) },
          ...errorResponses,
          '404': { description: 'Unknown id', content: errorRef },
          '409': { description: '`media_in_use`: current article or lesson documents still use it (listed in the error)', content: errorRef },
        },
      },
    },
    '/api/v1/admin/media/reconcile': {
      post: {
        tags: [TAG],
        summary: 'Register an existing bucket object as a managed asset (admin)',
        description: 'Reads the object back from R2 and re-validates it (type, size cap, sha256, optional width/height); nothing is fetched from the network. Identical bytes already registered return the existing asset (`created: false`).',
        security: adminSecurity,
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object', required: ['object_key', 'sha256'],
            properties: {
              object_key: { type: 'string', description: 'Key under `articles/`, ending in .png, .jpg, .gif, .webp or .avif' },
              sha256: { type: 'string', description: 'Lowercase hex SHA-256 of the object' },
              width: { type: 'integer', minimum: 1 }, height: { type: 'integer', minimum: 1 }, alt: { type: 'string', maxLength: 500 },
            },
          } } },
        },
        responses: {
          '200': { description: 'Already registered', content: envelope({ $ref: '#/components/schemas/MediaStored' }) },
          '201': { description: 'Registered', content: envelope({ $ref: '#/components/schemas/MediaStored' }) },
          ...errorResponses,
          '404': { description: '`object_not_found`', content: errorRef },
          '409': { description: '`object_key_conflict`: the key is registered with other bytes', content: errorRef },
          '413': { description: `Larger than ${MAX_IMAGE_BYTES / MB} MB`, content: errorRef },
          '415': { description: 'Not a supported image', content: errorRef },
          '422': { description: '`sha256_mismatch`, `dimensions_mismatch` or `extension_mismatch`', content: errorRef },
        },
      },
    },
    '/api/v1/media/uploads/{token}': {
      put: {
        tags: [TAG],
        summary: 'Upload a file to a one-time upload URL',
        description: 'The token is the only credential. A file that is not a supported image is refused without using up the URL.',
        security: [],
        parameters: [{ name: 'token', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { required: true, content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } },
        responses: { '201': storedResponse, '404': { description: '`upload_url_invalid`: unknown, expired or already used', content: errorRef }, ...storeErrors },
      },
    },
  },
  schemas: {
    MediaAsset: {
      type: 'object',
      properties: {
        id: { type: 'string' }, url: { type: 'string', description: `${MEDIA_PUBLIC_ORIGIN}/articles/…` }, object_key: { type: 'string' },
        sha256: { type: 'string' }, mime: { type: 'string' }, size_bytes: { type: 'integer' },
        width: { type: ['integer', 'null'] }, height: { type: ['integer', 'null'] }, alt: { type: 'string' },
        source_url: { type: ['string', 'null'] },
        origin: { type: 'string', enum: ['upload', 'import', 'reconcile'], description: 'How the asset was registered' }, created_by: { type: 'string' }, created_at: { type: 'string', format: 'date-time' },
      },
    },
    MediaImageBlock: {
      type: 'object',
      description: 'Image block for an article document (width/height only when known)',
      properties: { type: { type: 'string', enum: ['image'] }, url: { type: 'string' }, alt: { type: 'string' }, width: { type: 'integer' }, height: { type: 'integer' } },
    },
    MediaStored: {
      type: 'object',
      properties: {
        asset: { $ref: '#/components/schemas/MediaAsset' },
        created: { type: 'boolean', description: 'False when identical bytes were already stored' },
        block: { $ref: '#/components/schemas/MediaImageBlock' },
        markdown: { type: 'string' },
      },
    },
  },
};
