import { runAuditBatch } from '../../../../../../lib/taxonomy/audit';
import { adminRoute } from '../../../../../../lib/taxonomy/routes';

/** Admin: process the next batch (503 ai_unavailable without the AI binding). Repeat until status is completed. */
export const POST = adminRoute(async ({ env, params, actor }) => runAuditBatch(env.DB, env, params.id ?? '', actor));
