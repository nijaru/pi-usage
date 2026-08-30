# pi-usage

Show OpenAI Codex subscription quota in Pi's normal footer.

The extension displays the remaining percentage for the available five-hour and weekly windows, for example:

```text
5h 82% · wk 64%
```

It is visible only while the active provider is `openai-codex`. Usage is fetched from the authenticated Codex account endpoint on startup, after a completed turn, and periodically (once per minute by default). The last successful value remains visible if a refresh fails.

## Install

```bash
pi install git:github.com/nijaru/pi-usage
```

Restart Pi after installing. The extension uses Pi's existing OpenAI Codex OAuth session; it does not ask for or store another token and does not modify Codex requests.

## Commands

- `/usage` — force a refresh and report the current value.

## Configuration

Optional global config: `~/.pi/agent/extensions/pi-usage.json`

Optional project config: `.pi/extensions/pi-usage.json`

Project values override global values:

```json
{
  "enabled": true,
  "pollIntervalMs": 60000,
  "requestTimeoutMs": 10000,
  "usageUrl": "https://chatgpt.com/backend-api/wham/usage"
}
```

The endpoint is an undocumented ChatGPT/Codex backend API and may change. Custom endpoints must use HTTPS. Pi-usage falls back to the older `/codex/usage` route when the current route returns 404 or 405. A failed refresh is soft: it never interrupts an agent turn.

## Development

```bash
bun install
bun run check
```

## Security

Pi extensions run with the permissions of the local user. This extension sends the existing Codex OAuth access token and account ID only to the configured usage endpoint, never logs them, and does not persist quota data.

## License

MIT
