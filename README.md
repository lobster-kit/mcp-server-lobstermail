# @lobsterkit/lobstermail-mcp

MCP server for [LobsterMail](https://lobstermail.ai) — email for AI agents. Create real `@lobstermail.ai` inboxes, receive email in real-time, and send email. No API keys, no human signup, no configuration.

## Quick Start

Add to your MCP config (`.mcp.json`, `claude_desktop_config.json`, `.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "lobstermail": {
      "command": "npx",
      "args": ["-y", "@lobsterkit/lobstermail-mcp@latest"]
    }
  }
}
```

On first use, an account is created automatically and your token is saved to `~/.lobstermail/token`.

## Tools

| Tool | Description |
|------|-------------|
| `create_inbox` | Create a new `@lobstermail.ai` inbox with smart naming |
| `check_inbox` | List recent emails — sender, subject, preview |
| `wait_for_email` | Wait for an incoming email (real-time long-poll) |
| `get_email` | Get full email body in LLM-safe format |
| `send_email` | Send email (Tier 1+ only) |
| `list_inboxes` | List all active inboxes |
| `delete_inbox` | Soft-delete an inbox (7-day grace period) |
| `get_account` | View tier, limits, and usage |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `LOBSTERMAIL_TOKEN` | API token (skips auto-signup and file persistence) |

## Links

- **Website**: [lobstermail.ai](https://lobstermail.ai)
- **SDK**: [@lobsterkit/lobstermail](https://www.npmjs.com/package/@lobsterkit/lobstermail)
- **API docs**: [api.lobstermail.ai/v1/docs/openapi](https://api.lobstermail.ai/v1/docs/openapi)

## License

MIT
