---
name: zuey-me
description: "Use zuey.me (Duy Nguyen's site) via REST API, CLI, or MCP: members read articles, check plans, subscribe and connect MCP clients over OAuth; admins update profile, link cards, layout order and themes."
user-invocable: true
keywords: [zuey, linktree, profile, links, theme, api, mcp, oauth, membership, duy-nguyen]
metadata:
  author: zuey
  version: "1.1.0"
---

# Zuey.me Management Skill

Use this skill whenever you need to programmatically inspect or modify **Duy Nguyen (/zuey/)** personal link-in-bio website hosted at `https://zuey.me`.

## Capabilities

1. **Profile**: Read and update name, handle, avatar, and bios in English & Tiếng Việt.
2. **Links**: Add, edit, remove, and reorder links under `blogs`, `companies`, and `products`.
3. **Themes**: Switch between visual presets (`ivory`, `dark`, `minimal`, `glass`) and apply custom CSS tokens.
4. **Analytics**: Inspect link click counts and engagement.
5. **AI Workflows**: Manage drafts/publishing of `/workflows`; to extract workflows from local sessions see [`workflows/SKILL.md`](workflows/SKILL.md).

---

## Authentication

All mutation operations require an API Key.
Pass the key in the HTTP request headers:

```http
Authorization: Bearer <ZUEY_API_KEY>
```
Or:
```http
X-API-Key: <ZUEY_API_KEY>
```

---

## Available Tools & Endpoints

### 1. Inspect Profile & Links (Public)

```bash
# Get profile info
curl -s https://zuey.me/api/v1/profile | jq .

# Get all links
curl -s https://zuey.me/api/v1/links | jq .

# Get clean Markdown
curl -s -H "Accept: text/markdown" https://zuey.me/ | head -n 30
```

### 2. Update Profile

```bash
curl -X PUT https://zuey.me/api/v1/profile \
  -H "Authorization: Bearer $ZUEY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Duy Nguyen /zuey/",
    "intro_en": "\"F*ck Around & Find Out\" Specialist 😎 CTO/Co-founder@TOPGROUP, DIGITOP, XINCHAO Live Music, AgentKit & NextLevelBuilder. Founder of \"Build in Public VN\" Community.",
    "intro_vi": "Chuyên gia \"F*ck Around & Find Out\" 😎 CTO/Đồng sáng lập@TOPGROUP, DIGITOP, XINCHAO Live Music, AgentKit & NextLevelBuilder. Nhà sáng lập cộng đồng \"Build in Public VN\"."
  }'
```

### 3. Add a New Link Card

```bash
curl -X POST https://zuey.me/api/v1/links \
  -H "Authorization: Bearer $ZUEY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "section": "products",
    "title_en": "AgentKit.best",
    "title_vi": "AgentKit.best",
    "subtitle_en": "The complete AI engineering framework to build autonomous agents",
    "subtitle_vi": "Khung kỹ nghệ AI hoàn chỉnh để xây dựng và vận hành AI agent",
    "url": "https://agentkit.best",
    "icon": "agentkit"
  }'
```

### 4. Reorder Links

Set the visual sequence of links across the profile by passing an array of link IDs:

```bash
curl -X POST https://zuey.me/api/v1/links/reorder \
  -H "Authorization: Bearer $ZUEY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "order": ["prod-agentkit", "prod-dewee", "company-topgroup", "company-xinchao"]
  }'
```

### 5. Switch Visual Theme

Presets: `ivory` (Linktree classic), `dark` (deep aubergine), `minimal` (monochrome), `glass` (frosted blur).

```bash
curl -X PUT https://zuey.me/api/v1/theme \
  -H "Authorization: Bearer $ZUEY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "theme": "ivory"
  }'
```

---

## Member access (personal keys)

Members create personal keys (`zk_…`) at `https://zuey.me/account#keys` (browser session only; keys can never create keys).
Keys carry scopes (`articles:read`, `chat:write`, `account:read`, `account:write`, `billing:read`, `checkout:write`) and never grant admin.
Always send them in a header, never in a URL:

```bash
curl -s -H "Authorization: Bearer $ZUEY_API_KEY" https://zuey.me/api/v1/me | jq .
curl -s -H "Authorization: Bearer $ZUEY_API_KEY" https://zuey.me/api/v1/articles | jq '.data[].slug'
curl -s https://zuey.me/api/v1/plans | jq .
```

Every API response carries `X-Request-Id`; JSON errors also include `error.request_id`.

---

## Model Context Protocol (MCP) Integration

### Remote MCP: `https://zuey.me/mcp` (recommended)

- Transport: MCP Streamable HTTP, JSON-RPC 2.0 over POST, stateless. Protocol `2026-07-28` (per-request `_meta`) plus legacy `2025-11-25`, `2025-06-18`, `2025-03-26` (`initialize`).
- Auth: OAuth 2.1 (PKCE S256, audience `https://zuey.me/mcp`). Clients discover it from the `401` `WWW-Authenticate` header and `https://zuey.me/.well-known/oauth-protected-resource/mcp`. The member signs in and approves scopes on a consent screen; connected apps can be disconnected at `/account#connected-apps`.
- Also accepts `Authorization: Bearer zk_…` personal keys and admin keys.
- `tools/list` is filtered per caller: everyone sees public read tools (profile, links, articles, plans); members additionally see account (`me_get`, `me_keys_list` — read-only key metadata), billing and checkout tools allowed by their scopes; admin tools appear only for admins (OAuth `admin` scope + allowlisted email, or an admin key).

```json
{ "mcpServers": { "zuey": { "type": "http", "url": "https://zuey.me/mcp" } } }
```

### Legacy admin endpoint: `https://zuey.me/api/mcp`

Plain JSON-RPC (`initialize`, `tools/list`, `tools/call`) for existing admin integrations, e.g. `get_profile`, `update_profile`, `list_links`, `create_link`, `update_link`, `delete_link`, `reorder_links`, `get_theme`, `set_theme`.

---

## Local CLI Alternative

If you have node installed:
```bash
npm install -g zuey-cli

# Members
zuey login                     # paste a zk_ key; input hidden, saved in the OS config dir with 0600 permissions
zuey whoami
zuey articles list
zuey articles read <slug>
zuey search "<query>"
zuey chat "<message>"
zuey plans
zuey subscribe <plan> --months 3   # prints VietQR bank-transfer details
zuey mcp config                # client config snippets

# Admin
zuey login --key <ADMIN_API_KEY>
zuey profile view
zuey links list --section products
zuey theme set ivory
```

`ZUEY_API_KEY` / `ZUEY_API_URL` environment variables override the saved config.
