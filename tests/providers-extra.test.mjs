import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchBalance,
  formatBalanceStatus,
  officialIdentity,
  parseBaseten,
  parseFireworksAccounts,
  parseFireworksBilling,
  parseKimi,
  parseOpenCode,
  parseZai,
} from "../extensions/providers.ts";

const signal = () => new AbortController().signal;
const model = (provider, baseUrl) => ({ provider, baseUrl, id: "test" });

test("Kimi reports request windows and booster separately", () => {
  const result = parseKimi({
    usage: { used: "20", limit: "100", resetTime: "2026-09-15T00:00:00Z" },
    limits: [{ name: "5h", window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { used: "10", limit: "100" } }],
    boosterWallet: {
      balance: { type: "BOOSTER", amount: "1000000000", amountLeft: "250000000" },
      monthlyUsed: { priceInCents: 1, currency: "USD" },
    },
  });
  assert.match(formatBalanceStatus(result), /^kimi 90% 5h/);
  assert.equal(result.amounts[0].value, "2.5");
});

test("Kimi does not invent usage for a window whose detail is missing", () => {
  const result = parseKimi({
    usage: { used: "50", limit: "100" },
    limits: [{ name: "5h", window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" } }],
  });
  assert.equal(formatBalanceStatus(result), "kimi 50% wk");
  assert.doesNotMatch(formatBalanceStatus(result), /5h/);
});

test("OpenCode keeps returned windows as remaining percentages", () => {
  const result = parseOpenCode({ usage: { rolling: { status: "ok", percent: 10 }, weekly: { status: "rate-limited", percent: 100 } } });
  assert.match(result.status, /90% rolling/);
  assert.match(result.status, /0% weekly/);
});

test("Z.AI reports 5h, weekly, and monthly MCP quota without mixing units", () => {
  const result = parseZai("zai", {
    code: 0,
    data: {
      level: "pro",
      limits: [
        { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 30 },
        { type: "CREDIT_LIMIT", unit: 6, percentage: 20 },
        { type: "TIME_LIMIT", currentValue: 2, usage: 10 },
      ],
    },
  });
  assert.equal(result.status, "zai 70% 5h · 80% wk");
  assert.match(result.lines.join("\n"), /MCP monthly: 8\/10 left/);
});

test("Z.AI does not invent five-hour duration when metadata is missing", () => {
  const result = parseZai("zai", {
    code: 0,
    data: { limits: [{ type: "CREDIT_LIMIT", unit: 3, percentage: 30 }] },
  });
  assert.equal(result.status, "zai 70% rolling");
  assert.doesNotMatch(result.status, /5h/);
});

test("Baseten reports net trailing-30-day spend, not balance", () => {
  const result = parseBaseten({ model_apis_usage: { total: "12.50", credits_used: "2.25", subtotal: "10.25" } });
  assert.equal(result.kind, "spend");
  assert.equal(result.amounts[0].value, "10.25");
  assert.match(result.status, /net/);
});

test("Fireworks account and nano-unit money parsing are exact", () => {
  assert.deepEqual(parseFireworksAccounts({ accounts: [{ name: "accounts/acct-1" }] }), ["acct-1"]);
  const result = parseFireworksBilling({
    lineItems: [
      { series: "SERVERLESS", totalCost: { currencyCode: "USD", units: "1", nanos: 250000000 } },
      { series: "TRAINING", totalCost: { currencyCode: "USD", units: "2" } },
    ],
  });
  assert.equal(result.amounts[0].value, "3.25");
  assert.equal(result.kind, "spend");
});

test("new adapters reject proxy/cross-region inference credentials", () => {
  assert.throws(() => officialIdentity(model("kimi-coding", "https://proxy.example"), { ok: true, apiKey: "x" }));
  assert.throws(() => officialIdentity(model("zai", "https://open.bigmodel.cn"), { ok: true, apiKey: "x" }));
  assert.doesNotThrow(() => officialIdentity(
    model("baseten", "https://inference.baseten.co"),
    { ok: true, apiKey: "x", baseUrl: "https://api.baseten.co" },
  ));
});

test("Kimi endpoint is fixed and read-only", async () => {
  const identity = officialIdentity(model("kimi-coding", "https://api.kimi.com/coding"), { ok: true, apiKey: "key" });
  let request;
  await fetchBalance(identity, signal(), async (url, init) => {
    request = [String(url), init];
    return Response.json({ usage: { used: "1", limit: "2" } });
  });
  assert.equal(request[0], "https://api.kimi.com/coding/v1/usages");
  assert.equal(request[1].method, "GET");
  assert.equal(request[1].redirect, "error");
});

test("Z.AI monitor endpoint receives the raw token form required by the monitor API", async () => {
  const identity = officialIdentity(
    model("zai", "https://api.z.ai/api/paas/v4"),
    { ok: true, headers: { Authorization: "Bearer zai-token" } },
  );
  let authorization;
  await fetchBalance(identity, signal(), async (_url, init) => {
    authorization = init.headers.Authorization;
    return Response.json({ code: 0, data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 50 }] } });
  });
  assert.equal(authorization, "zai-token");
});
