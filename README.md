# pi-usage

Show the active provider's quota or balance in Pi without opening its billing website. Codex keeps the existing compact footer:

```text
5h 82% ↻1h42m · wk 64% ↻3d6h
```

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

| Pi provider | Report |
| --- | --- |
| `openai-codex` | Remaining five-hour/weekly quota and reset countdowns; existing formatting is preserved. |
| `deepseek` | Exact available USD/CNY balances, with granted/top-up breakdowns. |
| `openrouter` | Per-key cap and spend; account credit when a management credential is explicitly bound below. |
| `moonshotai`, `moonshotai-cn` | Regional available, cash, and voucher balances. |
| `minimax`, `minimax-cn` | Pay-as-you-go balance for `sk-api-` credentials; explicit remaining percentages for Token Plan credentials. |
| `vercel-ai-gateway` | Team credit balance and reported lifetime spend. |

Balances, key caps, quota, and spend are not interchangeable. Currencies remain separate. A missing field, failed request, or unsupported provider is not shown as zero. Decimal strings remain exact; OpenRouter credit subtraction uses scaled integer arithmetic. Old MiniMax payloads without unambiguous remaining-percentage fields are reported as unavailable rather than guessing what a usage count means.

This is not an OpenAI API account-balance integration. Other providers whose reviewed APIs expose only rated spend or require different credentials are not automatically treated as balance sources.

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

The Codex `usageUrl` preference remains readable, but the runtime now requires the official ChatGPT origin. Custom inference proxies are not permission to forward their credentials to an unrelated official billing endpoint.

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

## Reliability and privacy

Credentials come from Pi's current model registry. The configured model origin and resolved-auth origin must match a reviewed official endpoint; redirects are refused. New balance responses are bounded to 1 MiB. Requests are cancelled on model/session changes, and credentials are checked again before publishing a response. Cache identities are credential-scoped; secrets are not stored in the report or written to disk.

A temporary failure may retain the last value with a `stale` label. An account change clears the old account's value. `/usage` shows report details and their observation time. Provider reports are snapshots, not invoices, and an inference key's spend is not necessarily this Pi session's spend.

## Development

```sh
bun install --frozen-lockfile
bun run check
# Network-free core/lifecycle fixtures, also runnable without Bun/Pi installed:
node --experimental-strip-types --test tests/*.test.mjs
```

Node 22.6+ is required for native TypeScript stripping in the offline fixtures. `bun run check` also loads the production entrypoint, checks configuration/Codex regressions, lints, and typechecks against the real Pi dependency. Offline mocked lifecycle tests do not prove live provider compatibility; verify authenticated reports separately without printing credentials.

Sources: [DeepSeek balance](https://api-docs.deepseek.com/api/get-user-balance/), [OpenRouter key limits](https://openrouter.ai/docs/api_reference/limits), [OpenRouter account credits](https://openrouter.ai/docs/api/api-reference/credits/get-remaining-credits), [Moonshot balance](https://platform.kimi.ai/docs/api/balance), [Vercel Gateway API](https://vercel.com/docs/ai-gateway/sdks-and-apis/rest-api). Regional/MiniMax contracts and provider-account isolation were cross-checked against [narumitw's provider reference](https://github.com/narumiruna/pi-extensions/blob/07ac1d7446deb28472030770a537590427da2dae/packages/pi-usage/docs/providers.md). That package's request-tier controls and formatter were not imported.

MIT licensed.
