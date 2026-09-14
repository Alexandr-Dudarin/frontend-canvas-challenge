import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryAfterMs, startGenerationPolling } from '../src/generation/generationPolling';
import {
  deferred,
  generationResponse,
  generationSetup,
  manualClock,
  networkError,
  settle,
} from './generationFixtures';

test('Retry-After: секунды, дробные секунды, HTTP-date и config fallback', () => {
  const now = Date.parse('2026-09-14T10:00:00Z');
  assert.equal(retryAfterMs('1', 500, now), 1000);
  assert.equal(retryAfterMs('1.5', 500, now), 1500);
  assert.equal(retryAfterMs('Mon, 14 Sep 2026 10:00:02 GMT', 500, now), 2000);
  for (const header of [null, '', 'oops', '-1', 'Infinity', '999999999999'])
    assert.equal(retryAfterMs(header, 750, now), 750);
});

for (const status of ['succeeded', 'failed'] as const) {
  test(`poll processing → ${status}: Retry-After, config fallback, no overlap, terminal stop`, async () => {
    const { generation } = generationSetup();
    const clock = manualClock();
    const initial = generation();
    const replies = [
      deferred<ReturnType<typeof generationResponse>>(),
      deferred<ReturnType<typeof generationResponse>>(),
    ];
    const received: string[] = [];
    let count = 0;
    const poll = startGenerationPolling({
      initial,
      retryAfter: '1.5',
      fallbackMs: 650,
      scheduleAfter: clock.scheduleAfter,
      read: async () => replies[count++].promise,
      onData: (data) => received.push(data.status),
      onError: assert.fail,
    });
    clock.tick(1499);
    assert.equal(count, 0);
    clock.tick(1);
    assert.equal(count, 1);
    clock.tick(10000);
    assert.equal(count, 1);
    assert.equal(clock.pending, 0);
    replies[0].resolve(generationResponse(initial));
    await settle();
    clock.tick(649);
    assert.equal(count, 1);
    clock.tick(1);
    assert.equal(count, 2);
    replies[1].resolve(generationResponse({ ...initial, status }));
    await settle();
    assert.deepEqual(received, ['processing', status]);
    assert.equal(clock.pending, 0);
    clock.tick(100000);
    assert.equal(count, 2);
    poll.stop();
  });
}

test('cleanup отменяет timer/request; late response после stop ничего не публикует', async () => {
  const { generation } = generationSetup();
  const clock = manualClock();
  const reply = deferred<ReturnType<typeof generationResponse>>();
  let signal: AbortSignal | undefined;
  let updates = 0;
  const options = {
    initial: generation(),
    retryAfter: null,
    fallbackMs: 500,
    scheduleAfter: clock.scheduleAfter,
    read: async (value: AbortSignal) => {
      signal = value;
      return reply.promise;
    },
    onData: () => {
      updates++;
    },
    onError: assert.fail,
  };
  const timerOnly = startGenerationPolling(options);
  timerOnly.stop();
  assert.equal(clock.pending, 0);
  const active = startGenerationPolling(options);
  clock.tick(500);
  assert.ok(signal);
  active.stop();
  assert.equal(signal.aborted, true);
  reply.resolve(generationResponse(generation({ status: 'succeeded' })));
  await settle();
  assert.equal(updates, 0);
  assert.equal(clock.pending, 0);
});

test('poll error останавливает цикл без автоматического retry', async () => {
  const { generation } = generationSetup();
  const clock = manualClock();
  let errors = 0;
  let reads = 0;
  startGenerationPolling({
    initial: generation(),
    retryAfter: null,
    fallbackMs: 500,
    scheduleAfter: clock.scheduleAfter,
    read: async () => {
      reads++;
      throw networkError();
    },
    onData: () => assert.fail('После ошибки данных нет'),
    onError: (error) => {
      errors++;
      assert.equal(error.code, 'NETWORK_ERROR');
    },
  });
  clock.tick(500);
  await settle();
  clock.tick(10000);
  assert.equal(errors, 1);
  assert.equal(reads, 1);
  assert.equal(clock.pending, 0);
});
