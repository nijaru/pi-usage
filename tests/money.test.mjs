import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney } from "../extensions/money.ts";
import { formatBalanceReport, formatBalanceStatus, parseBaseten, parseFireworksBilling, parseKimi } from "../extensions/providers.ts";

test("money uses distinct symbols and falls back to the currency code", () => {
  for (const [currency, expected] of [["USD", "$0.77"], ["EUR", "€0.77"], ["GBP", "£0.77"], ["CNY", "CN¥0.77"], ["CAD", "CA$0.77"], ["XYZ", "XYZ 0.77"]]) {
    assert.equal(formatMoney(currency, "0.77", true), expected);
  }
  assert.equal(formatMoney("JPY", "12.5", true), "¥13");
  assert.equal(formatMoney("KWD", "1.2345", true), "KWD 1.235");
});

test("compact money rounds exactly without hiding tiny nonzero amounts", () => {
  for (const [value, expected] of [["0", "$0.00"], ["-0.00", "$0.00"], ["0.009", "<$0.01"], ["-0.001", ">-$0.01"], ["1.005", "$1.01"], ["-1.005", "-$1.01"], ["9.999", "$10.00"], ["9007199254740993.995", "$9007199254740994.00"]]) {
    assert.equal(formatMoney("USD", value, true), expected);
  }
  assert.equal(formatMoney("JPY", "0.5", true), "<¥1");
  assert.equal(formatMoney("USD", "-0.000000000123"), "-$0.000000000123");
  assert.equal(formatMoney("USD", "9007199254740993.995"), "$9007199254740993.995");
});

test("provider-specific statuses stay compact and reports retain exact money", () => {
  const baseten = parseBaseten({ model_apis_usage: { total: "1.2345", credits_used: "0", subtotal: "1.2345" } });
  assert.equal(formatBalanceStatus(baseten), "baseten $1.23 net");
  assert.match(formatBalanceReport(baseten), /net spend: \$1\.2345/);
  assert.equal(formatBalanceStatus(parseBaseten({})), "baseten $0.00 net");
  const fireworks = parseFireworksBilling({ lineItems: [{ totalCost: { currencyCode: "USD", nanos: 1 } }] });
  assert.equal(formatBalanceStatus(fireworks), "fireworks <$0.01");
  assert.match(formatBalanceReport(fireworks), /30d rated spend: \$0\.000000001/);
  const kimi = parseKimi({ boosterWallet: { balance: { type: "BOOSTER", amountLeft: "123456789" }, monthlyUsed: { currency: "USD" } } });
  assert.equal(formatBalanceStatus(kimi), "kimi $1.23");
  assert.match(formatBalanceReport(kimi), /booster balance: \$1\.23456789/);
});
