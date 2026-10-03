import { listAuditLog } from '../../../../lib/taxonomy/common';
import { adminRoute } from '../../../../lib/taxonomy/routes';

/** Admin: taxonomy audit trail (?target_type=tag|category|label|article|proposal|audit_job&target_id=&limit=). */
export const GET = adminRoute(async ({ env, url }) => listAuditLog(env.DB, {
  targetType: url.searchParams.get('target_type') ?? undefined,
  targetId: url.searchParams.get('target_id') ?? undefined,
  limit: Number(url.searchParams.get('limit') ?? '100') || 100,
}));
