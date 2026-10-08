import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick, setTimeout as sleep } from 'node:timers/promises';
import { getJson } from '../extensions/providers.ts';
import { fetchCodexUsage } from '../extensions/usage.ts';

const payload = { rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000 } } };
const requests = [
  ['balance', (fetcher, signal = new AbortController().signal) => getJson('https://api.deepseek.com/user/balance', 'test-token', signal, fetcher)],
  ['Codex', (fetcher, signal) => fetchCodexUsage({ accessToken: 'test-token', accountId: 'test-account', fetcher, signal })],
];

for (const [name, request] of requests) describe(`${name} response transport`, () => {
  test('closes error bodies even if cancellation rejects, without leaking their content', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      cancel() { cancelled = true; throw new Error('private backend error test-token test-account'); },
    }), { status: 503 });
    await assert.rejects(request(async () => response), error => {
      assert.match(String(error), /request failed \(503\)/);
      assert.doesNotMatch(String(error), /private backend|test-token|test-account/);
      return true;
    });
    assert.equal(cancelled, true);
    assert.equal(response.body.locked, false);
  });

  test('bounds successful JSON bodies to 1 MiB', async () => {
    await assert.rejects(request(async () => Response.json({ ...payload, padding: 'x'.repeat(1024 * 1024) })), /1 MiB/);
  });

  test('rejects malformed JSON without reflecting backend bytes', async () => {
    await assert.rejects(request(async () => new Response('{"private-backend": secret}')), /Invalid usage JSON/);
  });

  test('does not dispatch an already-cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    let called = false;
    await assert.rejects(request(async () => { called = true; return Response.json(payload); }, controller.signal));
    assert.equal(called, false);
  });

  test('cancels a stalled body read and releases its reader', async () => {
    const controller = new AbortController();
    let body;
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(stream) { body = stream; },
      cancel() { cancelled = true; },
    }));
    const pending = request(async () => response, controller.signal).then(() => 'resolved', () => 'rejected');
    try {
      await tick();
      controller.abort();
      assert.equal(await Promise.race([pending, sleep(100).then(() => 'stalled')]), 'rejected');
      assert.equal(cancelled, true);
      assert.equal(response.body.locked, false);
    } finally {
      // Also release the reader when probing a broken implementation.
      if (!cancelled) body.close();
      await pending;
    }
  });
});

test('Codex timeout also cancels a stalled response body', async () => {
  let cancelled = false;
  let body;
  const response = new Response(new ReadableStream({
    start(stream) { body = stream; },
    cancel() { cancelled = true; },
  }));
  const pending = fetchCodexUsage({ accessToken: 'test-token', accountId: 'test-account', timeoutMs: 10, fetcher: async () => response }).then(() => 'resolved', () => 'rejected');
  try {
    assert.equal(await Promise.race([pending, sleep(100).then(() => 'stalled')]), 'rejected');
    assert.equal(cancelled, true);
    assert.equal(response.body.locked, false);
  } finally {
    if (!cancelled) body.close();
    await pending;
  }
});
