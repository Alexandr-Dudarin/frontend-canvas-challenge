import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { buildApp } from '../../api/src/app.js';
import { createHttpClient } from '../src/api/httpClient';
import { ApiRequestError } from '../src/api/apiError';
import { createSpacesApi } from '../src/api/spacesApi';
import { createGraphApi } from '../src/api/graphApi';
import { createGraphSaveCoordinator } from '../src/save/graphSaveCoordinator';
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

  // Сохраняем через тот же domain API, которым пользуется редактор.
  const graph = graphFixture();
  const fixtureResponse = await graphs.put(loaded.space.id, graph, loaded.graph.meta.etag);
  assert.equal(fixtureResponse.meta.status, 200);
  const restored = await createSpaceLoader(
    spaces,
    graphs,
    createCurrentSpaceStorage(() => store.raw),
  ).load();
  assert.equal(restored.space.id, loaded.space.id);
  assert.deepEqual(restored.graph.data, graph);
  assert.equal(restored.graph.meta.etag, fixtureResponse.meta.etag);

  const edited = initialEditorState(restored.graph.data);
  edited.nodes[0].selected = true;
  edited.nodes[0].measured = { width: 260, height: 200 };
  const remaining = toPersistedGraph(deleteNodes(edited, new Set([edited.nodes[1].id])));
  const accepted = await graphs.put(loaded.space.id, remaining, restored.graph.meta.etag);
  assert.equal(accepted.meta.status, 200);
  await assert.rejects(graphs.put(loaded.space.id, graph, restored.graph.meta.etag), {
    code: 'GRAPH_VERSION_CONFLICT',
  });
  assert.deepEqual((await graphs.get(loaded.space.id)).data, remaining);
  await assert.rejects(spaces.get(randomUUID()), (error: unknown) => {
    assert.ok(error instanceof ApiRequestError);
    assert.equal(error.kind, 'http');
    assert.equal(error.code, 'SPACE_NOT_FOUND');
    assert.equal(error.meta?.status, 404);
    return true;
  });
});

test('PUT domain API: persisted body, quoted If-Match и validation Graph/ETag ответа', async () => {
  const graph = graphFixture();
  const controller = new AbortController();
  const version = `"${'b'.repeat(64)}"`;
  const api = createGraphApi(
    createHttpClient('http://api.local', async (url, init) => {
      assert.equal(String(url), 'http://api.local/api/spaces/space/graph');
      assert.equal(init?.method, 'PUT');
      assert.equal(init?.signal, controller.signal);
      assert.equal(new Headers(init?.headers).get('If-Match'), etag);
      assert.deepEqual(JSON.parse(init?.body as string), graph);
      return jsonResponse(graph, 200, { ETag: version });
    }),
  );
  assert.equal((await api.put('space', graph, etag, controller.signal)).meta.etag, version);
  for (const value of ['', '*', 'unquoted', `W/${etag}`, '"short"']) {
    await assert.rejects(api.put('space', graph, value), {
      kind: 'request',
      code: 'INVALID_GRAPH_ETAG',
    });
  }
  for (const value of [undefined, '', 'unquoted', `W/${etag}`]) {
    const broken = createGraphApi(
      createHttpClient('', async () => jsonResponse(graph, 200, value ? { ETag: value } : {})),
    );
    await assert.rejects(broken.get('space'), { kind: 'invalid-response' });
    await assert.rejects(broken.put('space', graph, etag), { kind: 'invalid-response' });
  }
  const malformed = createGraphApi(
    createHttpClient('', async () => jsonResponse({ nodes: [] }, 200, { ETag: version })),
  );
  await assert.rejects(malformed.put('space', graph, etag), { kind: 'invalid-response' });
});

test('реальный HTTP: потеря PUT response после commit → reconciliation GET → сохранение newer → reload', async (t) => {
  const app = await buildApp();
  t.after(() => app.close());
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  const logs: { method: string; status: number; etag: string | null }[] = [];
  let loseNext = true;
  const client = createHttpClient(address, async (url, init) => {
    const response = await fetch(url, init);
    logs.push({
      method: init?.method ?? 'GET',
      status: response.status,
      etag: new Headers(init?.headers).get('If-Match'),
    });
    if (init?.method === 'PUT' && loseNext) {
      loseNext = false;
      await response.text();
      // Сервер действительно ответил 200. Имитируем потерю ответа только на пути к transport.
      throw new TypeError('Response lost after commit');
    }
    return response;
  });
  const spaces = createSpacesApi(client);
  const graphs = createGraphApi(client);
  const store = storageFixture();
  const loaded = await createSpaceLoader(spaces, graphs, store.storage).load();
  let editor = initialEditorState(loaded.graph.data);
  let captures = 0;
  const coordinator = createGraphSaveCoordinator({
    spaceId: loaded.space.id,
    initialETag: loaded.graph.meta.etag,
    initialRevision: 0,
    api: graphs,
    captureLatest: () => {
      captures++;
      return { revision: editor.revision, graph: toPersistedGraph(editor) };
    },
    replaceGraph: (graph, revision) => {
      editor = initialEditorState(graph, revision);
    },
  });
  t.after(() => coordinator.dispose());
  editor = { ...initialEditorState(graphFixture()), revision: 1 };
  editor.nodes[0].selected = true;
  editor.nodes[0].measured = { width: 260, height: 200 };
  coordinator.schedule(editor.revision);
  logs.length = 0;
  const first = coordinator.flush();
  editor = { ...editor, revision: 2, viewport: { x: 100, y: -100, zoom: 1.2 } };
  const latest = editor;
  coordinator.schedule(editor.revision);
  const final = coordinator.flush();
  const afterFirst = await first;
  const afterFinal = await final;
  assert.equal(editor, latest);
  assert.equal(captures, 2);
  assert.equal(coordinator.getState().status, 'saved');
  assert.deepEqual(logs, [
    { method: 'PUT', status: 200, etag: loaded.graph.meta.etag },
    { method: 'GET', status: 200, etag: null },
    { method: 'PUT', status: 200, etag: afterFirst },
  ]);
  const reloaded = await createSpaceLoader(
    spaces,
    graphs,
    createCurrentSpaceStorage(() => store.raw),
  ).load();
  assert.deepEqual(reloaded.graph.data, toPersistedGraph(latest));
  assert.equal(reloaded.graph.meta.etag, afterFinal);
  assert.deepEqual([...store.values], [[CURRENT_SPACE_KEY, loaded.space.id]]);
});
