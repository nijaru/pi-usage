import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decimal, subtract, parseDeepSeek, parseOpenRouter, addOpenRouterCredits, parseMoonshot, parseMiniMax, parseVercel, officialIdentity, fetchBalance, formatBalanceStatus, formatBalanceReport, resolveCreditsKey, getJson } from '../extensions/providers.ts';

const model = (provider, baseUrl) => ({ provider, baseUrl, id: 'test' });
const data = { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '4.123456789123', granted_balance: '0.00', topped_up_balance: '4.123456789123' }] };
const signal = () => new AbortController().signal;

test('decimal money preserves strings and performs exact subtraction', () => {
  assert.equal(subtract('10.10', '0.20'), '9.90');
  assert.equal(subtract('0.01', '2.10'), '-2.09');
  assert.equal(subtract('1000000000000000000000.01', '0.001'), '1000000000000000000000.009');
  assert.equal(decimal(1e-7), '0.0000001');
  assert.equal(decimal(Number.NaN), undefined);
});
test('DeepSeek keeps currencies and exact decimals separate', () => {
  const result = parseDeepSeek({ ...data, balance_infos: [...data.balance_infos, { currency: 'CNY', total_balance: '10.001' }] });
  assert.equal(formatBalanceStatus(result), 'deepseek $4.12 · CN¥10.00');
  assert.match(formatBalanceReport(result), /balance: \$4\.123456789123/);
  assert.match(formatBalanceReport(result), /balance: CN¥10\.001/);
  assert.match(formatBalanceStatus(parseDeepSeek({ ...data, is_available: false })), /API unavailable/);
});
for (const invalid of [{}, { ...data, balance_infos: [] }, { ...data, balance_infos: [{ currency: 'EUR', total_balance: '3' }] }, { ...data, balance_infos: [...data.balance_infos, ...data.balance_infos] }]) {
  test(`rejects invalid DeepSeek data ${JSON.stringify(invalid).slice(0,80)}`, () => assert.throws(() => parseDeepSeek(invalid)));
}
test('OpenRouter key cap is not an account balance', () => {
  const unlimited = parseOpenRouter({ data: { limit: null, usage: 20 } });
  assert.equal(unlimited.kind, 'key-limit');
  assert.equal(unlimited.amounts.length, 0);
  assert.equal(formatBalanceStatus(unlimited), '');
  assert.match(formatBalanceReport(unlimited), /^openrouter\n/);
  assert.match(formatBalanceReport(unlimited), /spent: \$20/);
  assert.equal(formatBalanceStatus(addOpenRouterCredits(unlimited, { data: { total_credits: 25, total_usage: 0 } })), 'openrouter $25.00');
  const limited = parseOpenRouter({ data: { limit: 50, limit_remaining: 30, usage: 20 } });
  assert.equal(formatBalanceStatus(limited), 'openrouter cap $30.00');
  assert.equal(formatBalanceStatus(parseOpenRouter({ data: { limit: 50, limit_remaining: 0 } })), 'openrouter cap $0.00');
  const credited = addOpenRouterCredits(limited, { data: { total_credits: 100.5, total_usage: 25.75 } });
  assert.equal(credited.amounts[0].value, '74.75');
  assert.equal(credited.amounts[1].value, '30');
  assert.equal(formatBalanceStatus(credited), 'openrouter $74.75 cap $30.00');
  assert.match(formatBalanceReport(credited), /key cap left: \$30/);
});
test('zero balances remain distinguishable from missing values', () => {
  assert.equal(parseDeepSeek({ ...data, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] }).amounts[0].value, '0.00');
  assert.throws(() => parseVercel({}));
  assert.equal(parseVercel({ balance: '0', total_used: '100' }).amounts[0].value, '0');
});
test('Moonshot and MiniMax currencies follow provider region', () => {
  assert.equal(parseMoonshot('moonshotai-cn', { data: { available_balance: '10.20', cash_balance: '-1' } }).amounts[0].currency, 'CNY');
  assert.equal(parseMiniMax('minimax', { base_resp: { status_code: 0 }, available_amount: '2.01' }, true).amounts[0].currency, 'USD');
  assert.throws(() => parseMiniMax('minimax', { base_resp: { status_code: 1 }, available_amount: '2.01' }, true));
});
test('MiniMax plan percentages are not confused with changed usage-count semantics', () => {
  const value = parseMiniMax('minimax', { base_resp: { status_code: 0 }, model_remains: [{ model_name: 'M', current_interval_remaining_percent: 42, current_weekly_remaining_percent: 83 }] }, false);
  assert.match(formatBalanceStatus(value), /42% left/);
  assert.throws(() => parseMiniMax('minimax', { base_resp: { status_code: 0 }, model_remains: [{ current_interval_usage_count: 4 }] }, false));
});
for (const url of ['https://proxy.example/v1', 'https://api.deepseek.com.evil.test', 'http://api.deepseek.com', 'https://u:p@api.deepseek.com']) {
  test(`rejects credential origin ${url}`, () => assert.throws(() => officialIdentity(model('deepseek', url), { ok: true, apiKey: 'secret' })));
}
test('auth override cannot forward proxy or cross-region credentials', () => {
  assert.throws(() => officialIdentity(model('deepseek', 'https://api.deepseek.com'), { ok: true, apiKey: 'secret', baseUrl: 'https://proxy.test' }));
  assert.throws(() => officialIdentity(model('moonshotai', 'https://api.moonshot.cn'), { ok: true, apiKey: 'secret' }));
});
test('explicit authorization suppression does not fall back to an API key', () => {
  assert.throws(() => officialIdentity(model('deepseek', 'https://api.deepseek.com'), { ok: true, apiKey: 'secret', headers: { Authorization: null } }));
});
test('OpenRouter management credentials require exact inference-key binding', () => {
  const identity = officialIdentity(model('openrouter', 'https://openrouter.ai/api/v1'), { ok: true, apiKey: 'key-a' });
  const binding = { inferenceKeyEnv: 'OR_KEY', managementKeyEnv: 'OR_MANAGEMENT' };
  assert.throws(() => resolveCreditsKey(identity, binding, { OR_KEY: 'key-b', OR_MANAGEMENT: 'manage' }));
  assert.equal(resolveCreditsKey(identity, binding, { OR_KEY: 'key-a', OR_MANAGEMENT: 'manage' }), 'manage');
  assert.equal(resolveCreditsKey(identity, undefined, { OR_MANAGEMENT: 'manage' }), undefined);
});
test('balance requests are read-only, origin fixed, and redirects refused', async () => {
  let request;
  const identity = officialIdentity(model('deepseek', 'https://api.deepseek.com/v1'), { ok: true, apiKey: 'key' });
  await fetchBalance(identity, signal(), async (url, init) => { request = { url, init }; return Response.json(data); });
  assert.equal(request.url, 'https://api.deepseek.com/user/balance');
  assert.equal(request.init.method, 'GET');
  assert.equal(request.init.redirect, 'error');
});
test('OpenRouter queries cap with inference key and credit with management key', async () => {
  const keys = [];
  const identity = officialIdentity(model('openrouter', 'https://openrouter.ai/api/v1'), { ok: true, apiKey: 'infer' });
  const result = await fetchBalance(identity, signal(), async (url, init) => {
    keys.push([url, init.headers.Authorization]);
    return Response.json({ data: url.endsWith('/key') ? { limit: null, usage: 2 } : { total_credits: 10, total_usage: 2 } });
  }, 'manage');
  assert.equal(result.amounts[0].value, '8');
  assert.deepEqual(keys.map(x=>x[1]), ['Bearer infer', 'Bearer manage']);
});
test('failed credits request keeps correctly scoped key data', async () => {
  const identity = officialIdentity(model('openrouter', 'https://openrouter.ai/api/v1'), { ok: true, apiKey: 'infer' });
  const result = await fetchBalance(identity, signal(), async url => url.endsWith('/key') ? Response.json({ data: { limit: 10, limit_remaining: 8 } }) : new Response('secret server body', { status: 403 }), 'manage');
  assert.equal(result.kind, 'key-limit');
  assert.match(result.lines.join('\n'), /Account credit unavailable/);
  assert.doesNotMatch(result.lines.join('\n'), /secret server body/);
});
test('pre-aborted queries make no request', async () => {
  const owner = new AbortController(); owner.abort(); let called = false;
  await assert.rejects(getJson('https://api.deepseek.com/user/balance', 'key', owner.signal, async () => { called = true; return Response.json(data); }));
  assert.equal(called, false);
});
test('oversized and malformed payloads fail explicitly', async () => {
  await assert.rejects(getJson('https://api.deepseek.com/user/balance', 'key', signal(), async()=>new Response('x'.repeat(1024*1024+1))), /1 MiB/);
  await assert.rejects(getJson('https://api.deepseek.com/user/balance', 'key', signal(), async()=>new Response('{bad')), /Invalid usage JSON/);
});
