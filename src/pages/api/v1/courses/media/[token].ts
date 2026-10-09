import { memberRoute } from '../../../../../lib/members/account';
import { serveCourseFile } from '../../../../../lib/courses/course-media-delivery';

/** Streams a private course file for a signed link from POST …/lessons/{lesson}/media (Range supported). */
export const GET = memberRoute(async ({ params, request }, { d1, env, principal }) => serveCourseFile(d1, env, principal, params.token ?? '', request));
