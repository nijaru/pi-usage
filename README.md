# pi-usage

Show remaining OpenAI Codex quota in Pi's footer:

```text
5h 82% ↻1h42m · wk 64% ↻3d6h
```

The status appears for the active `openai-codex` provider. Usage refreshes on startup, after completed turns, and once per minute by default. When reset times are available, `↻` shows the time until each window resets. A temporary refresh failure leaves the last successful value visible.

## Install

```bash
pi install git:github.com/nijaru/pi-usage
```

Restart Pi after installing. The extension uses Pi's existing Codex OAuth session and does not modify Codex requests.

## Usage

Run `/usage` to force a refresh and report the current value.

## Configuration

Project config overrides global config:

- project: `.pi/extensions/pi-usage.json`
- global: `~/.pi/agent/extensions/pi-usage.json`

```json
{
  "enabled": true,
  "pollIntervalMs": 60000,
  "requestTimeoutMs": 10000,
  "usageUrl": "https://chatgpt.com/backend-api/wham/usage"
}
```

The usage endpoint is an undocumented ChatGPT/Codex API and may change. Custom endpoints must use HTTPS; a 404 or 405 also tries the older `/codex/usage` route. Refresh failures never interrupt an agent turn. The existing OAuth access token and account ID are sent only to the configured endpoint, never logged or persisted.

## Development

```bash
bun install
bun run check
```

## License

MIT
