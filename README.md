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
  - **Zuey for Business booking** (`/business`, `/booking/[id]`, `/api/v1/booking/*`, webhooks `/api/webhooks/polar`, `/api/webhooks/sepay`): `src/lib/booking/`, `src/lib/payments/`, `src/lib/integrations/`. A partial unique index guarantees one active booking per slot.
  - **Articles & rich blocks** (`/articles`, `/api/v1/articles`, `/api/v1/surveys/*`): `src/lib/blocks/` validates chart, Mermaid diagram, survey, embed and layout blocks; surveys accept one vote per hashed voter.
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
- Remote D1 schema migrations (apply in order): `wrangler d1 execute zuey_me_db --remote --file=./migrations/<file>.sql -y` for `0001_initial.sql` through `0005_booking_and_payments.sql`.

### Environment & Secrets

Names only — never commit values. Set them with `wrangler pages secret put <NAME>` (production) or a local, git-ignored `.dev.vars`. Full step-by-step guide: [docs/env-setup.vi.md](docs/env-setup.vi.md).

| Feature | Variables / bindings |
|---|---|
| Surveys | `SURVEY_HASH_SALT` |
| Reads | `ANYMD_API_KEY`, `READS_SUMMARY_MODEL` (optional), Workers AI binding `AI` |
| Booking calendar | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_CALENDAR_REFRESH_TOKEN`, `GOOGLE_CALENDAR_ID` |
| Polar | `POLAR_ACCESS_TOKEN`, `POLAR_WEBHOOK_SECRET`, `POLAR_CONSULTATION_PRODUCT_ID`, `POLAR_API_BASE` (optional) |
| SePay | `SEPAY_WEBHOOK_API_KEY`, `SEPAY_BANK_ACCOUNT`, `SEPAY_BANK_CODE`, `CONSULTATION_PRICE_VND` |
| Email | `RESEND_API_KEY`, `RESEND_FROM` |
| Reads cron (GitHub) | secret `ZUEY_ADMIN_API_KEY`, variable `SITE_URL` |

Missing credentials return an explicit `503` error naming the missing variables instead of failing silently.
