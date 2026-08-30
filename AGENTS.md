# pi-usage

Show OpenAI Codex subscription quota in Pi's footer.

## Stack

TypeScript, Bun, and the Pi extension API (`@earendil-works/pi-coding-agent`).
Pi loads the TypeScript entrypoint directly; there is no build step.

## Architecture

- `extensions/index.ts` owns Pi lifecycle hooks, status updates, refresh scheduling, and `/usage`.
- `extensions/usage.ts` owns Codex token parsing, response parsing, endpoint requests, and display formatting.
- `extensions/config.ts` owns project/global configuration resolution and bounds.
- `extensions/constants.ts` owns shared names and defaults.
- `tests/` covers parsing, fetching, configuration, and lifecycle/account-switch behavior.

The extension reads Pi's existing Codex OAuth session and never changes Codex request handling. Keep account identifiers and access tokens out of logs and persisted state.

## Testing

```bash
bun run check
```

Run `git diff --check` before committing. Keep tests deterministic; use injected fetchers or temporary config directories rather than live credentials.

## Integration discipline

Merge only a coherent, independently usable change with a tested contract. Before merging, run `bun run check` and inspect the complete diff. Keep endpoint compatibility behavior and credential-handling safeguards covered by tests when changing them.
