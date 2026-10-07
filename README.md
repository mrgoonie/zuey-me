# zuey.me

Personal profile, Page Builder Studio, REST API, MCP Server, and AI Agent Skill for **Duy Nguyen (/zuey/)**.

- **Deployed URL**: [https://zuey.me](https://zuey.me)
- **Target Domain**: `zuey.me` (attached to Cloudflare Pages; DNS managed on Cloudflare)

---

## Architecture & Responsibilities

The system runs on **Cloudflare Pages** (SSR via `@astrojs/cloudflare`) backed by **Cloudflare D1** (`zuey_me_db`) and client-side **PostHog** analytics.

- **Public Profile & Modals**: `src/components/ProfileView.tsx` renders the link-in-bio interface, fast social share sheet, and QR code modal.
- **Data & Storage**: `src/db/` defines the schema (`src/db/types.ts`), initial seed data (`src/db/data.ts`), and edge D1 store (`src/db/store.ts`).
- **Page Builder Studio**: `src/pages/studio/index.astro` and `src/components/studio/StudioApp.tsx` provide SSO login, link ordering, theme switching, and API key management.
- **API & Docs**: `src/pages/api/` exposes REST endpoints and OpenAPI 3.1 specification; `src/pages/docs/index.astro` serves interactive Scalar documentation.
- **Machine & Agent Surfaces**:
  - LLM Context: `src/pages/llms.txt.ts` and `src/pages/llms-full.txt.ts`
  - Markdown Routes: `src/pages/index.md.ts`, `src/pages/links.md.ts`, `src/pages/profile.md.ts`
  - MCP Server: `src/pages/api/mcp.ts`
  - NPM CLI: `packages/cli/bin/zuey.js`
  - Agent Skill: `skills/zuey-me/SKILL.md`
- **Membership features** (each has a migration, REST endpoints in OpenAPI/Scalar, and MCP tools registered in `src/lib/mcp/registry.ts` / `src/lib/openapi/registry.ts`):
  - **Zuey Reads** (`/reads`, `/reads.md`, `/api/v1/reads`, `POST /api/v1/reads/sync`): `src/lib/reads/` syncs AnyMD items tagged `zuey-reads` and caches Workers AI summaries by content hash. AnyMD has no server-side tag filter, so the sync pages the library and filters locally. Scheduled by `.github/workflows/reads-sync.yml`.
  - **AI Workflows** (`/workflows`, `/api/v1/workflows`): `src/lib/workflows/` keeps draft and published JSON apart; publishing requires explicit confirmation and is blocked when the secret scan finds credentials. Local extraction skill: `skills/zuey-me/workflows/`.
  - **Zuey for Business booking** (`/business`, `/booking/[id]`, `/api/v1/booking/*`, webhooks `/api/webhooks/paypal`, `/api/webhooks/sepay`; membership cards via `/api/webhooks/dodo`): `src/lib/booking/`, `src/lib/payments/`, `src/lib/integrations/`. A partial unique index guarantees one active booking per slot.
  - **Articles & rich blocks** (`/articles`, `/api/v1/articles`, `/api/v1/surveys/*`): `src/lib/blocks/` validates chart, Mermaid diagram, survey, embed and layout blocks; surveys accept one vote per hashed voter.
    - **Share images** (`/articles/{slug}/og.png?lang=xx&v=hash`, used as `og:image` / `twitter:image`): `src/lib/og/` draws a 1200×630 card per published edition with satori + resvg (wasm imported as `?module`; satori stays at 0.32.0 because later versions load HarfBuzz in a way Workers cannot run). Images are stored in D1 (`article_og_images`) and re-rendered in the background (`waitUntil`) after every update, publish, tag or edition change; `v` is a content hash, so social networks fetch a new picture after edits. Bump `OG_TEMPLATE_VERSION` when the design changes. Preview locally with `bun scripts/preview-article-og.ts <slug> <outDir>`.
  - **Members & plans** (`/login`, `/account`, `/pricing`, `/billing/[code]`, `/api/members/auth/*`, `/api/v1/me/*`, `/api/v1/plans`, `/api/v1/billing/*`, `/api/v1/admin/members`): `src/lib/members/`. Sign-in by magic link (Resend) or Google/GitHub (reusing the Studio OAuth callbacks); `policy.ts` (`resolvePrincipal` + `can`) is the single access decision for HTML, `.md`, REST and MCP. Full articles need the `read_full` entitlement (Knowledges, Kết hợp, Cộng đồng); admins are verified emails in `ADMIN_EMAILS`. Personal `zk_` API keys are scope-limited and never admin. Plans are prepaid 1/3/6/12 months by SePay `ZSB…` transfers; renewal reminders run from `.github/workflows/billing-reminders.yml`.
- Studio tabs for Articles, Reads, Workflows and Booking live in `src/components/studio/`.

---

## Operating Workflow

Executable commands are defined in `package.json`.

```bash
bun run dev      # Local development server
bun test         # Run automated test suite
bun run build    # Typecheck and build production bundle
```

### Deployment & CI/CD

- Workflow: `.github/workflows/deploy.yml` runs test suite and production build on push to `main`.
- Automated deploy to Cloudflare Pages runs when repository secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are configured.
- Manual deployment via wrangler: `wrangler pages deploy dist --project-name=zuey-me --branch=main`.
- The Pages project, the D1 database and the `zuey.me` DNS zone live in the same Cloudflare account. Export that account's `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` before any wrangler command so a cached OAuth login for another account is never used.
- Remote D1 schema migrations (apply every file in `migrations/` in numeric order): `wrangler d1 execute zuey_me_db --remote --file=./migrations/<file>.sql -y`. Record a Time Travel bookmark first (`wrangler d1 time-travel info zuey_me_db`); `wrangler d1 export` refuses databases with FTS5 tables.

### Environment & Secrets

Names only — never commit values. Set them with `wrangler pages secret put <NAME>` (production) or a local, git-ignored `.dev.vars`. Full step-by-step guide: [docs/env-setup.vi.md](docs/env-setup.vi.md).

| Feature | Variables / bindings |
|---|---|
| Surveys | `SURVEY_HASH_SALT` |
| Reads | `ANYMD_API_KEY`, `READS_SUMMARY_MODEL` (optional), Workers AI binding `AI` |
| Booking calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALENDAR_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID` |
| PayPal (consultation, USD) | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_WEBHOOK_ID`, `PAYPAL_API_BASE` (optional, sandbox) |
| Dodo Payments (membership cards, USD) | `DODO_API_KEY`, `DODO_WEBHOOK_SECRET`, `DODO_PRODUCT_KNOWLEDGES`, `DODO_PRODUCT_AI`, `DODO_PRODUCT_COMBO`, `DODO_PRODUCT_COMMUNITY`, `DODO_API_BASE` (optional, test mode) |
| SePay | `SEPAY_WEBHOOK_API_KEY`, `SEPAY_BANK_ACCOUNT`, `SEPAY_BANK_CODE`, `CONSULTATION_PRICE_VND` |
| Email | `RESEND_API_KEY`, `RESEND_FROM` |
| Members & billing | `ADMIN_EMAILS`, `MEMBER_HASH_SALT`, `USD_VND_RATE`, `SEPAY_API_TOKEN` (reconciliation), plus the SePay bank variables and `PUBLIC_SITE_URL` |
| Zuey AI chat | `DEWEE_GATEWAY_URL`, `DEWEE_GATEWAY_TOKEN`, `DEWEE_AGENT_KEY`, `AI_MONTHLY_REQUEST_LIMIT` / `AI_EST_COST_USD_PER_MTOK` (optional) |
| Jev relevance (TypeSafe AI) | `TYPESAFEAI_API_KEY` enables reranking; `TYPESAFE_API_BASE` / `TYPESAFE_MODEL` (optional) |
| Interactive blocks | `SANDBOX_FETCH_ALLOWLIST` (empty disables the fetch proxy) |
| Telegram community | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_GROUP_EN_ID`, `TELEGRAM_GROUP_VI_ID`, `TELEGRAM_WEBHOOK_SECRET` |
| MCP from other web origins | `MCP_ALLOWED_ORIGINS` (optional) |
| Reads / reminders cron (GitHub) | secret `ZUEY_ADMIN_API_KEY`, variable `SITE_URL` |

Missing credentials return an explicit `503` error naming the missing variables instead of failing silently.
