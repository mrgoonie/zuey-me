# zuey-cli

Command-line & AI Agent interface to manage **Duy Nguyen (/zuey/)** linktree profile, links, layout ordering, themes, and MCP server.

## Installation

```bash
npm install -g zuey-cli
```

Or run via npx:
```bash
npx zuey-cli --help
```

## Quick Start

### 1. Authenticate with API Key
```bash
zuey login --key zuey_secret_token_here
```

### 2. View or Update Profile
```bash
zuey profile view
zuey profile update --name "Duy Nguyen /zuey/" --intro-en "AI Engineer & Founder"
```

### 3. Manage Links
```bash
# List all links or filter by section
zuey links list --section products

# Add a product link
zuey links add --section products --title "AgentKit" --url "https://agentkit.best" --subtitle "AI engineering framework"

# Reorder links
zuey links reorder prod-agentkit prod-dewee prod-tose
```

### 4. Switch Theme
```bash
zuey theme set ivory
zuey theme set dark
```

### 5. Run as Model Context Protocol (MCP) Server
For Claude Desktop or Cursor:
```json
{
  "mcpServers": {
    "zuey-me": {
      "command": "npx",
      "args": ["-y", "zuey-cli", "mcp"],
      "env": {
        "ZUEY_API_KEY": "your_api_key_here"
      }
    }
  }
}
```
