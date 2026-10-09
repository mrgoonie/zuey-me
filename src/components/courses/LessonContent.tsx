import type { Block } from '../../lib/blocks/schema';
import type { PublicLessonBlock } from '../../lib/courses/lesson-blocks';
import { BlockRenderer } from '../blocks/BlockRenderer';
import { CourseMediaWidget } from './CourseMediaWidget';
import { GithubRepoWidget } from './GithubRepoWidget';
import { QuizWidget } from './QuizWidget';

/** A lesson split (on the server, by `lessonSegments`) into runs of article blocks and single course widgets. */
export type LessonSegment = { kind: 'article'; blocks: Block[] } | { kind: 'widget'; block: PublicLessonBlock };

interface Props {
  segments: LessonSegment[];
  courseSlug: string;
  lessonSlug: string;
  signedIn: boolean;
}

function Widget({ block, courseSlug, lessonSlug, signedIn }: { block: PublicLessonBlock } & Omit<Props, 'segments'>) {
  switch (block.type) {
    case 'quiz': return <QuizWidget block={block} courseSlug={courseSlug} lessonSlug={lessonSlug} signedIn={signedIn} />;
    case 'course_media': return <CourseMediaWidget block={block} courseSlug={courseSlug} lessonSlug={lessonSlug} />;
    case 'github_repo': return <GithubRepoWidget block={block} courseSlug={courseSlug} />;
    default: return null;
  }
}

/** Lesson body: article runs through the shared block renderer, course widgets through their own components. */
export function LessonContent({ segments, courseSlug, lessonSlug, signedIn }: Props) {
  if (segments.length === 0) return <p className="text-stone-600">Bài học này chưa có nội dung.</p>;
  return (
    <div className="min-w-0">
      {segments.map((seg, i) => seg.kind === 'article'
        // Surveys are an article feature (their answers are keyed by article), so they render read-only here.
        ? <BlockRenderer key={`a-${i}`} doc={{ version: 1, blocks: seg.blocks }} interactive={false} />
        : <Widget key={seg.block.id} block={seg.block} courseSlug={courseSlug} lessonSlug={lessonSlug} signedIn={signedIn} />)}
    </div>
  );
}
