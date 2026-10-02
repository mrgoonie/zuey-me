import type { UserKeyScope } from '../members/api-keys';
import type { Principal } from '../members/policy';
import { can } from '../members/policy';
import type { McpTool } from '../mcp/types';

/**
 * Who may SEE a tool in `tools/list` on `/mcp`. Calls are still authorized inside each tool, so this
 * map only filters the catalogue; it never grants access. Tools missing from the map are treated as
 * admin-only (fail closed) and a test keeps the map complete.
 */
export type ToolAccess =
  | { kind: 'public' }
  | { kind: 'member'; scope: UserKeyScope }
  | { kind: 'admin' };

const PUBLIC: ToolAccess = { kind: 'public' };
const ADMIN: ToolAccess = { kind: 'admin' };
const member = (scope: UserKeyScope): ToolAccess => ({ kind: 'member', scope });

export const TOOL_ACCESS: Record<string, ToolAccess> = {
  // Profile & links
  get_profile: PUBLIC,
  list_links: PUBLIC,
  get_theme: PUBLIC,
  update_profile: ADMIN,
  create_link: ADMIN,
  update_link: ADMIN,
  delete_link: ADMIN,
  reorder_links: ADMIN,
  set_theme: ADMIN,
  // Zuey Reads
  reads_list: PUBLIC,
  reads_sync: ADMIN,
  // Workflows (drafts need admin inside the tool)
  workflow_list: PUBLIC,
  workflow_get: PUBLIC,
  workflow_create: ADMIN,
  workflow_update: ADMIN,
  workflow_delete: ADMIN,
  workflow_publish: ADMIN,
  // Booking
  booking_slots: PUBLIC,
  booking_list: ADMIN,
  availability_get: ADMIN,
  availability_set: ADMIN,
  booking_update_status: ADMIN,
  // Articles (full text depends on the caller's scope + plan inside the tool)
  block_schema: PUBLIC,
  article_list: PUBLIC,
  article_get: PUBLIC,
  article_create: ADMIN,
  article_update: ADMIN,
  article_publish: ADMIN,
  article_delete: ADMIN,
  survey_results: ADMIN,
  // Membership & billing
  plans_list: PUBLIC,
  me_get: member('account:read'),
  me_keys_list: member('account:read'),
  billing_checkout_create: member('checkout:write'),
  billing_order_get: member('billing:read'),
  subscription_get: member('billing:read'),
  members_list: ADMIN,
};

export function toolAccess(name: string): ToolAccess {
  return TOOL_ACCESS[name] ?? ADMIN;
}

export function canSeeTool(p: Principal, access: ToolAccess): boolean {
  if (access.kind === 'public') return true;
  if (access.kind === 'admin') return can(p, 'admin');
  if (p.kind === 'admin') return true;
  return p.userId !== null && (p.scopes === null || p.scopes.includes(access.scope));
}

export function visibleTools(p: Principal, tools: McpTool[]): McpTool[] {
  return tools.filter(t => canSeeTool(p, toolAccess(t.name)));
}
