import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../../api/src/app.js';
import { createHttpClient } from '../src/api/httpClient';
import { createSpacesApi } from '../src/api/spacesApi';
import { createGraphApi } from '../src/api/graphApi';
import { createConfigApi } from '../src/api/configApi';
import { createGenerationsApi } from '../src/api/generationsApi';
import { createGenerationController } from '../src/generation/generationController';
import { createGenerationRecovery } from '../src/generation/generationRecovery';
import { initialEditorState } from '../src/graph/graphState';
import { generationSetup, memoryStorage } from './generationFixtures';
import { etag, graphFixture, jsonResponse } from './fixtures';

test('generation API: точные body/headers/Location, shared errors, invalid resource/schema, config, asset URL', async () => {
  const s = generationSetup();
  const data = s.generation();
  const key = randomUUID();
  const body = { nodeId: s.nodeId, graphETag: etag, scenario: 'success' as const };
  const signal = new AbortController().signal;
  const client = createHttpClient('https://api.local/', async (url, init) => {
    assert.equal(String(url), `https://api.local/api/spaces/${s.spaceId}/generations`);
    assert.deepEqual(JSON.parse(String(init?.body)), body);
    assert.equal(new Headers(init?.headers).get('Idempotency-Key'), key);
    assert.equal(new Headers(init?.headers).get('If-Match'), null);
    assert.equal(init?.signal, signal);
    return jsonResponse(data, 202, {
      Location: data.links.self.href,
      'Retry-After': '1',
      'X-Request-Id': 'generation-test',
    });
  });
  const response = await createGenerationsApi(client).create(s.spaceId, body, key, signal);
  assert.equal(response.meta.retryAfter, '1');
  assert.equal(response.meta.location, data.links.self.href);
  assert.equal(response.meta.requestId, 'generation-test');
  assert.equal(client.resolveUrl('/assets/demo.svg'), 'https://api.local/assets/demo.svg');
  const apiFor = (value: unknown, status = 200) =>
    createGenerationsApi(createHttpClient('', async () => jsonResponse(value, status)));
  await assert.rejects(
    apiFor(data).create(s.spaceId, { ...body, extra: true } as typeof body, key),
    { code: 'INVALID_GENERATION_INPUT' },
  );
  await assert.rejects(apiFor(data).create(s.spaceId, body, 'x'), {
    code: 'INVALID_GENERATION_INPUT',
  });
  await assert.rejects(apiFor(data, 202).create(s.spaceId, body, key), {
    code: 'INVALID_RESPONSE',
  });
  await assert.rejects(apiFor({ ...data, status: 'unknown' }).get(s.spaceId, data.id), {
    code: 'INVALID_RESPONSE',
  });
  await assert.rejects(apiFor({ ...data, spaceId: randomUUID() }).get(s.spaceId, data.id), {
    code: 'INVALID_RESPONSE',
  });
  await assert.rejects(apiFor(data).get(s.spaceId, randomUUID()), { code: 'INVALID_RESPONSE' });
  await assert.rejects(apiFor(data).get(s.spaceId, data.id, undefined, '//other.example'), {
    code: 'INVALID_GENERATION_LOCATION',
  });
  await assert.rejects(apiFor([{ ...data, status: 'succeeded', imageUrl: null }]).list(s.spaceId), {
    code: 'INVALID_RESPONSE',
  });
  await assert.rejects(
    apiFor({ error: { code: 'INCOMPLETE_CHAIN', message: 'Нет цепочки' } }, 422).create(
      s.spaceId,
      body,
      key,
    ),
    { code: 'INCOMPLETE_CHAIN', kind: 'http' },
  );
  await assert.rejects(
    createConfigApi(createHttpClient('', async () => jsonResponse({ pollIntervalMs: 500 }))).get(),
    { code: 'INVALID_RESPONSE' },
  );
});

