import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../../api/src/app.js';
import { createHttpClient } from '../src/api/httpClient';
import { ApiRequestError } from '../src/api/apiError';
import { createSpacesApi } from '../src/api/spacesApi';
import { createGraphApi } from '../src/api/graphApi';
import { createSpaceLoader } from '../src/space/spaceLoader';
import { initialEditorState, deleteNodes } from '../src/graph/graphState';
import { toPersistedGraph } from '../src/graph/graphModel';
import { CURRENT_SPACE_KEY, createCurrentSpaceStorage } from '../src/space/currentSpace';
import { etag, graphFixture, jsonResponse, spaceFixture, storageFixture } from './fixtures';

test('domain API передаёт точные paths/body/signal и проверяет shape/обязательные headers', async () => {
  const space = spaceFixture();
  const graph = graphFixture();
  const controller = new AbortController();
  const calls: { path: string; method: string; body?: string }[] = [];
  const client = createHttpClient('http://api.local', async (url, init) => {
    assert.equal(init?.signal, controller.signal);
    const path = new URL(String(url)).pathname;
    calls.push({ path, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    return path.endsWith('/graph')
      ? jsonResponse(graph, 200, { ETag: etag })
      : jsonResponse(space, path === '/api/spaces' ? 201 : 200, {
          Location: `/api/spaces/${space.id}`,
        });
  });
  const spaces = createSpacesApi(client);
  assert.equal((await spaces.create({ title: 'Мой канвас' }, controller.signal)).meta.status, 201);
  assert.equal((await spaces.get(space.id, controller.signal)).data.id, space.id);
  assert.equal((await createGraphApi(client).get(space.id, controller.signal)).meta.etag, etag);
  assert.deepEqual(calls, [
    { path: '/api/spaces', method: 'POST', body: JSON.stringify({ title: 'Мой канвас' }) },
    { path: `/api/spaces/${space.id}`, method: 'GET', body: undefined },
    { path: `/api/spaces/${space.id}/graph`, method: 'GET', body: undefined },
  ]);
  const bad = createSpacesApi(
    createHttpClient('', async () =>
      jsonResponse({ ...space, id: 'wrong' }, 201, { Location: '/api/spaces/wrong' }),
    ),
  );
  await assert.rejects(bad.create({ title: 'Test' }), { code: 'INVALID_RESPONSE' });
  const missingLocation = createSpacesApi(
    createHttpClient('', async () => jsonResponse(space, 201)),
  );
  await assert.rejects(missingLocation.create({ title: 'Test' }), { code: 'INVALID_RESPONSE' });
});

test('реальный HTTP: 201 space, GET graph + quoted ETag, reload того же id и нормализованный 404', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const requests: { method: string; status: number }[] = [];
  const client = createHttpClient(address, async (url, init) => {
    const response = await fetch(url, init);
    requests.push({ method: init?.method ?? 'GET', status: response.status });
    return response;
  });
  const spaces = createSpacesApi(client);
  const graphs = createGraphApi(client);
  const store = storageFixture();
  const loaded = await createSpaceLoader(spaces, graphs, store.storage).load();
  assert.deepEqual(requests, [
    { method: 'POST', status: 201 },
    { method: 'GET', status: 200 },
  ]);
  assert.equal(loaded.graph.meta.status, 200);
  assert.match(loaded.graph.meta.etag!, /^"[a-f0-9]{64}"$/);
  assert.ok(loaded.graph.meta.requestId);
  assert.deepEqual(loaded.graph.data, { nodes: [], edges: [], viewport: { x: 0, y: 0, zoom: 1 } });
  assert.deepEqual([...store.values], [[CURRENT_SPACE_KEY, loaded.space.id]]);

  // Только тестовая подготовка серверного графа; в приложении PUT ещё отсутствует.
  const graph = graphFixture();
  const fixtureResponse = await app.inject({
    method: 'PUT',
    url: `/api/spaces/${loaded.space.id}/graph`,
    headers: { 'If-Match': loaded.graph.meta.etag! },
    payload: graph,
  });
  assert.equal(fixtureResponse.statusCode, 200);
  const restored = await createSpaceLoader(
    spaces,
    graphs,
    createCurrentSpaceStorage(() => store.raw),
  ).load();
  assert.equal(restored.space.id, loaded.space.id);
  assert.deepEqual(restored.graph.data, graph);
  assert.equal(restored.graph.meta.etag, fixtureResponse.headers.etag);

  const edited = initialEditorState(restored.graph.data);
  edited.nodes[0].selected = true;
  edited.nodes[0].measured = { width: 260, height: 200 };
  const remaining = toPersistedGraph(deleteNodes(edited, new Set([edited.nodes[1].id])));
  const accepted = await app.inject({
    method: 'PUT',
    url: `/api/spaces/${loaded.space.id}/graph`,
    headers: { 'If-Match': restored.graph.meta.etag! },
    payload: remaining,
  });
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual((await graphs.get(loaded.space.id)).data, remaining);
  await assert.rejects(spaces.get(randomUUID()), (error: unknown) => {
    assert.ok(error instanceof ApiRequestError);
    assert.equal(error.kind, 'http');
    assert.equal(error.code, 'SPACE_NOT_FOUND');
    assert.equal(error.meta?.status, 404);
    return true;
  });
});
