import { AppError } from '../../../../../lib/http';
import { getAuditJob } from '../../../../../lib/taxonomy/audit';
import { adminRoute } from '../../../../../lib/taxonomy/routes';

export const GET = adminRoute(async ({ env, params }) => {
  const job = await getAuditJob(env.DB, params.id ?? '');
  if (!job) throw new AppError(404, 'not_found', 'Audit job not found');
  return job;
});
