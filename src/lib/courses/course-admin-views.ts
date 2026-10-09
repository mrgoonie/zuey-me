/** Studio shapes: the full course tree (drafts included), lessons with both documents, and assets. */
import type { D1DatabaseLike } from '../../db/store';
import { listAssets } from './course-asset-store';
import { getPlanDiscountTable, coursePlanDiscounts } from './course-pricing';
import { courseOutline } from './course-structure-store';
import type { AssetRecord, CourseRecord, LessonRecord } from './course-types';
import type { LessonDocument } from './lesson-blocks';
import { emptyLessonDocument, parseStoredLesson } from './lesson-blocks';
import type { Row } from '../members/runtime';

export type AdminLessonView = Omit<LessonRecord, 'draft_json' | 'published_json'> & {
  draft: LessonDocument;
  published: LessonDocument | null;
  /** True when the draft differs from what readers get. */
  has_unpublished_changes: boolean;
};

export function adminLessonView(lesson: LessonRecord): AdminLessonView {
  const { draft_json, published_json, ...rest } = lesson;
  return {
    ...rest,
    draft: parseStoredLesson(draft_json) ?? emptyLessonDocument(),
    published: parseStoredLesson(published_json),
    has_unpublished_changes: lesson.status !== 'published' || draft_json !== published_json,
  };
}

export async function adminCourseView(d1: D1DatabaseLike, course: CourseRecord) {
  const [outline, assets, table, owners] = await Promise.all([
    courseOutline(d1, course.id, true),
    listAssets(d1, course.id),
    getPlanDiscountTable(d1),
    d1.prepare("SELECT COUNT(*) AS n FROM course_purchases WHERE course_id = ? AND status = 'active'").bind(course.id).first<Row>(),
  ]);
  return {
    course,
    effective_plan_discounts: coursePlanDiscounts(course, table),
    outline,
    assets: assets as AssetRecord[],
    active_owners: Number(owners?.n ?? 0),
  };
}
