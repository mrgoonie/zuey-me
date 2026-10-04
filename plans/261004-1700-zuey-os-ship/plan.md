# Zuey OS on zuey.me — ship plan

Status: A–C done, D (ship) in progress · Branch `claude/zuey-os-shell` (from `main` after PR #1 merge)
Design reference: `plans/261004-1330-zuey-os-demo/` (accepted direction "Zuey OS").

## Outcome
The homepage becomes Zuey OS: menubar, desktop with wallpaper, draggable/resizable windows, dock,
Exposé (all windows → thumbnails), theme (dark/light/system) + accent + wallpaper (presets, upload),
and a phone home screen below 768px. Every window hosts the real panel; no demo data.

## Constraints
- Real data only; `/pricing`, `/business`, `/reads`, `/account`, `/login`, `/articles/*` keep working (deep links, payment redirects, SEO).
- Five locales (en, vi, zh, ko, ja) for new UI strings.
- Edge runtime rules (AGENTS.md); no `any`; DoD: `bun test` 0 fail, `bun run build` 0 errors/warnings, OpenAPI matches endpoints.
- Locked article text never leaves the server.

## Phases (file ownership)
| # | Phase | Owner | Files |
|---|-------|-------|-------|
| A | OS shell | controller | `src/components/os/**`, `src/pages/index.astro`, `src/components/home/McpDialog.tsx` (export guide body) |
| B | Article partial paywall + open in new tab | subagent | `src/lib/blocks/paywall.ts`, `src/lib/blocks/articles.ts`, `src/pages/articles/[slug].astro`, `src/styles/blocks.css`, `src/components/knowledge/{KnowledgesPanel,ArticleCard,strings}.tsx/ts`, tests |
| C | GitHub contribution calendar | subagent | `src/lib/experience/github-calendar.ts`, `src/pages/api/v1/github/calendar.ts`, OpenAPI registry, `src/components/home/{ContributionGraph,GithubActivity}.tsx`, `home-i18n.ts` (activity strings), tests |
| D | Verify + ship | controller | DoD, PR, CI watch, production check |

## Acceptance
- Desktop ≥768px: windows open from dock/icons/hash (`/#ai`, `/#knowledges`…), drag, resize, minimize, maximize, close; Exposé from dock and Alt O; theme Alt T; wallpaper presets + upload persist per device.
- Mobile: home screen grid; app opens full screen with back.
- Article page: paid + not entitled → first third readable, remaining section headings shown blurred with skeleton lines, lockbox CTA; JSON-LD `hasPart` matches.
- Knowledges list: "Open in new tab" per article.
- GitHub window: 53-week contribution heatmap (server-fetched, cached) + existing activity feed.
- Production verified after deploy.
