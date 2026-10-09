/** Small builders shared by the course OpenAPI fragments so each path stays one readable line. */
import { adminSecurity, errorResponses } from '../openapi/types';

const errorRef = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };

export const pathParam = (name: string, description: string) => ({ name, in: 'path', required: true, schema: { type: 'string' }, description });
export const courseParam = pathParam('course', 'Course slug or id');
export const lessonParam = pathParam('lesson', 'Lesson slug or id');

export interface OpSpec {
  summary: string;
  description?: string;
  params?: unknown[];
  body?: Record<string, unknown>;
  required?: string[];
  admin?: boolean;
  member?: boolean;
  status?: string;
  extra?: Record<string, string>;
}

/** One operation with the standard envelope, error responses and (for admin/member ops) security. */
export function op(tag: string, spec: OpSpec): Record<string, unknown> {
  const responses: Record<string, unknown> = {
    [spec.status ?? '200']: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'object' } } } } } },
    '400': errorResponses['400'],
  };
  if (spec.admin || spec.member) {
    responses['401'] = errorResponses['401'];
    responses['403'] = errorResponses['403'];
  }
  for (const [code, description] of Object.entries(spec.extra ?? {})) responses[code] = { description, content: errorRef };
  return {
    tags: [tag],
    summary: spec.summary,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.params ? { parameters: spec.params } : {}),
    ...(spec.admin ? { security: adminSecurity } : spec.member ? { security: [{ MemberSession: [] }, { BearerAuth: [] }] } : {}),
    ...(spec.body
      ? { requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: spec.body, ...(spec.required ? { required: spec.required } : {}) } } } } }
      : {}),
    responses,
  };
}
