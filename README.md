# zuey.me

Personal Linktree profile, Page Builder Studio, REST API, MCP Server, and AI Agent Skill for **Duy Nguyen (/zuey/)**.

Live production: [https://zuey.me](https://zuey.me) (Edge: [https://zuey-me.pages.dev](https://zuey-me.pages.dev))

---

## Architecture & System Roles

The project is an Astro application deployed on **Cloudflare Pages** with server-side rendering (`@astrojs/cloudflare`), persistent SQLite edge storage via **Cloudflare D1**, and client-side analytics via **PostHog**.

```
zuey-me/
├── src/
│   ├── components/       # UI components (ProfileView, ShareModal, QrCodeModal, LinkCard)
│   ├── components/studio/# Page Builder Studio (SSO, link editor, theme switcher, API keys)
│   ├── db/               # Schema types, seed data, and D1 store abstraction
│   ├── layouts/          # Root layout with OpenGraph, fonts & PostHog tracking
│   ├── pages/            # Astro pages, Markdown routes, OpenAPI & REST endpoints
│   └── styles/           # Tailwind base styles and keyframe animations
├── packages/cli/         # Standalone npm CLI package (zuey-cli)
├── skills/zuey-me/       # AgentKit / Claude Code Skill (SKILL.md)
├── migrations/           # D1 SQL schema migrations
└── tests/                # Automated test suite (bun test / vitest)
```

---

## Canonical Entry Points & Surfaces

| Surface | Location / Endpoint | Purpose |
| :--- | :--- | :--- |
| **Public Profile** | `/` | Responsive Linktree profile (warm ivory `#F5EFEB`, Fraunces serif, multi-language EN/VI). |
| **Fast Share Sheet** | Modal on `/` | 1-click share to X, FB, WhatsApp, LinkedIn, Messenger, QR code, and clipboard. |
| **Interactive QR Code** | Modal on `/` | Dynamic canvas/image QR code generator for instant mobile scanning. |
| **Markdown Direct** | `/index.md`, `/links.md`, `/profile.md` | Clean markdown representations for AI scrapers and terminal browsers. |
| **SEO & GEO Context** | `/llms.txt`, `/llms-full.txt` | Spec-compliant LLM context per [llmstxt.org](https://llmstxt.org). |
| **Page Builder Studio**| `/studio` | Admin studio with GitHub/Google SSO, drag-and-drop link manager, themes, API keys. |
| **Scalar API Docs** | `/docs` | Interactive API reference powered by OpenAPI 3.1 (`/api/openapi.json`). |
| **REST API v1** | `/api/v1/profile`, `/api/v1/links`, `/api/v1/theme`, `/api/v1/keys` | Programmatic CRUD operations guarded by API Key Bearer auth. |
| **MCP Server** | `/api/mcp` | Model Context Protocol JSON-RPC 2.0 / SSE endpoint for Claude & Cursor. |
| **NPM CLI** | `packages/cli/bin/zuey.js` | Terminal utility (`zuey login`, `zuey links`, `zuey theme`, `zuey mcp`). |
| **Agent Skill** | `skills/zuey-me/SKILL.md` | Skill documentation for AI coding agents. |

---

## Development & Verification

### Local Development
```bash
bun install
bun run dev
# Server running at http://localhost:4321
```

### Automated Testing & Build
```bash
# Run unit & integration test suite (10 tests)
bun test

# Full Astro typecheck and production build
bun run build
```

### Cloudflare Deployment
Automated via GitHub Actions on push to `main` (`.github/workflows/deploy.yml`).

Manual edge deployment:
```bash
bun run build
wrangler pages deploy dist --project-name=zuey-me --branch=main
```

Cloudflare D1 Migration:
```bash
wrangler d1 execute zuey_me_db --remote --file=./migrations/0001_initial.sql
```
