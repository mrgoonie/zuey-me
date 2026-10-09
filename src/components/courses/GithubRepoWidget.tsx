import type { GithubRepoBlock } from '../../lib/courses/lesson-blocks';
import { widgetCard } from './course-ui';

/** Repository card inside a lesson. The repo is private: access is granted to course owners' linked GitHub accounts. */
export function GithubRepoWidget({ block, courseSlug }: { block: GithubRepoBlock; courseSlug: string }) {
  return (
    <aside className={widgetCard} aria-label={`Kho GitHub ${block.repo}`}>
      <div className="flex items-start gap-3 min-w-0">
        <svg viewBox="0 0 24 24" width="28" height="28" className="shrink-0 text-stone-900" fill="currentColor" aria-hidden="true">
          <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.7 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
        </svg>
        <div className="min-w-0 flex-1">
          <p className="font-serif text-lg font-bold break-words">{block.title || block.repo}</p>
          <a href={`https://github.com/${block.repo}`} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-[44px] items-center font-mono text-sm font-semibold underline break-all">
            github.com/{block.repo}
          </a>
          {block.description && <p className="text-sm text-stone-700 whitespace-pre-line">{block.description}</p>}
          <p className="mt-2 text-xs text-stone-600">
            Kho riêng tư: quyền đọc đi kèm khi bạn mua khoá học và đã liên kết GitHub. Xem trạng thái lời mời ở{' '}
            <a href={`/courses/${courseSlug}#repos-title`} className="underline">trang khoá học</a>.
          </p>
        </div>
      </div>
    </aside>
  );
}
