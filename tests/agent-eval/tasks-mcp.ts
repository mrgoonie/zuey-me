import type { McpTask } from './lib/types';

/** Read-only tools only; the runner refuses anything outside READ_ONLY_TOOLS. */
export const READ_ONLY_TOOLS = new Set([
  'tools/list', 'get_profile', 'list_links', 'get_theme', 'reads_list', 'course_list', 'course_get',
  'booking_slots', 'article_list', 'article_get', 'knowledge_search', 'taxonomy_facets', 'plans_list',
  'github_activity_get', 'videos_list', 'video_get', 'block_schema',
]);

const t = (id: string, prompt: string, tool: string, args: Record<string, unknown> | undefined, matchers: McpTask['expect']['matchers'], min?: number): McpTask => ({
  id, lane: 'mcp', prompt, tool, args, expect: { matchers, min },
});

export const MCP_TASKS: McpTask[] = [
  t('mcp-tools-list', 'Discover which tools the anonymous MCP endpoint offers (profile, links, articles, plans, search).', 'tools/list', undefined,
    [{ text: '"get_profile"' }, { text: '"list_links"' }, { text: '"article_list"' }, { text: '"plans_list"' }, { text: '"knowledge_search"' }]),
  t('mcp-no-mutating-tools', 'Confirm the anonymous endpoint does not expose mutating tools.', 'tools/list', undefined,
    [{ notText: '"name":\\s*"(create|update|delete|set|publish)_' }]),
  t('mcp-get-profile', 'Who owns this site? Get the profile.', 'get_profile', undefined, [{ text: 'duy' }, { text: 'zuey' }]),
  t('mcp-list-links', 'List the product links of the site owner.', 'list_links', { section: 'products' }, [{ text: 'agentkit' }, { text: 'https?://' }]),
  t('mcp-list-articles', 'List the 5 newest published articles.', 'article_list', { limit: 5 }, [{ text: '"slug"' }, { text: '"title"' }]),
  t('mcp-find-pricing', 'What membership plans exist and what do they cost?', 'plans_list', undefined, [{ text: 'knowledges' }, { text: 'community' }, { text: '"price' }]),
  t('mcp-search-knowledge', 'Search the knowledge base for articles about MCP.', 'knowledge_search', { query: 'MCP', limit: 5 }, [{ text: '"results"' }, { text: '"slug"' }]),
  t('mcp-list-courses', 'Which courses are for sale? (An empty array is a valid answer.)', 'course_list', undefined, [{ text: '^\\s*\\[' }]),
  t('mcp-list-reads', 'Show 3 recommended reads.', 'reads_list', { limit: 3 }, [{ text: 'https?://' }, { text: 'title' }]),
  t('mcp-list-videos', 'List Zueytube videos.', 'videos_list', { limit: 5 }, [{ text: 'youtube|video' }, { text: 'title' }]),
  t('mcp-taxonomy', 'What tags and categories organise the articles?', 'taxonomy_facets', undefined, [{ text: 'tags' }, { text: 'categories' }]),
  t('mcp-booking-slots', 'Are there open consultation slots in the next 30 days?', 'booking_slots', { days: 30 }, [{ text: 'slots|start|available' }]),
  t('mcp-github-activity', 'What has the owner been doing on GitHub recently?', 'github_activity_get', undefined, [{ text: 'mrgoonie' }]),
];
