import { AppError } from '../../../../../lib/http';
import { getProposal } from '../../../../../lib/taxonomy/proposals';
import { adminRoute } from '../../../../../lib/taxonomy/routes';

export const GET = adminRoute(async ({ env, params }) => {
  const proposal = await getProposal(env.DB, params.id ?? '');
  if (!proposal) throw new AppError(404, 'not_found', 'Proposal not found');
  return proposal;
});
