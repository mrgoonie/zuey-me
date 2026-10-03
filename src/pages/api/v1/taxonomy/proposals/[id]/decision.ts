import { decideProposal } from '../../../../../../lib/taxonomy/proposals';
import { adminRoute } from '../../../../../../lib/taxonomy/routes';

/**
 * Admin: decide a proposal. Body: { decision: approve|edit|reject|defer, reason?,
 * confirm: true + expected_label_revision (approve/edit), assignments (edit) }. Approving twice is idempotent.
 */
export const POST = adminRoute(async ({ env, params, body, actor }) => decideProposal(env.DB, params.id ?? '', body, actor));