test('реальный HTTP: 202/Location/Retry-After, replay 202→200, success/failure, list, все domain errors', async (t) => {
  let now = Date.parse('2026-09-14T12:00:00Z');
  const app = await buildApp({ now: () => now, generationDelayMs: 1500 });
  t.after(() => app.close());
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const client = createHttpClient(base);
  const api = createGenerationsApi(client);
  const graphs = createGraphApi(client);
  const space = (await createSpacesApi(client).create({ title: 'Generation test' })).data;
  const graph = graphFixture();
  const initial = await graphs.get(space.id);
  const saved = await graphs.put(space.id, graph, initial.meta.etag);
  const body = {
    nodeId: graph.nodes[1].id,
    graphETag: saved.meta.etag,
    scenario: 'success' as const,
  };
  const key = randomUUID();
  const first = await api.create(space.id, body, key);
  assert.equal(first.meta.status, 202);
  assert.equal(first.meta.retryAfter, '1');
  const replay = await api.create(space.id, body, key);
  assert.equal(replay.meta.status, 202);
  assert.equal(replay.data.id, first.data.id);
  await assert.rejects(api.create(space.id, { ...body, scenario: 'failure' }, key), {
    code: 'IDEMPOTENCY_CONFLICT',
  });
  await assert.rejects(api.create(space.id, body, randomUUID()), {
    code: 'GENERATION_IN_PROGRESS',
  });
  await assert.rejects(api.create(space.id, { ...body, graphETag: etag }, randomUUID()), {
    code: 'GRAPH_CHANGED',
  });
  await assert.rejects(api.create(space.id, { ...body, nodeId: graph.nodes[0].id }, randomUUID()), {
    code: 'GENERATOR_REQUIRED',
  });
  now += 2000;
  const success = await api.get(space.id, first.data.id, undefined, first.meta.location!);
  assert.equal(success.data.status, 'succeeded');
  assert.equal(success.meta.retryAfter, null);
  assert.equal(success.data.resultNodeId, graph.nodes[2].id);
  assert.equal((await fetch(client.resolveUrl(success.data.imageUrl!))).status, 200);
  assert.equal((await createConfigApi(client).get()).data.pollIntervalMs, 500);
  assert.equal((await api.create(space.id, body, key)).meta.status, 200);
  const failure = await api.create(space.id, { ...body, scenario: 'failure' }, randomUUID());
  now += 2000;
  const failed = await api.get(space.id, failure.data.id);
  assert.equal(failed.meta.status, 200);
  assert.equal(failed.data.status, 'failed');
  assert.equal(failed.data.failureCode, 'SIMULATED_FAILURE');
  const history = await api.list(space.id);
  assert.deepEqual(
    history.data.map((item) => item.id),
    [failure.data.id, first.data.id],
  );
  const incomplete = { ...graph, edges: [] };
  const updated = await graphs.put(space.id, incomplete, saved.meta.etag);
  await assert.rejects(
    api.create(space.id, { ...body, graphETag: updated.meta.etag }, randomUUID()),
    { code: 'INCOMPLETE_CHAIN' },
  );
  // Replay проверяется сервером до версии графа: старое body остаётся безопасным после его правки.
  assert.equal((await api.create(space.id, body, key)).data.id, first.data.id);
});

test('реальный HTTP: server commit → response потерян → recreation storage/controller → тот же id, один resource', async (t) => {
  const app = await buildApp({ generationDelayMs: 0 });
  t.after(() => app.close());
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  let drop = true;
  const posts: { body: string; key: string | null; status: number }[] = [];
  const client = createHttpClient(base, async (url, init) => {
    const response = await fetch(url, init);
    if (init?.method === 'POST' && String(url).endsWith('/generations')) {
      posts.push({
        body: String(init.body),
        key: new Headers(init.headers).get('Idempotency-Key'),
        status: response.status,
      });
      if (drop) {
        drop = false;
        await response.text();
        throw new TypeError('Тест отбрасывает уже полученный HTTP response');
      }
    }
    return response;
  });
  const api = createGenerationsApi(client);
  const graphs = createGraphApi(client);
  const space = (await createSpacesApi(client).create({ title: 'Lost response' })).data;
  const graph = graphFixture();
  const initial = await graphs.get(space.id);
  const saved = await graphs.put(space.id, graph, initial.meta.etag);
  const storage = memoryStorage();
  const options = {
    spaceId: space.id,
    api,
    config: createConfigApi(client),
    getGraph: () => initialEditorState(graph),
    recovery: createGenerationRecovery(() => storage),
    flush: async () => saved.meta.etag,
    onGraphChanged: assert.fail,
  };
  const first = createGenerationController(options);
  await first.restore();
  await first.start(graph.nodes[1].id, 'success');
  const committed = (await api.list(space.id)).data[0];
  assert.equal(first.getGenerator(graph.nodes[1].id).status, 'error');
  assert.equal(storage.length, 1);
  first.dispose();
  const restored = createGenerationController({
    ...options,
    recovery: createGenerationRecovery(() => storage),
  });
  t.after(() => restored.dispose());
  await restored.restore();
  assert.deepEqual(
    posts.map((post) => post.status),
    [201, 200],
  );
  assert.equal(posts[0].key, posts[1].key);
  assert.equal(posts[0].body, posts[1].body);
  assert.equal((await api.list(space.id)).data.length, 1);
  assert.equal(storage.length, 0);
  const view = restored.getResult(graph.nodes[2].id);
  assert.ok('generation' in view);
  assert.equal(view.generation?.id, committed.id);
  assert.equal(view.status, 'succeeded');
});
