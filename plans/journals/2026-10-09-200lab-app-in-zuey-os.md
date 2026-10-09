---
title: 200lab app in Zuey OS
date: 2026-10-09
---

# 200lab app in Zuey OS

Added a 200lab courses app (Zuey OS window, /200lab, /200lab.md) with referral links (?ref=T2CWW3D7). PR mrgoonie/zuey-me#33.

Decisions: parse courses.md (richer than courses.xml); serve a D1 snapshot and refresh after the response with waitUntil, so the homepage never waits on 200lab; a failed or empty parse keeps the last good list; one courseLink() builds every link. Intro and picks are hard-coded (no Studio tab).

Gotcha: a fresh worktree's local D1 has no tables, and astro dev keeps its D1 handle open, so apply migrations with `wrangler d1 execute --local` and then restart the dev server.

Remote migration 0014 applied 2026-10-09; Time Travel bookmark before it: 0000037a-00000032-000050ff-c29a1e84df22c2c15370cb4a687cd45a.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.
