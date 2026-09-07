import type { APIRoute } from 'astro';
import {
  getProfile,
  updateProfile,
  getLinks,
  createLink,
  updateLink,
  deleteLink,
  reorderLinks,
} from '../../db/store';
import { authenticateRequest } from '../../lib/auth';

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}

const MCP_TOOLS: McpTool[] = [
  {
    name: 'get_profile',
    description: 'Get Duy Nguyen (/zuey/) current profile, bio (EN & VI), avatar, and theme.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'update_profile',
    description: 'Update Duy Nguyen profile details: name, handle, bio in EN or VI, avatar URL.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Full name' },
        handle: { type: 'string', description: 'Handle e.g. @goonnguyen' },
        intro_en: { type: 'string', description: 'Bio in English' },
        intro_vi: { type: 'string', description: 'Bio in Vietnamese' },
        avatar_url: { type: 'string', description: 'Avatar image URL' },
      },
    },
  },
  {
    name: 'list_links',
    description: 'List all curated link cards (blogs, companies, products, socials) with ordering and click counts.',
    inputSchema: {
      type: 'object',
      properties: {
        section: {
          type: 'string',
          enum: ['all', 'blogs', 'companies', 'products', 'socials'],
          description: 'Filter by category section',
        },
      },
    },
  },
  {
    name: 'create_link',
    description: 'Add a new link card to blogs, companies ("Found by me!"), or products.',
    inputSchema: {
      type: 'object',
      required: ['section', 'title_en', 'url'],
      properties: {
        section: { type: 'string', enum: ['blogs', 'companies', 'products'] },
        title_en: { type: 'string', description: 'English title of the card' },
        title_vi: { type: 'string', description: 'Vietnamese title of the card' },
        subtitle_en: { type: 'string', description: 'English short description' },
        subtitle_vi: { type: 'string', description: 'Vietnamese short description' },
        url: { type: 'string', description: 'Destination web URL' },
        icon: { type: 'string', description: 'Icon name (agentkit, dewee, tose, substack, etc.)' },
      },
    },
  },
  {
    name: 'update_link',
    description: 'Update an existing link card by ID.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Link card ID' },
        title_en: { type: 'string' },
        title_vi: { type: 'string' },
        subtitle_en: { type: 'string' },
        subtitle_vi: { type: 'string' },
        url: { type: 'string' },
        icon: { type: 'string' },
        is_active: { type: 'boolean' },
      },
    },
  },
  {
    name: 'delete_link',
    description: 'Remove a link card from the profile by ID.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'Link card ID to delete' },
      },
    },
  },
  {
    name: 'reorder_links',
    description: 'Set custom ordering sequence of links using an array of link IDs.',
    inputSchema: {
      type: 'object',
      required: ['order'],
      properties: {
        order: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of link IDs in desired display order',
        },
      },
    },
  },
  {
    name: 'get_theme',
    description: 'Get current visual theme preset and custom CSS styling.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'set_theme',
    description: 'Change profile visual theme (ivory | dark | minimal | glass) and optional custom CSS.',
    inputSchema: {
      type: 'object',
      required: ['theme'],
      properties: {
        theme: {
          type: 'string',
          enum: ['ivory', 'dark', 'minimal', 'glass'],
          description: 'Theme visual preset name',
        },
        custom_css: { type: 'string', description: 'Optional custom CSS rules' },
      },
    },
  },
];

export const POST: APIRoute = async ({ request, locals }) => {
  const d1 = locals.runtime?.env?.DB;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const method = String(body.method || '');
  const id = body.id !== undefined ? body.id : null;

  // 1. Initialize MCP Handshake
  if (method === 'initialize') {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: 'zuey-me-mcp',
          version: '1.0.0',
        },
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 2. List Available Tools
  if (method === 'tools/list') {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id,
      result: {
        tools: MCP_TOOLS,
      },
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 3. Call Tool
  if (method === 'tools/call') {
    const params = (body.params as { name?: string; arguments?: Record<string, unknown> }) || {};
    const toolName = params.name;
    const args = params.arguments || {};

    const isMutation = ['update_profile', 'create_link', 'update_link', 'delete_link', 'reorder_links', 'set_theme'].includes(toolName || '');

    if (isMutation) {
      const auth = await authenticateRequest(request, d1);
      if (!auth.authenticated) {
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: auth.error || 'Unauthorized. Provide Authorization: Bearer <API_KEY>' },
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    try {
      let resultData: unknown = null;

      switch (toolName) {
        case 'get_profile':
          resultData = await getProfile(d1);
          break;

        case 'update_profile':
          resultData = await updateProfile(args, d1);
          break;

        case 'list_links': {
          const links = await getLinks(d1);
          const section = args.section as string | undefined;
          resultData = (section && section !== 'all')
            ? links.filter(l => l.section === section)
            : links;
          break;
        }

        case 'create_link':
          resultData = await createLink({
            section: args.section as 'blogs' | 'companies' | 'products' | 'socials',
            title_en: String(args.title_en),
            title_vi: String(args.title_vi || args.title_en),
            subtitle_en: args.subtitle_en ? String(args.subtitle_en) : undefined,
            subtitle_vi: args.subtitle_vi ? String(args.subtitle_vi) : undefined,
            url: String(args.url),
            icon: args.icon ? String(args.icon) : undefined,
            is_active: true,
          }, d1);
          break;

        case 'update_link':
          resultData = await updateLink(String(args.id), args, d1);
          break;

        case 'delete_link':
          resultData = { deleted: await deleteLink(String(args.id), d1) };
          break;

        case 'reorder_links':
          resultData = { success: await reorderLinks(args.order as string[], d1) };
          break;

        case 'get_theme': {
          const p = await getProfile(d1);
          resultData = { theme: p.theme, custom_css: p.custom_css };
          break;
        }

        case 'set_theme':
          resultData = await updateProfile({
            theme: String(args.theme),
            custom_css: args.custom_css ? String(args.custom_css) : undefined,
          }, d1);
          break;

        default:
          return new Response(JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${toolName}` },
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          });
      }

      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(resultData, null, 2),
            },
          ],
        },
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(JSON.stringify({
        jsonrpc: '2.0',
        id,
        error: { code: -32603, message: String(err) },
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  return new Response(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Method not found: ${method}` },
  }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
};
