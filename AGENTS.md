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
3. **Database Access**: Access Cloudflare D1 via typed runtime `(locals as { runtime?: { env?: { DB?: D1DatabaseLike } } })?.runtime?.env?.DB` using `D1DatabaseLike` from `src/db/store.ts`. Always maintain in-memory fallback for local tests.

## TypeScript Standards

- Never use `: any` or `as any`. Use domain types, `unknown` with type guards (`in` / `typeof`), or schemas.
- Never write unchecked inline casts for member access: `(val as { prop: string }).prop` is forbidden.
- Use `import type` for type-only dependencies.

## Database & Migration Invariants

- Never edit existing applied migrations in `migrations/`.
- Add new schema changes as numbered files: `migrations/0002_*.sql`.
- Apply remote migration: `wrangler d1 execute zuey_me_db --remote --file=./migrations/<file>.sql -y`.

## Definition of Done

Before claiming any task complete:
1. `bun test` passes with 0 failures.
2. `bun run build` passes with 0 errors and 0 Astro check warnings.
3. If endpoints changed, verify OpenAPI spec (`src/pages/api/openapi.json.ts`) and Scalar docs (`/docs`) match.
