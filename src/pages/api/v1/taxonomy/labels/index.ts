import { createLabel, listLabels, parseLabelInput } from '../../../../../lib/taxonomy/labels';
import { adminRoute } from '../../../../../lib/taxonomy/routes';

/** Admin: label vocabulary including unapproved extensions. */
export const GET = adminRoute(async ({ env }) => listLabels(env.DB, { includeUnapproved: true }));

/**
 * Admin: add a label to an admin-managed vocabulary (domain, tool, model, workflow, mindset) or propose an
 * `extension` label (stays unapproved unless approve: true). claim/freshness are built in and closed.
 */
export const POST = adminRoute(async ({ env, body, actor }) => createLabel(env.DB, parseLabelInput(body, 'create'), actor), 201);
