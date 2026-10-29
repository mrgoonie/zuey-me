## Review: PR #104, admin unlink for wrongly linked chat ids (closes #89)

**Verdict: APPROVE.** There are no blocking findings. The low-severity items below can go in this PR or a follow-up.

Reviewed commit `03999ac` in an isolated worktree, diffed against `origin/main`.

### Gates
- `bun install --frozen-lockfile`: ok.
- `bun test`: 827 pass, 0 fail.
- `bun run build`: astro check found 0 errors, 0 warnings and 63 hints (none new). The build completed.

### Live local check
Ran `astro dev` on port 4439 with local D1. All 21 migrations were applied. I seeded a member with two `channel_identities` rows and local admin and read-only `api_keys`.

| Request | Result |
| --- | --- |
| Anonymous `GET` | 401 `unauthorized` |
| Read-only key `GET` / `DELETE` | 403 `forbidden`, link kept |
| Read-only key, MCP `channel_identity_unlink` | 403 / JSON-RPC -32001 |
| Admin `GET` | 200, with the holder `{id, email, name}`, `source` and `linked_at` |
| Admin `GET` with provider `sms` | 400 `unsupported_channel` |
| Admin `GET` with id `a b` or `a%2Fb` | 400 `invalid_field` |
| Admin `GET` for an unlinked id | 404 `not_found` |
| Admin `DELETE` with no body and no Content-Type, or with `text/plain` | 403 from Astro's origin check ("Cross-site DELETE form submissions are forbidden") |
| Admin `DELETE` with `application/json` and `{"reason":…}` | 200 |
| Same `DELETE` again | 404 |
| Admin `DELETE` with `application/json` and an empty body | Accepted by the body parser |
| MCP `channel_identity_unlink` with an admin key | 200 |

After the unlinks, `user_activity` holds `channel.unlinked` with `{provider, external_id, by:"admin", admin, reason}`, and no rows are left in `channel_identities`. The server was stopped afterwards by killing only its own process tree.

### What I checked and found correct
- **Auth.** Access goes through `requireCan(principal, 'admin')` inside `memberRoute`, not `authenticateAdmin`. This matches every other `/api/v1/admin/*` route and the members MCP tools, because `policy.ts` is the central access decision. Within that policy:
  - read-only Studio keys resolve to `anonymous`/`read_api_key`, so they get 403;
  - personal `zk_` keys are never admin;
  - MCP on the OAuth `/mcp` endpoint is gated by `TOOL_ACCESS` = `ADMIN`.

  There is no IDOR risk: the target comes only from `{provider, externalId}`, and only admins reach it.
- **Atomicity.** The `DELETE` is a single statement guarded by `user_id = <holder just read>`, so a relink that races in between is never removed blindly. If 0 rows change, the endpoint returns 404. `logActivity` swallows its own errors, so a failed audit insert cannot fail an unlink that already committed.
- **dewee push.** It goes through `deferChannelAccessPush(invalidateSenders(...))`. That call uses `waitUntil` when available, never rejects, has a 2 s timeout, and logs only the status or error name, never the token.
- **Nonces.** `channel_link_nonces` is left untouched, which is correct: used tokens stay non-replayable after an unlink.
- **Platform.** The `DELETE` returns 503 `database_unavailable` without `DB` (tested). It uses only web-standard APIs. There is no `any` and no unchecked member-access casts in `src/`.
- **OpenAPI.** The fragment matches the code: params, the optional body, the 400/401/403/404/503 codes and the `AdminChannelIdentity` schema. The `DELETE` description and `docs/env-setup.vi.md` both tell callers to send `Content-Type: application/json`.

### Findings

**Low**

1. **Percent-encoded `:`, `@` and `+` in `externalId` are rejected.**
   - Where: `src/pages/api/v1/admin/channel-identities/[provider]/[externalId].ts:11,31`; `src/lib/channel-access/admin.ts:33`.
   - What happens: Astro leaves reserved characters encoded in route params. So `GET …/telegram/777%3A002` returns 400 `invalid_field`, while a literal `…/777:002` returns 200.
   - Why it matters: `SENDER_ID_RE` explicitly allows `: @ +`, and clients and OpenAPI generators usually build paths with `encodeURIComponent`. Telegram ids are numeric, so this has no effect today, but it will bite once a second provider exists.
   - Suggested fix: run a safe `decodeURIComponent` inside a try/catch (catching `URIError` and returning 400) on `params.externalId` before `parseChannelRef`.
2. **The affected member can read the admin's audit detail.**
   - Where: `src/lib/channel-access/admin.ts:101-103`.
   - What happens: `/api/v1/me/activity` returns `detail` verbatim to the member. For this action that includes the admin label (an admin email when the admin used a session), the free-text `reason`, and the admin's `user_agent` recorded as a row in the member's own log.
   - Precedent: `billing.attention_resolved` already does the same with `admin` and `note`, and #89 asks for the admin as actor, so this is consistent with existing behaviour.
   - Suggested fix: either say in the tool, OpenAPI and runbook text that `reason` is visible to the affected member, so admins do not paste the real owner's details into it, or omit `request` so the member's activity log does not show the admin's device.

**Info**

3. **An admin key cannot be traced to a specific key.** With an admin API key the actor is recorded as `admin_api_key` (`adminLabel` returns `p.email ?? p.via`), not the key's id or name. This is a pre-existing pattern and is acceptable, but the audit trail cannot say which admin key was used.
4. **Unused link tokens stay valid after an unlink.** Link tokens still unredeemed for that sender keep working until they expire (at most 24 h). Only used nonces are stored, so they cannot be revoked. This matters only in the "linked on someone else's device" case, and the runbook flow (the real owner relinks at once) covers it.
5. **One test does not exercise the real link flow.** The "frees the sender id so the real owner can link it" test relinks with a direct `INSERT`, not `redeemLinkToken`. It proves the row is gone, but not that the `/connect` flow succeeds afterwards. This is optional to change.
