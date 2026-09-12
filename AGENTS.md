# pi-usage

Read-only provider quota and balance reporting. Keep Fast mode and inference-request changes in `pi-fast-mode`, not here.

## Product contracts

Preserve the existing Codex formatter: `5h 82% ↻1h42m · wk 64% ↻3d6h`, including its remaining-quota meaning and exhaustion behavior. Additional provider data must not turn that footer into a dashboard.

Balances, key caps, quota, and rated spend are distinct. Preserve exact monetary values and currency. OpenRouter account credits require an explicitly bound management credential; inference-key limits alone are not account balance. Do not invent an OpenAI API balance endpoint.

Use Pi's actual runtime authentication, validated provider origins, and account-scoped caches. Revalidate before publishing async results. Credentials and backend error bodies stay out of logs, reports, and persisted settings. Management credential selection belongs only in user configuration.

## Source and checks

`extensions/index.ts` wires the extension; `runtime.ts` owns refresh/cancellation; `usage.ts` retains the Codex parser/formatter; `providers.ts` owns balance semantics and endpoint requests; `config.ts` resolves preferences. Keep adapters explicit rather than importing a provider dashboard or registering `/fast` here.

Run `bun run check` and inspect `git diff --check`. `test:offline` exercises real pure/runtime modules with mocked provider/Pi boundaries. It does not prove live authentication or entitlement. Preserve the existing Codex tests when adding an adapter and report unavailable live checks.
