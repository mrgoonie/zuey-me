/** Reader-facing words of the composition widgets, per edition language (Vietnamese when absent). */
import type { ProgressState, StatState, StatTrend, StepStatus } from './schema';

export interface WidgetLabels {
  status: Record<StepStatus, string>;
  trend: Record<StatTrend, string>;
  statState: Record<StatState, string>;
  progressState: Record<ProgressState, string>;
  yes: string;
  no: string;
  recommended: string;
  pros: string;
  cons: string;
  feature: string;
  step: (n: number) => string;
  /** Screen-reader text for a sparkline. */
  sparkline: (count: number, min: string, max: string, last: string) => string;
  rating: (value: string, max: string) => string;
}

const VI: WidgetLabels = {
  status: { done: 'Đã xong', current: 'Đang thực hiện', upcoming: 'Sắp tới' },
  trend: { up: 'Tăng', down: 'Giảm', flat: 'Không đổi' },
  statState: { positive: 'tích cực', negative: 'tiêu cực', neutral: 'trung tính' },
  progressState: { positive: 'Tốt', warning: 'Cần chú ý', negative: 'Kém', neutral: '' },
  yes: 'Có',
  no: 'Không',
  recommended: 'Đề xuất',
  pros: 'Ưu điểm',
  cons: 'Nhược điểm',
  feature: 'Tính năng',
  step: n => `Bước ${n}`,
  sparkline: (count, min, max, last) => `Xu hướng ${count} điểm, thấp nhất ${min}, cao nhất ${max}, gần nhất ${last}`,
  rating: (value, max) => `${value} trên ${max} sao`,
};

const EN: WidgetLabels = {
  status: { done: 'Done', current: 'In progress', upcoming: 'Upcoming' },
  trend: { up: 'Up', down: 'Down', flat: 'Unchanged' },
  statState: { positive: 'positive', negative: 'negative', neutral: 'neutral' },
  progressState: { positive: 'Good', warning: 'Needs attention', negative: 'Poor', neutral: '' },
  yes: 'Yes',
  no: 'No',
  recommended: 'Recommended',
  pros: 'Pros',
  cons: 'Cons',
  feature: 'Feature',
  step: n => `Step ${n}`,
  sparkline: (count, min, max, last) => `Trend of ${count} points, low ${min}, high ${max}, latest ${last}`,
  rating: (value, max) => `${value} out of ${max} stars`,
};

export function widgetLabels(locale?: string): WidgetLabels {
  return locale !== undefined && locale !== 'vi' ? EN : VI;
}
