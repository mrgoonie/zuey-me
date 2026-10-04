# Phase C — GitHub contribution calendar

Status: DONE

## Delivered
- `src/lib/experience/github-calendar.ts` — `parseContributionCalendar(html)` (regex, edge-safe), `getContributionCalendar(cache?)`: 6 h fresh cache, 14 d stale copy, rate-limit block memory, stale-on-error with `error.code` `github_rate_limited | github_unavailable`. HTML scraping of `github.com/users/mrgoonie/contributions` only (no GraphQL: no `GITHUB_TOKEN` binding exists).
- `GET /api/v1/github/calendar` → `{ user, total, days: [{ date, count|null, level }], fetched_at, error? }`; `Cache-Control: public, max-age=3600, stale-while-revalidate=21600` (stale: `max-age=60`, thrown: `no-store`).
- OpenAPI: path + `GithubCalendar` schema added to `src/lib/experience/openapi.ts` (the fragment that already documents github activity and is already in the registry, so `src/lib/openapi/registry.ts` was not touched).
- `src/components/home/ContributionGraph.tsx` + `contribution-graph.css` (`cg-` prefix, `--gh-0..4` dark defaults, light under `:root[data-zt="light"]`).
- `GithubActivity.tsx`: bar graph replaced by the heatmap; day selection filters the event list in the viewer's local time zone; clear-filter chip; calendar skeleton / error / stale notice; `variant?: 'section' | 'window'`.
- `api-client.ts`: `parseCalendar`. `home-i18n.ts`: `activity.calendar.*` + updated `activity.disclaimer` in en/vi/zh/ko/ja.

## Verification
- `bun test tests/experience.test.ts`: 26 pass. Full `bun test`: 317 pass, 0 fail.
- `bunx astro check`: 0 errors, 0 warnings.
- Manual parser run against the live page: 365 days, all with counts, total 15,110.

## Notes for the OS shell
- `GithubActivity` still relies on `home.css` classes (`home-notice-line`, `home-events`, `home-cta`, `home-skeleton`) and stone text colours; the OS window must load `home.css` or restyle these.
- Heatmap colours follow `data-zt`; without the attribute the dark palette applies.
- Event times are now shown in the viewer's local zone (previously Asia/Saigon) so they agree with the day filter.
- `activity.graphLabel` and `activity.allDays` strings are now unused (left in place).
