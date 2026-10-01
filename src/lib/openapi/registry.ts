import type { OpenApiFragment } from './types';
import { readsOpenApi } from '../reads/openapi';

/** Feature fragments merged into /api/openapi.json (and therefore Scalar /docs). */
export const OPENAPI_FRAGMENTS: OpenApiFragment[] = [readsOpenApi];
