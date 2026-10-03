# Agent Guidelines (zuey-me)

Process memory for AI agents collaborating on `zuey-me`.

## Mandatory Tooling & Commands

- Package manager: `bun` (fallback: `npm`).
- Run single test file: `bun test tests/site.test.ts`
- Run full test suite: `bun test`
- Build & typecheck: `bun run build` (runs `astro check && astro build`)
- Local dev server: `bun run dev` (port 4321)

## Edge Runtime Constraints (Cloudflare Pages)

1. **Web Standards Only**: Use `fetch`, `crypto.subtle`, `Response`, `Request`, `URL`. Never use Node CJS-only builtins (`fs`, `child_process`, `crypto`) in files bundled for the edge (`src/pages/**`, `src/components/**`).
2. **CJS Imports**: Libraries using CommonJS (like `qrcode`) must be loaded dynamically inside client-only hooks (`useEffect`) or kept out of `ssr.noExternal`.
3. **Database Access**: Access Cloudflare D1 natively via `Astro.locals.runtime?.env?.DB` or `locals.runtime?.env?.DB` (typed via `src/env.d.ts` without any casting). Profile/links keep their in-memory fallback. Membership features (reads, workflows, booking, articles/surveys) intentionally have no in-memory fallback: they return an honest `503` without `DB`, and tests run them against real SQLite via `tests/helpers/d1.ts` (bun:sqlite + all migrations) so unique indexes are exercised.
4. **Heavy client-only libraries** (`mermaid`, `chart.js`): import dynamically inside `useEffect` behind `if (import.meta.env.SSR) return;` so they stay out of the SSR worker bundle.
5. **Local dev bindings**: `astro.config.mjs` uses `platformProxy.remoteBindings: false`, so the `AI` binding is not available locally; features depending on it must report `503` rather than crash.

## TypeScript Standards

- Never use `: any` or `as any`. Use domain types, `unknown` with type guards (`in` / `typeof`), or schemas.
- Never write unchecked inline casts for member access: `(val as { prop: string }).prop` is forbidden.
- Use `import type` for type-only dependencies.

## Feature Registration

- New MCP tools: add a module to `src/lib/mcp/registry.ts`. New REST docs: add a fragment to `src/lib/openapi/registry.ts` (merged into `/api/openapi.json` and Scalar `/docs`).
- Admin-only endpoints and tools must use `authenticateAdmin` (`src/lib/auth.ts`); read-only API keys must never mutate.
- Scripted `POST`/`PUT` calls to the API must send `Content-Type: application/json`; Astro's origin check rejects body-less or form requests with `403` before auth runs.
- Errors use `src/lib/http.ts` (`AppError`, `jsonError`) with the `{ success: false, error: { code, message } }` envelope.
- Secret names live in `.env.example`, README and `docs/env-setup.vi.md`; never values.

## Database & Migration Invariants

- Never edit existing applied migrations in `migrations/`.
- Add new schema changes as numbered files: `migrations/0002_*.sql`.
- Apply remote migration: `wrangler d1 execute zuey_me_db --remote --file=./migrations/<file>.sql -y`.
- Before any remote schema or data change, record a restore point with `wrangler d1 time-travel info zuey_me_db`; `wrangler d1 export` fails because the DB has FTS5 tables.
- Every remote wrangler command (deploy, secrets, D1) must run with the DNS-owning account's `CLOUDFLARE_ACCOUNT_ID`/`CLOUDFLARE_API_TOKEN` from `.env` exported; never fall back to a cached `wrangler login`, which may point at a different account.
- If `wrangler pages` hits the wrong account despite exported credentials, delete the stale `node_modules/.cache/wrangler/pages.json`.
- Inside this repo, `wrangler d1 <cmd> zuey_me_db` resolves the database by the `database_id` in `wrangler.toml` (production), not by name. To act on a D1 in any other account, run wrangler from a directory without `wrangler.toml`.

## Definition of Done

Before claiming any task complete:
1. `bun test` passes with 0 failures.
2. `bun run build` passes with 0 errors and 0 Astro check warnings.
3. If endpoints changed, verify OpenAPI spec (`src/pages/api/openapi.json.ts`) and Scalar docs (`/docs`) match.
