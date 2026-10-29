import type { Block } from '../../lib/blocks/schema';
import { useMemo } from 'react';
import type { CodeHighlights } from '../../lib/blocks/code-syntax';
import { mathNumbers } from '../../lib/blocks/math';
import type { MathRenders } from '../../lib/blocks/math';
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
  /** Server-computed code tokens for the article runs. */
  highlights?: CodeHighlights;
  /** Server-typeset math for the article runs. */
  math?: MathRenders;
  /** Start interactive widgets near the viewport: published lessons only, never an admin's draft view. */
  autoRunInteractives?: boolean;
}

function Widget({ block, courseSlug, lessonSlug, signedIn }: { block: PublicLessonBlock } & Omit<Props, 'segments' | 'autoRunInteractives'>) {
  switch (block.type) {
    case 'quiz': return <QuizWidget block={block} courseSlug={courseSlug} lessonSlug={lessonSlug} signedIn={signedIn} />;
    case 'course_media': return <CourseMediaWidget block={block} courseSlug={courseSlug} lessonSlug={lessonSlug} />;
    case 'github_repo': return <GithubRepoWidget block={block} courseSlug={courseSlug} />;
    default: return null;
  }
}

/** Lesson body: article runs through the shared block renderer, course widgets through their own components. */
export function LessonContent({ segments, courseSlug, lessonSlug, signedIn, highlights, math, autoRunInteractives = false }: Props) {
  // Equation numbers run across the whole lesson, not restart in each article run.
  const numbering = useMemo(() => mathNumbers(segments.flatMap(seg => (seg.kind === 'article' ? seg.blocks : [])), math), [segments, math]);
  if (segments.length === 0) return <p className="text-stone-600">Bài học này chưa có nội dung.</p>;
  return (
    <div className="min-w-0">
      {segments.map((seg, i) => seg.kind === 'article'
        // Surveys are an article feature (their answers are keyed by article), so they render read-only here.
        ? <BlockRenderer key={`a-${i}`} doc={{ version: 1, blocks: seg.blocks }} highlights={highlights} math={math} mathNumbering={numbering} interactive={false} autoRunInteractives={autoRunInteractives} />
        : <Widget key={seg.block.id} block={seg.block} courseSlug={courseSlug} lessonSlug={lessonSlug} signedIn={signedIn} />)}
    </div>
  );
}
