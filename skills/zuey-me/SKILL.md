---
name: zuey-me
description: "Programmatically inspect, update profile details, manage link cards, reorder layout sections, and switch themes for Duy Nguyen's personal site (zuey.me) via REST API, CLI, or MCP."
user-invocable: true
keywords: [zuey, linktree, profile, links, theme, api, mcp, duy-nguyen]
metadata:
  author: zuey
  version: "1.0.0"
---

# Zuey.me Management Skill

Use this skill whenever you need to programmatically inspect or modify **Duy Nguyen (/zuey/)** personal link-in-bio website hosted at `https://zuey.me`.

## Capabilities

1. **Profile**: Read and update name, handle, avatar, and bios in English & Tiếng Việt.
2. **Links**: Add, edit, remove, and reorder links under `blogs`, `companies`, and `products`.
3. **Themes**: Switch between visual presets (`ivory`, `dark`, `minimal`, `glass`) and apply custom CSS tokens.
4. **Analytics**: Inspect link click counts and engagement.

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

## Model Context Protocol (MCP) Integration

You can connect directly to the Zuey.me MCP endpoint via HTTP SSE/JSON-RPC:
- **Endpoint**: `https://zuey.me/api/mcp`
- **Supported Methods**:
  - `tools/list`
  - `tools/call` with tool names:
    - `get_profile`
    - `update_profile`
    - `list_links`
    - `create_link`
    - `update_link`
    - `delete_link`
    - `reorder_links`
    - `get_theme`
    - `set_theme`

---

## Local CLI Alternative

If you have node installed:
```bash
npm install -g zuey-cli
zuey login --key <API_KEY>
zuey profile view
zuey links list --section products
zuey theme set ivory
```
