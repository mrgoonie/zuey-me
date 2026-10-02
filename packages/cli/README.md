# zuey-cli

Command-line interface for **zuey.me**: members read articles, check plans, subscribe and wire up MCP clients; the site owner manages the profile, link cards, layout ordering and themes.

## Installation

```bash
npm install -g zuey-cli
```

Or run via npx:
```bash
npx zuey-cli --help
```

## Authentication

Keys are only ever sent in the `Authorization: Bearer` header.

- **Members:** create a personal key (`zk_…`) at <https://zuey.me/account#keys>, then run `zuey login` and paste it. Input is hidden and the key is verified before it is saved.
- **Admin:** `zuey login --key <ADMIN_API_KEY>` (or set `ZUEY_API_KEY`, which avoids shell history).

The key is stored in the OS config directory with file mode `0600` (directory `0700`):

| OS | Path |
|----|------|
| Linux | `$XDG_CONFIG_HOME/zuey/config.json` (default `~/.config/zuey/config.json`) |
| macOS | `~/Library/Application Support/zuey/config.json` |
| Windows | `%APPDATA%\zuey\config.json` |

`ZUEY_API_KEY`, `ZUEY_API_URL` and `ZUEY_CONFIG_DIR` override the saved values. `zuey logout` deletes the saved key. Older installs that saved `~/.zuey/config.json` keep working until you log in again.

## Member commands

```bash
zuey login                         # paste a zk_ key
zuey whoami                        # account, plans, entitlements, key scopes
zuey articles list [--tag <tag>]   # articles you can read
zuey articles read <slug>          # plain-text article (preview only if the article needs Knowledges)
zuey search "<query>"              # matches article titles, excerpts and tags (body text is not searched)
zuey chat "<message>" [--session <id>]  # Zuey AI, streamed; prints sources and the session id to continue
zuey plans                         # plans and VND prices for 1/3/6/12 months
zuey subscribe <plan> --months 3   # creates an order and prints the VietQR bank-transfer details
zuey keys                          # where to create, rotate and revoke keys (browser only)
zuey mcp config                    # MCP client configuration snippets
```

## MCP

`zuey mcp config` prints ready-to-paste snippets. The remote endpoint `https://zuey.me/mcp` supports OAuth (the client opens a browser for sign-in and consent, no key on disk):

```json
{
  "mcpServers": {
    "zuey": { "type": "http", "url": "https://zuey.me/mcp" }
  }
}
```

For clients without OAuth support, send a personal key as a header:

```json
{
  "mcpServers": {
    "zuey": {
      "type": "http",
      "url": "https://zuey.me/mcp",
      "headers": { "Authorization": "Bearer <YOUR_ZK_KEY>" }
    }
  }
}
```

Disconnect OAuth apps at <https://zuey.me/account#connected-apps>.

## Admin commands

```bash
zuey profile view
zuey profile update --name "Duy Nguyen /zuey/" --intro-en "AI Engineer & Founder"
zuey links list --section products
zuey links add --section products --title "AgentKit" --url "https://agentkit.best" --subtitle "AI engineering framework"
zuey links reorder prod-agentkit prod-dewee prod-tose
zuey theme set ivory
```

`zuey mcp` (no arguments) still runs the stdio bridge to the legacy admin endpoint `/api/mcp`:

```json
{
  "mcpServers": {
    "zuey-me": {
      "command": "npx",
      "args": ["-y", "zuey-cli", "mcp"],
      "env": { "ZUEY_API_KEY": "<ADMIN_API_KEY>" }
    }
  }
}
```

Errors print the HTTP status, error code and the `X-Request-Id`, which you can quote when reporting a problem.
