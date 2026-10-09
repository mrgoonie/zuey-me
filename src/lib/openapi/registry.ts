import type { OpenApiFragment } from './types';
import { readsOpenApi } from '../reads/openapi';
import { workflowsOpenApi } from '../workflows/openapi';
import { bookingOpenApi } from '../booking/openapi';
import { articlesOpenApi } from '../blocks/openapi';
import { billingOpenApi, membersOpenApi } from '../members/openapi';
import { chatOpenApi } from '../ai/openapi';
import { oauthOpenApi } from '../oauth/openapi';
import { experienceOpenApi } from '../experience/openapi';
import { taxonomyOpenApi } from '../taxonomy/openapi';
import { videosOpenApi } from '../videos/openapi';

/** Feature fragments merged into /api/openapi.json (and therefore Scalar /docs). */
export const OPENAPI_FRAGMENTS: OpenApiFragment[] = [
  readsOpenApi, workflowsOpenApi, bookingOpenApi, articlesOpenApi, taxonomyOpenApi, membersOpenApi, billingOpenApi,
  chatOpenApi, oauthOpenApi, experienceOpenApi, videosOpenApi,
];
