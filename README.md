# pi-usage

Show the active provider's quota, balance, allowance, or spend in Pi without opening its billing website. Codex keeps the existing compact footer for accounts that expose five-hour and weekly windows:

```text
5h 82% ↻1h42m · wk 64% ↻3d6h
```

Window labels come from the reported duration, not from `primary_window` / `secondary_window` position. A weekly-only account renders only `wk`; other reported durations use their duration (for example `1h`), and a window whose duration is unavailable falls back to the generic `quota` label rather than being guessed as five-hour.

## Install and use

```sh
pi install git:github.com/nijaru/pi-usage
```

Reload Pi when no child jobs are running. Existing installations can use Pi's targeted package update command.

```text
/usage                 Refresh the active provider
/usage deepseek        Query another configured provider
/usage openrouter      Show key usage and configured account credits
/usage all             Query supported configured providers, two at a time
```

Only the active provider is polled automatically. Other-provider reports are explicit and never replace the active footer. Headless sessions do not poll. The extension adds no model tools and does not change inference requests. `/fast`, service tiers, and Fast-mode pricing remain entirely in `pi-fast-mode`.

## Reported data

| Pi provider | Report | Verification |
| --- | --- | --- |
| `openai-codex` | Remaining quota windows and reset countdowns; known five-hour/weekly labels are duration-derived and weekly-only plans are supported. | Existing implementation/tests plus sanitized upstream response-shape checks. |
| `deepseek` | Exact available USD/CNY balances, with granted/top-up breakdowns. | Fixture-verified. |
| `openrouter` | Per-key cap and spend; account credit when a management credential is explicitly bound below. | Fixture-verified. |
| `moonshotai`, `moonshotai-cn` | Regional available, cash, and voucher balances. | Fixture-verified. |
| `minimax`, `minimax-cn` | Pay-as-you-go balance for `sk-api-` credentials; explicit remaining percentages for Token Plan credentials. | Fixture-verified. |
| `vercel-ai-gateway` | Team credit balance and reported lifetime spend. | Fixture-verified. |
| `kimi-coding` | Subscription request windows plus Booster wallet balance when returned. | Fixture-verified. |
| `opencode-go` | Rolling, weekly, and monthly OpenCode Go usage windows. | Fixture-verified. |
| `zai`, `zai-coding-cn` | Coding-plan rolling/weekly quotas and MCP monthly allowance when returned. | Fixture-verified. |
| `baseten` | Trailing-30-day Model APIs gross usage, credits used, and net spend. This is spend, not remaining balance. | Fixture-verified. |
| `fireworks` | Trailing-30-day rated spend from the selected billing account. This is spend, not remaining balance. | Fixture-verified; a single visible account is currently required. |

No authenticated provider calls are claimed by the fixture status above. Run live smoke checks with already-authorized accounts before treating a provider as live-verified.

Balances, key caps, quota, allowances, and spend are not interchangeable. Currencies remain separate. A missing field, failed request, or unsupported provider is not shown as zero. Decimal strings remain exact; OpenRouter credit subtraction and provider-specific fixed-point money use integer arithmetic where needed. Old MiniMax payloads without unambiguous remaining-percentage fields are reported as unavailable rather than guessing what a usage count means.

### Deliberately unsupported reporting surfaces

These are not treated as ordinary inference-key adapters because their reporting authorization differs from the credential Pi sends for inference:

| Provider/surface | Current status |
| --- | --- |
| Direct OpenAI API organization costs | OpenAI exposes organization usage/cost APIs, but they require an organization admin API key. No prepaid balance endpoint is assumed. Add only through an explicit reporting-only admin credential, not the inference key. |
| GitHub Copilot allowance | The reviewed endpoint requires the original GitHub OAuth credential rather than the short-lived inference token. A safe account-matching OAuth resolver is required first. |
| xAI consumer subscription quota | The consumer reporting flow uses xAI/Grok OAuth-specific endpoints and headers and should remain explicit-query only. It is not safe to infer this capability from `XAI_API_KEY`. |

Unsupported credential surfaces fail closed. The extension does not scrape browser cookies, mint broader credentials, or turn a configured budget into a pretend balance.

## Configuration

Normal preferences retain the existing locations, with a trusted project overriding the user file:

- `~/.pi/agent/extensions/pi-usage.json`
- `.pi/extensions/pi-usage.json`

```json
{
  "enabled": true,
  "pollIntervalMs": 60000,
  "requestTimeoutMs": 10000
}
```

The Codex `usageUrl` preference remains readable, but the runtime requires the official ChatGPT origin. Custom inference proxies are not permission to forward their credentials to an unrelated official billing endpoint.

### OpenRouter account credit

`GET /api/v1/key` reports a **per-key cap**, not your account balance. Account credit comes from `GET /api/v1/credits`, which requires a **management key**. With no management credential, key reporting still works and explains the missing account-credit capability.

Use environment-variable names in the **global user file only**:

```json
{
  "openrouterCredits": {
    "managementKeyEnv": "OPENROUTER_MANAGEMENT_KEY",
    "inferenceKeyEnv": "OPENROUTER_API_KEY"
  }
}
```

Supply both through your existing secure credential mechanism. Do not put the values in this JSON file or in Git. The binding asserts that both keys belong to the intended account; the runtime checks that the bound inference key exactly matches Pi's selected credential before using the management key. Rotating or switching to another inference key requires updating that binding. Project files cannot select a management credential. The management key is used only for the read-only credits request, never for inference or key administration.

### Fireworks accounts

The billing API can expose multiple Fireworks accounts. The current owned adapter queries automatically only when exactly one account is visible; multiple accounts report that account selection is required rather than silently choosing one. Adding persisted account selection belongs in `pi-usage` configuration/UI, not in inference settings.

## Reliability and privacy

Credentials come from Pi's current model registry. The configured model origin and resolved-auth origin must match a reviewed official endpoint; redirects are refused. Reporting responses are bounded to 1 MiB. Requests are cancelled on model/session changes, and credentials are checked again before publishing a response. Cache identities are credential-scoped; secrets are not stored in the report or written to disk.

A temporary failure may retain the last value with a `stale` label. An account change clears the old account's value. `/usage` shows report details and their observation time. Provider reports are snapshots, not invoices, and an inference key's spend is not necessarily this Pi session's spend.

## Development

```sh
bun install --frozen-lockfile
bun run check
# Network-free core/lifecycle/provider fixtures, also runnable without Bun/Pi installed:
node --experimental-strip-types --test tests/*.test.mjs
```

Node 22.19+ is required for native TypeScript stripping in the offline fixtures. `bun run check` also loads the production entrypoint, checks configuration/Codex regressions, lints, and typechecks against the real Pi dependency. Offline mocked lifecycle tests do not prove live provider compatibility; verify authenticated reports separately without printing credentials.

The provider expansion was cross-checked against first-party API contracts where available and the current `narumiruna/pi-extensions` usage adapters at tree `1c1ac2c0f371b38957719dc197afb54bc13bda43` (MIT). That package's `/fast` behavior, request mutations, reset redemption, and formatter were not imported.

MIT licensed.
