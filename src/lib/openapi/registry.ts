import type { OpenApiFragment } from './types';
import { readsOpenApi } from '../reads/openapi';
import { workflowsOpenApi } from '../workflows/openapi';
import { bookingOpenApi } from '../booking/openapi';

/** Feature fragments merged into /api/openapi.json (and therefore Scalar /docs). */
export const OPENAPI_FRAGMENTS: OpenApiFragment[] = [readsOpenApi, workflowsOpenApi, bookingOpenApi];
