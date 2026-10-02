import type { APIRoute } from 'astro';
import { authorizationServerMetadataResponse } from '../../lib/oauth/metadata';

/** RFC 8414 authorization server metadata for the zuey.me OAuth server. */
export const GET: APIRoute = ({ request }) => authorizationServerMetadataResponse(request);
