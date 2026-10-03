import type { APIRoute } from 'astro';
import { protectedResourceMetadataResponse } from '../../lib/oauth/metadata';

/** RFC 9728 protected resource metadata (root fallback location). */
export const GET: APIRoute = ({ request }) => protectedResourceMetadataResponse(request);
