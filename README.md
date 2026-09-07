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
- Remote D1 schema migrations: `wrangler d1 execute zuey_me_db --remote --file=./migrations/0001_initial.sql`.
