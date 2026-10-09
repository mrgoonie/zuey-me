import { referralAdminRoute } from '../../../../../../../../lib/referrals/admin-route';
import { parseIdImageSide } from '../../../../../../../../lib/referrals/payout-profiles';
import { readIdImage } from '../../../../../../../../lib/referrals/payout-profile-review';

/** Admin: view one national-ID image for review. Never cached; every view is audited. */
export const GET = referralAdminRoute(async (context, { d1, env, actor }) => {
  const image = await readIdImage(d1, env, context.params.userId ?? '', parseIdImageSide(context.params.side), actor);
  return new Response(image.body, {
    status: 200,
    headers: {
      'Content-Type': image.contentType,
      'Cache-Control': 'no-store',
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    },
  });
});
