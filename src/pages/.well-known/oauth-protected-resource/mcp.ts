import type { APIRoute } from 'astro';
import { protectedResourceMetadataResponse } from '../../../lib/oauth/metadata';

/** RFC 9728 protected resource metadata for /mcp (path-inserted location, advertised in WWW-Authenticate). */
export const GET: APIRoute = ({ request }) => protectedResourceMetadataResponse(request);
