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
  videos_list: PUBLIC,
  video_get: PUBLIC,
  video_add: ADMIN,
  video_update: ADMIN,
  video_delete: ADMIN,
  video_refetch_transcript: ADMIN,
  video_rewrite_transcript: ADMIN,
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
  article_edition_delete: ADMIN,
  article_revisions: ADMIN,
  article_tags_set: ADMIN,
  article_labels_set: ADMIN,
  article_labels_revert: ADMIN,
  // Knowledge search & taxonomy (search filters paid text by the caller inside the tool)
  knowledge_search: PUBLIC,
  label_create: ADMIN,
  label_proposal_create: ADMIN,
  label_proposal_decide: ADMIN,
  label_audit_job_create: ADMIN,
  taxonomy_facets: PUBLIC,
  article_editions: ADMIN,
  tag_list: ADMIN,
  tag_create: ADMIN,
  tag_update: ADMIN,
  tag_delete: ADMIN,
  category_list: ADMIN,
  category_create: ADMIN,
  category_update: ADMIN,
  category_delete: ADMIN,
  label_list: ADMIN,
  label_update: ADMIN,
  label_delete: ADMIN,
  article_labels_get: ADMIN,
  label_proposal_list: ADMIN,
  label_proposal_get: ADMIN,
  label_audit_job_list: ADMIN,
  label_audit_job_get: ADMIN,
  label_audit_job_run: ADMIN,
  label_audit_job_cancel: ADMIN,
  taxonomy_audit_log: ADMIN,
  search_reindex: ADMIN,
  // Membership & billing
  plans_list: PUBLIC,
  me_get: member('account:read'),
  me_keys_list: member('account:read'),
  billing_checkout_create: member('checkout:write'),
  billing_order_get: member('billing:read'),
  subscription_get: member('billing:read'),
  members_list: ADMIN,
  billing_attention_list: ADMIN,
  billing_order_resolve: ADMIN,
  // Zuey AI (the ai_chat entitlement is checked inside the tool)
  chat_ask: member('chat:write'),
  chat_sessions_list: member('chat:write'),
  chat_admin_sessions: ADMIN,
  // Homepage experience
  notice_send: ADMIN,
  notice_list: ADMIN,
  notice_expire: ADMIN,
  community_sweep: ADMIN,
  github_activity_get: PUBLIC,
  weather_get: PUBLIC,
  // Referral program (admin only; national-ID images are never returned)
  referral_settings_get: ADMIN,
  referral_settings_set: ADMIN,
  referral_referrer_update: ADMIN,
  referral_review_list: ADMIN,
  referral_commission_decide: ADMIN,
  referral_payouts_list: ADMIN,
  referral_payout_mark_paid: ADMIN,
  referral_leaderboard: ADMIN,
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
