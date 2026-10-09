---
phase: 8
title: "Docs, remote migration, verification and PR"
status: completed
priority: P1
effort: 3h
dependsOn: [7]
---

# Phase 8 — Docs, migration, PR

## Steps
1. README: add "Referral program" bullet under Membership features (routes, module, cron path, R2 binding). `docs/env-setup.vi.md`: R2 bucket `zuey-referral-kyc` + binding `REFERRAL_KYC`, scheduler JOBS update, Dodo discount note, payout runbook (days 1–10, CSV, mark paid), accountant-confirmable deduction settings.
2. `bun test` and `bun run build` green.
3. Code review (`ak:code-review`) on the branch; fix findings.
4. Commit by concern (conventional commits), push branch, open PR to `main` (never push to main).
5. Remote rollout (after PR merge or with explicit user go-ahead): export Cloudflare account env; record `wrangler d1 time-travel info zuey_me_db`; `wrangler d1 execute zuey_me_db --remote --file=./migrations/0016_referrals.sql -y`; create R2 bucket; redeploy scheduler worker.
6. Dodo test-mode check result recorded in PR description.

## Done
All acceptance items in plan.md checked with evidence (test names, command output, PR link).
