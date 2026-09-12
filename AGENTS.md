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

## Product boundaries

Preserve the current compact Codex footer: remaining five-hour and weekly quota with reset countdowns, for example `5h 82% ↻1h42m · wk 64% ↻3d6h`. Broader provider support must not replace that display with a dashboard or reinterpret remaining quota as spend.

Fast mode remains in `pi-fast-mode`. Do not register `/fast`, set service tiers, redeem subscription resets, or take over provider request handling here. Additional providers, if implemented, report their actual balance, allowance, or spend semantics with active-account isolation; they do not imply support for an OpenAI API balance endpoint.

## Testing

```bash
bun run check
```

Run `git diff --check` before committing. Keep tests deterministic; use injected fetchers or temporary config directories rather than live credentials. Preserve Codex formatter regressions when adding a provider.

## Integration discipline

Merge only a coherent, independently usable change with a tested contract. Before merging, run `bun run check` and inspect the complete diff. Keep endpoint compatibility behavior and credential-handling safeguards covered by tests when changing them.
