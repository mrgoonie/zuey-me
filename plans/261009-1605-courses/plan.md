---
title: "Courses: replace AI Workflows with paid one-time courses"
status: in-review
priority: P1
branch: claude/courses-learning-widgets-cfcd72
created: 2026-10-09
---

# Courses

Source of truth: confirmed advise session (2026-10-09). Replaces AI Workflows.

## Locked decisions

- Workflows module deleted; `/workflows*` → 301 `/courses`. Taxonomy label kind `workflow` is unrelated and stays.
- Course → section → lesson; Vietnamese first, `locale` column. Lessons: draft/published block documents (Articles blocks + course widgets `quiz`, `course_media`, `github_repo` at top level).
- Admin marks lessons `is_trial` (free for everyone). Other lessons: owner or admin only. Paid lesson bodies never served to personal API keys / MCP; only outline + trial lessons in `.md`.
- One-time purchase, owned forever. List price USD; SePay VND = USD × `USD_VND_RATE` rounded up to 1,000 (code `ZSC…`); Dodo one-time via one pay-what-you-want product `DODO_PRODUCT_COURSE` with `amount` override.
- Subscriber discount: admin table plan → % (default 10/10/25/40), per-course override. Referral discount `d`. Applied = max(subscriber, referral). One `quoteCoursePrice()`.
- Referral: every course a referee buys earns commission (`source_kind = course_order`). Integrated through `src/lib/courses/referral-bridge.ts`; wired to `src/lib/referrals`: bound accounts earn commission on every course (binding already required a never-paid referee, so repeat course orders skip the "previously paid" block); unbound buyers follow the first-order rule.
- No refunds (Terms/Policy pages, checkbox required at checkout, terms version stored). Refund/chargeback/dispute → revoke access, GitHub, commission.
- Anti-abuse: max 2 member sessions per account (oldest dropped); IP/country anomaly in 24 h → review flag; per-user rate limits on lessons and media; email watermark; admin lock.
- Media: Cloudflare Stream signed tokens (RS256 JWT, ≤10 min); audio/files in private R2 (`COURSE_FILES`), streamed via HMAC-signed URLs (≤10 min, bound to user).
- Quiz: single/multiple/true-false, graded on server; answers stripped before render; XP once per quiz.
- Gamification: progress, append-only `xp_ledger` (idempotency keys, ready for future coupon redemption), badges, streaks, certificates (verify URL + OG image), monthly learner leaderboard (masked, opt-out).
- GitHub: private repos per course; invite linked GitHub identity as read collaborator through a retrying queue; removal on revoke.
- Zuey AI tutor: owners with `ai_chat`; lesson text injected as context; normal quota.

## Phases

| # | Phase | Status |
|---|-------|--------|
| 1 | Migration, remove Workflows, redirects | done |
| 2 | Course domain: store, lesson schema/validation, access policy, pricing | done |
| 3 | Orders: SePay ZSC + Dodo one-time + webhooks + revoke | done |
| 4 | Anti-abuse: sessions cap, signals, rate limits, locks; media signing | done |
| 5 | Learning: progress, quiz grading, XP/badges/streaks, certificates, leaderboard | done |
| 6 | GitHub invites queue, AI tutor context, scheduler job | done |
| 7 | REST + OpenAPI + MCP | done |
| 8 | UI: catalog, landing+checkout, reader, account, Studio, Terms/Policy, OS links | done |
| 9 | Referral wiring, docs, tests, build, PR | done |

## Done means

See advise handoff brief: workflows gone + 301; trial vs owner gating on HTML/.md/REST/MCP; SePay/Dodo idempotent purchases; price = list × (1 − max(sub, ref)); course_order commission + reversal; 3rd session evicts oldest; media URLs ≤10 min; quiz answers never sent to client; Terms/Policy + mandatory consent; phase-2 features; `bun test` + `bun run build` green; README/OpenAPI/env docs updated.

## Out of scope

XP→coupon redemption, bilingual courses, AI essay grading, fill-in/ordering questions, all-courses bundle, course subscriptions, time-limited access, hardware DRM.

## Ops (need owner action or confirmation)

- Remote D1 migration `0018_courses.sql` (Time Travel bookmark first; drops workflows, rebuilds two referral tables), R2 bucket `zuey-course-files`, Stream signing key, `DODO_PRODUCT_COURSE` (PWYW one-time), `GITHUB_COURSES_TOKEN`, `COURSE_MEDIA_SECRET`.
