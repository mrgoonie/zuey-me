import { createAuditJob, listAuditJobs, parseJobInput } from '../../../../../lib/taxonomy/audit';
import { adminRoute } from '../../../../../lib/taxonomy/routes';

/** Admin: recent label audit jobs. */
export const GET = adminRoute(async ({ env }) => listAuditJobs(env.DB));

/**
 * Admin: queue an AI label audit over published editions. Body: { locales?, article_ids?, skip_unchanged?, batch_size? }.
 * Run it in resumable batches with POST /api/v1/taxonomy/audit-jobs/{id}/run.
 */
export const POST = adminRoute(async ({ env, body, actor }) => createAuditJob(env.DB, parseJobInput(body), actor), 201);
