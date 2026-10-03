import { cancelAuditJob } from '../../../../../../lib/taxonomy/audit';
import { adminRoute } from '../../../../../../lib/taxonomy/routes';

/** Admin: cancel a queued/running/paused job. Existing proposals stay for review. */
export const POST = adminRoute(async ({ env, params, actor }) => cancelAuditJob(env.DB, params.id ?? '', actor));
