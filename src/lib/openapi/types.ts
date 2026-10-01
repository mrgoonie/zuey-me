/** OpenAPI fragment contributed by one feature module and merged into /api/openapi.json. */
export interface OpenApiFragment {
  tag: { name: string; description: string };
  paths: Record<string, Record<string, unknown>>;
  schemas: Record<string, unknown>;
}

/** Standard error envelope reference reused by every fragment. */
export const errorResponses = {
  '400': { description: 'Invalid request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '401': { description: 'Missing or invalid credentials', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  '403': { description: 'Admin role required', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
} as const;

export const adminSecurity = [{ BearerAuth: [] }, { ApiKeyHeader: [] }];
