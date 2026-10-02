import {
  createLink, deleteLink, getLinks, getProfile, reorderLinks, updateLink, updateProfile,
} from '../../db/store';
import type { LinkItem } from '../../db/types';
import { AppError } from '../http';
import { MCP_FEATURE_MODULES } from './registry';
import type { McpContext, McpTool } from './types';

/**
 * Tool catalogue and call dispatcher shared by the legacy `/api/mcp` endpoint and the OAuth-protected
 * Streamable HTTP endpoint `/mcp`. Authorization stays inside each tool (`ctx.requireAdmin()`,
 * `ctx.principal()` + `can()`), so both endpoints make identical decisions.
 */
export const CORE_TOOLS: McpTool[] = [
  {
    name: 'get_profile',
    description: 'Get Duy Nguyen (/zuey/) current profile, bio (EN & VI), avatar, and theme.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'update_profile',
    description: 'Admin: update Duy Nguyen profile details: name, handle, bio in EN or VI, avatar URL.',
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
        section: { type: 'string', enum: ['all', 'blogs', 'companies', 'products', 'socials'], description: 'Filter by category section' },
      },
    },
  },
  {
    name: 'create_link',
    description: 'Admin: add a new link card to blogs, companies ("Found by me!"), or products.',
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
    description: 'Admin: update an existing link card by ID.',
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
    description: 'Admin: remove a link card from the profile by ID.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'Link card ID to delete' } } },
  },
  {
    name: 'reorder_links',
    description: 'Admin: set custom ordering sequence of links using an array of link IDs.',
    inputSchema: {
      type: 'object',
      required: ['order'],
      properties: { order: { type: 'array', items: { type: 'string' }, description: 'Array of link IDs in desired display order' } },
    },
  },
  {
    name: 'get_theme',
    description: 'Get current visual theme preset and custom CSS styling.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'set_theme',
    description: 'Admin: change profile visual theme (ivory | dark | minimal | glass) and optional custom CSS.',
    inputSchema: {
      type: 'object',
      required: ['theme'],
      properties: {
        theme: { type: 'string', enum: ['ivory', 'dark', 'minimal', 'glass'], description: 'Theme visual preset name' },
        custom_css: { type: 'string', description: 'Optional custom CSS rules' },
      },
    },
  },
];

const CORE_MUTATIONS = new Set(['update_profile', 'create_link', 'update_link', 'delete_link', 'reorder_links', 'set_theme']);
const LINK_SECTIONS: LinkItem['section'][] = ['blogs', 'companies', 'products', 'socials'];

/** Every tool served by the MCP endpoints, in a stable order. */
export function allMcpTools(): McpTool[] {
  return [...CORE_TOOLS, ...MCP_FEATURE_MODULES.flatMap(m => m.tools)];
}

export function findMcpTool(name: string): McpTool | undefined {
  return allMcpTools().find(t => t.name === name);
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== 'string' || v.trim() === '') throw new AppError(400, 'invalid_field', `${key} is required`, { field: key });
  return v;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function isLinkSection(v: unknown): v is LinkItem['section'] {
  return typeof v === 'string' && (LINK_SECTIONS as string[]).includes(v);
}

async function callCoreTool(name: string, args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const d1 = ctx.d1;
  if (CORE_MUTATIONS.has(name)) await ctx.requireAdmin();
  switch (name) {
    case 'get_profile':
      return getProfile(d1);
    case 'update_profile':
      return updateProfile(args, d1);
    case 'list_links': {
      const links = await getLinks(d1);
      const section = optionalString(args, 'section');
      return section && section !== 'all' ? links.filter(l => l.section === section) : links;
    }
    case 'create_link': {
      const section = args.section;
      if (!isLinkSection(section)) throw new AppError(400, 'invalid_field', `section must be one of ${LINK_SECTIONS.join(', ')}`, { field: 'section' });
      const titleEn = requiredString(args, 'title_en');
      return createLink({
        section,
        title_en: titleEn,
        title_vi: optionalString(args, 'title_vi') ?? titleEn,
        subtitle_en: optionalString(args, 'subtitle_en'),
        subtitle_vi: optionalString(args, 'subtitle_vi'),
        url: requiredString(args, 'url'),
        icon: optionalString(args, 'icon'),
        is_active: true,
      }, d1);
    }
    case 'update_link':
      return updateLink(requiredString(args, 'id'), args, d1);
    case 'delete_link':
      return { deleted: await deleteLink(requiredString(args, 'id'), d1) };
    case 'reorder_links': {
      const order = args.order;
      if (!Array.isArray(order) || !order.every((x): x is string => typeof x === 'string')) {
        throw new AppError(400, 'invalid_field', 'order must be an array of link IDs', { field: 'order' });
      }
      return { success: await reorderLinks(order, d1) };
    }
    case 'get_theme': {
      const p = await getProfile(d1);
      return { theme: p.theme, custom_css: p.custom_css };
    }
    case 'set_theme':
      return updateProfile({ theme: requiredString(args, 'theme'), custom_css: optionalString(args, 'custom_css') }, d1);
    default:
      throw new AppError(404, 'unknown_tool', `Unknown tool ${name}`);
  }
}

/** Calls a tool by name. Throws AppError (401/403/404/4xx) for authorization, unknown tools and bad input. */
export async function callMcpTool(name: string, args: Record<string, unknown>, ctx: McpContext): Promise<unknown> {
  const featureModule = MCP_FEATURE_MODULES.find(m => m.tools.some(t => t.name === name));
  if (featureModule) return featureModule.call(name, args, ctx);
  return callCoreTool(name, args, ctx);
}
