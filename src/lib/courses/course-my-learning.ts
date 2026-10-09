/** A member's learning dashboard: owned courses with progress, XP/streak/badges and certificates. */
import type { D1DatabaseLike } from '../../db/store';
import type { RuntimeEnv } from '../../env';
import type { CertificateView } from './course-certificates';
import { listCertificates } from './course-certificates';
import type { LearnerSummary } from './course-gamification';
import { learnerSummary } from './course-gamification';
import type { CourseProgress } from './course-learning';
import { courseProgress } from './course-learning';
import { listPurchases } from './course-purchases';
import { getCourseById } from './course-store';

export interface MyCourse {
  id: string;
  slug: string;
  title: string;
  cover_url: string | null;
  source: 'purchase' | 'grant';
  granted_at: string;
  progress: CourseProgress;
}

export interface MyLearning {
  courses: MyCourse[];
  learner: LearnerSummary;
  certificates: CertificateView[];
}

export async function myLearning(d1: D1DatabaseLike, env: RuntimeEnv, userId: string): Promise<MyLearning> {
  const purchases = (await listPurchases(d1, userId)).filter(p => p.status === 'active');
  const courses: MyCourse[] = [];
  for (const p of purchases) {
    const course = await getCourseById(d1, p.course_id);
    if (!course) continue;
    courses.push({
      id: course.id, slug: course.slug, title: course.title, cover_url: course.cover_url, source: p.source, granted_at: p.granted_at,
      progress: await courseProgress(d1, userId, course.id),
    });
  }
  const [learner, certificates] = await Promise.all([learnerSummary(d1, userId), listCertificates(d1, env, userId)]);
  return { courses, learner, certificates };
}
