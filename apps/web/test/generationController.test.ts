import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createGenerationController } from '../src/generation/generationController';
import { indexGenerations } from '../src/generation/generationModel';
import { createGenerationRecovery } from '../src/generation/generationRecovery';
import { editorReducer } from '../src/graph/graphState';
import { toPersistedGraph } from '../src/graph/graphModel';
import { createGraphSaveCoordinator } from '../src/save/graphSaveCoordinator';
import { etag, meta } from './fixtures';
import {
  businessError,
  deferred,
  generationResponse,
  generationSetup,
  networkError,
  settle,
} from './generationFixtures';

test('edit → реальный flush coordinator → POST; body использует только подтверждённый ETag', async (t) => {
  const s = generationSetup();
  const nextETag = `"${'b'.repeat(64)}"`;
  const reply = deferred<{ data: ReturnType<typeof toPersistedGraph>; meta: typeof meta }>();
  const save = createGraphSaveCoordinator({
    spaceId: s.spaceId,
    initialETag: etag,
    initialRevision: 0,
    captureLatest: () => ({ revision: s.editor.revision, graph: toPersistedGraph(s.editor) }),
    replaceGraph: assert.fail,
    scheduleAfter: s.clock.scheduleAfter,
    api: {
      get: async () => {
        throw Error('GET не нужен');
      },
      put: async () => {
        s.events.push('PUT');
        return reply.promise;
      },
    },
  });
  s.options.flush = () => save.flush();
  const controller = createGenerationController(s.options);
  t.after(() => {
    controller.dispose();
    save.dispose();
  });
  await controller.restore();
  s.editor = editorReducer(s.editor, {
    type: 'editPrompt',
    id: s.editor.nodes[0].id,
    text: 'Свежий текст',
  });
  save.schedule(s.editor.revision);
  const started = controller.start(s.nodeId, 'success');
  assert.deepEqual(s.events, ['PUT']);
  assert.equal(s.calls.length, 0);
  reply.resolve({ data: toPersistedGraph(s.editor), meta: { ...meta, etag: nextETag } });
  await started;
  assert.deepEqual(s.events, ['PUT', 'POST']);
  assert.deepEqual(s.calls[0].body, { nodeId: s.nodeId, graphETag: nextETag, scenario: 'success' });
});

test('новая revision во время flush тоже подтверждается; double submit не создаёт вторую operation', async (t) => {
  const s = generationSetup();
  const first = deferred<string>();
  let flushes = 0;
  s.options.flush = async () => (++flushes === 1 ? first.promise : etag);
  const c = createGenerationController(s.options);
  t.after(() => c.dispose());
  await c.restore();
  const task = c.start(s.nodeId, 'success');
  await c.start(s.nodeId, 'failure');
  s.editor = { ...s.editor, revision: 1 };
  first.resolve(etag);
  await task;
  assert.equal(flushes, 2);
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].body.scenario, 'success');
});

for (const error of [networkError(), businessError('GRAPH_VERSION_CONFLICT', 412)]) {
  test(`flush ${error.code} → POST отсутствует, Graph не изменён`, async (t) => {
    const s = generationSetup();
    const graph = s.editor;
    s.options.flush = async () => {
      throw error;
    };
    const c = createGenerationController(s.options);
    t.after(() => c.dispose());
    await c.restore();
    await c.start(s.nodeId, 'success');
    assert.equal(s.calls.length, 0);
    assert.equal(s.storage.length, 0);
    assert.equal(s.editor, graph);
    assert.equal(c.getGenerator(s.nodeId).status, 'error');
  });
}

test('body/key durable ДО POST; unknown retry и simulated reload сохраняют точную operation', async (t) => {
  const s = generationSetup();
  const received: { body: unknown; key: string }[] = [];
  s.api.create = async (_spaceId, body, key) => {
    assert.deepEqual(s.recovery.read(s.spaceId, s.nodeId)?.body, body);
    assert.equal(s.recovery.read(s.spaceId, s.nodeId)?.key, key);
    received.push({ body, key });
    throw networkError();
  };
  await s.controller.restore();
  await s.controller.start(s.nodeId, 'failure');
  await s.controller.retry(s.nodeId);
  assert.deepEqual(received[0], received[1]);
  s.controller.dispose();
  const restored = createGenerationController({
    ...s.options,
    recovery: createGenerationRecovery(() => s.storage),
    flush: async () => {
      throw Error('Replay не вызывает flush');
    },
  });
  t.after(() => restored.dispose());
  await restored.restore();
  assert.deepEqual(received[2], received[0]);
  const result = s.generation({
    status: 'failed',
    scenario: 'failure',
    failureCode: 'SIMULATED_FAILURE',
  });
  s.api.create = async (_spaceId, body, key) => {
    received.push({ body, key });
    return generationResponse(result);
  };
  await restored.retry(s.nodeId);
  assert.equal(restored.getGenerator(s.nodeId).status, 'failed');
  assert.equal(s.storage.length, 0);
  assert.deepEqual(received[3], received[0]);
});

for (const status of [200, 201]) {
  test(`HTTP ${status} failed — business result; новая попытка получает новый key, terminal не poll`, async (t) => {
    const s = generationSetup();
    t.after(() => s.controller.dispose());
    const keys: string[] = [];
    s.api.create = async (_spaceId, body, key) => {
      keys.push(key);
      return generationResponse(
        s.generation({ ...body, status: 'failed', failureCode: 'SIMULATED_FAILURE' }),
        status,
      );
    };
    await s.controller.restore();
    await s.controller.start(s.nodeId, 'failure');
    assert.equal(s.controller.getGenerator(s.nodeId).status, 'failed');
    assert.equal(s.clock.pending, 0);
    await s.controller.start(s.nodeId, 'success');
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
    assert.equal(s.storage.length, 0);
  });
}

test('restore: latest индексы за один проход; succeeded image и processing polling после reload', async (t) => {
  const s = generationSetup();
  t.after(() => s.controller.dispose());
  const done = s.generation({
    nodeId: randomUUID(),
    resultNodeId: randomUUID(),
    status: 'succeeded',
    imageUrl: '/assets/demo.svg',
  });
  const processing = s.generation();
  const old = s.generation({ id: randomUUID(), createdAt: '2026-01-01T00:00:00Z' });
  s.resources.push(processing, done, old);
  let visits = 0;
  const list = new Proxy(s.resources, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) visits++;
      return Reflect.get(target, key, receiver);
    },
  });
  const indexed = indexGenerations(list);
  assert.equal(visits, 3);
  assert.equal(indexed.byGenerator.get(s.nodeId)?.id, processing.id);
  let reads = 0;
  s.api.get = async () => {
    reads++;
    return generationResponse({ ...processing, status: 'succeeded', imageUrl: '/assets/demo.svg' });
  };
  await s.controller.restore();
  assert.equal(s.controller.getResult(done.resultNodeId).status, 'succeeded');
  assert.equal(s.calls.length, 0);
  s.clock.tick(499);
  assert.equal(reads, 0);
  s.clock.tick(1);
  await settle();
  assert.equal(s.controller.getResult(s.resultNodeId).status, 'succeeded');
  assert.equal(s.clock.pending, 0);
});

test('202 → polling error → retry GET той же generation, не новый POST', async (t) => {
  const s = generationSetup();
  t.after(() => s.controller.dispose());
  await s.controller.restore();
  await s.controller.start(s.nodeId, 'success');
  assert.equal(s.clock.pending, 1);
  s.api.get = async () => {
    throw networkError();
  };
  s.clock.tick(999);
  assert.equal(s.controller.getGenerator(s.nodeId).status, 'processing');
  s.clock.tick(1);
  await settle();
  assert.equal(s.controller.getGenerator(s.nodeId).status, 'error');
  s.api.get = async () =>
    generationResponse({ ...s.resources[0], status: 'succeeded', imageUrl: '/assets/demo.svg' });
  await s.controller.retry(s.nodeId);
  s.clock.tick(500);
  await settle();
  assert.equal(s.calls.length, 1);
  assert.equal(s.controller.getGenerator(s.nodeId).status, 'succeeded');
});

test('reconnect/delete не перенаправляет old result; poll не меняет Graph/revision', async (t) => {
  const s = generationSetup();
  t.after(() => s.controller.dispose());
  await s.controller.restore();
  await s.controller.start(s.nodeId, 'success');
  const newResult = randomUUID();
  s.editor = editorReducer(s.editor, { type: 'addNode', nodeType: 'result', id: newResult });
  s.editor = {
    ...s.editor,
    edges: s.editor.edges.map((edge) =>
      edge.source === s.nodeId ? { ...edge, target: newResult } : edge,
    ),
  };
  s.editor = editorReducer(s.editor, { type: 'deleteNodes', ids: new Set([s.resultNodeId]) });
  const graph = s.editor;
  s.api.get = async () =>
    generationResponse({ ...s.resources[0], status: 'succeeded', imageUrl: '/assets/demo.svg' });
  s.clock.tick(1000);
  await settle();
  assert.equal(s.controller.getResult(newResult).status, 'idle');
  assert.equal(s.editor, graph);
  const visible = s.editor.nodes
    .filter((node) => node.type === 'result')
    .map((node) => s.controller.getResult(node.id));
  assert.ok(visible.every((view) => view.status === 'idle'));
  assert.ok(!JSON.stringify(toPersistedGraph(s.editor)).includes('imageUrl'));
  assert.ok(!JSON.stringify(toPersistedGraph(s.editor)).includes('generationId'));
});

test('late poll A не заменяет newer B у того же result; другая node snapshot стабильна', async (t) => {
  const s = generationSetup();
  t.after(() => s.controller.dispose());
  const secondNode = randomUUID();
  s.editor = editorReducer(s.editor, { type: 'addNode', nodeType: 'generator', id: secondNode });
  await s.controller.restore();
  await s.controller.start(s.nodeId, 'success');
  const late = deferred<ReturnType<typeof generationResponse>>();
  s.api.get = async () => late.promise;
  s.clock.tick(1000);
  await s.controller.start(secondNode, 'success');
  const b = s.resources[0];
  const snapshot = s.controller.getGenerator(secondNode);
  late.resolve(
    generationResponse({ ...s.resources[1], status: 'succeeded', imageUrl: '/assets/demo.svg' }),
  );
  await settle();
  const result = s.controller.getResult(s.resultNodeId);
  assert.ok('generation' in result);
  assert.equal(result.generation?.id, b.id);
  assert.equal(s.controller.getGenerator(secondNode), snapshot);
});

test('поздний POST A не отбирает result у более новой B; ties разрешает порядок list API', async (t) => {
  const s = generationSetup();
  t.after(() => s.controller.dispose());
  const secondNode = randomUUID();
  s.editor = editorReducer(s.editor, { type: 'addNode', nodeType: 'generator', id: secondNode });
  const a = s.generation({ status: 'succeeded', imageUrl: '/assets/demo.svg' });
  const b = s.generation({
    nodeId: secondNode,
    createdAt: a.createdAt,
    status: 'succeeded',
    imageUrl: '/assets/demo.svg',
  });
  const late = deferred<ReturnType<typeof generationResponse>>();
  s.api.create = async (_spaceId, body) =>
    body.nodeId === s.nodeId ? late.promise : generationResponse(b, 201);
  await s.controller.restore();
  const startingA = s.controller.start(s.nodeId, 'success');
  await settle();
  s.resources.push(b, a);
  await s.controller.start(secondNode, 'success');
  late.resolve(generationResponse(a, 201));
  await startingA;
  const result = s.controller.getResult(s.resultNodeId);
  assert.ok('generation' in result);
  assert.equal(result.generation?.id, b.id);
});

for (const code of [
  'GRAPH_CHANGED',
  'GENERATION_IN_PROGRESS',
  'IDEMPOTENCY_CONFLICT',
  'GENERATOR_REQUIRED',
  'INCOMPLETE_CHAIN',
]) {
  test(`${code}: безопасная политика без автоматического нового key`, async (t) => {
    const s = generationSetup();
    t.after(() => s.controller.dispose());
    let posts = 0;
    s.api.create = async () => {
      posts++;
      throw businessError(
        code,
        code.endsWith('REQUIRED') || code === 'INCOMPLETE_CHAIN' ? 422 : 409,
      );
    };
    await s.controller.restore();
    if (code === 'GENERATION_IN_PROGRESS') s.resources.push(s.generation());
    await s.controller.start(s.nodeId, 'success');
    assert.equal(posts, 1);
    if (code === 'IDEMPOTENCY_CONFLICT') {
      assert.equal(s.recovery.read(s.spaceId, s.nodeId)?.blocked, true);
      await s.controller.retry(s.nodeId);
      assert.equal(posts, 1);
      const restored = createGenerationController(s.options);
      t.after(() => restored.dispose());
      await restored.restore();
      assert.equal(posts, 1);
    } else {
      assert.equal(s.storage.length, 0);
      if (code === 'GRAPH_CHANGED') assert.equal(s.conflicts.length, 1);
      if (code === 'GENERATION_IN_PROGRESS')
        assert.equal(s.controller.getGenerator(s.nodeId).status, 'processing');
    }
  });
}

test('GRAPH_CHANGED переводит даже saved coordinator в conflict и открывает explicit server reload', async (t) => {
  const s = generationSetup();
  const server = toPersistedGraph(s.editor);
  const nextETag = `"${'b'.repeat(64)}"`;
  let replaced = 0;
  const save = createGraphSaveCoordinator({
    spaceId: s.spaceId,
    initialETag: etag,
    initialRevision: 0,
    api: {
      get: async () => ({ data: server, meta: { ...meta, etag: nextETag } }),
      put: async () => {
        throw Error('PUT не нужен');
      },
    },
    captureLatest: () => ({ revision: s.editor.revision, graph: toPersistedGraph(s.editor) }),
    replaceGraph: () => {
      replaced++;
    },
  });
  t.after(() => save.dispose());
  save.reportConflict(businessError('GRAPH_CHANGED'));
  await assert.rejects(save.flush(), { code: 'GRAPH_CHANGED' });
  assert.equal(save.getState().status, 'conflict');
  assert.equal(replaced, 0);
  save.reloadServer();
  await settle();
  assert.equal(replaced, 1);
  assert.equal(await save.flush(), nextETag);
});

test('storage недоступен/повреждён → нет POST; неизвестные операции разных nodes не затираются', async (t) => {
  const s = generationSetup();
  t.after(() => s.controller.dispose());
  await s.controller.restore();
  const other = randomUUID();
  s.editor = editorReducer(s.editor, { type: 'addNode', nodeType: 'generator', id: other });
  s.api.create = async () => {
    throw networkError();
  };
  await Promise.all([
    s.controller.start(s.nodeId, 'success'),
    s.controller.start(other, 'failure'),
  ]);
  assert.equal(s.recovery.list(s.spaceId).length, 2);
  assert.notEqual(
    s.recovery.read(s.spaceId, s.nodeId)?.key,
    s.recovery.read(s.spaceId, other)?.key,
  );
  s.storage.setItem(s.storage.key(0)!, '{bad');
  const restored = createGenerationController(s.options);
  t.after(() => restored.dispose());
  await restored.restore();
  assert.equal(restored.getOverview().status, 'error');
  const unavailable = createGenerationController({
    ...s.options,
    recovery: createGenerationRecovery(() => {
      throw Error('denied');
    }),
  });
  t.after(() => unavailable.dispose());
  await unavailable.restore();
  assert.equal(unavailable.getOverview().status, 'error');
});

test('unmount во время POST abort; durable operation остаётся, late response не меняет state', async () => {
  const s = generationSetup();
  const late = deferred<ReturnType<typeof generationResponse>>();
  let signal: AbortSignal | undefined;
  s.api.create = async (_spaceId, _body, _key, value) => {
    signal = value;
    return late.promise;
  };
  await s.controller.restore();
  const task = s.controller.start(s.nodeId, 'success');
  await settle();
  s.controller.dispose();
  assert.equal(signal?.aborted, true);
  assert.equal(s.storage.length, 1);
  const before = s.controller.getGenerator(s.nodeId);
  late.resolve(generationResponse(s.generation(), 202, '1'));
  await task;
  assert.equal(s.controller.getGenerator(s.nodeId), before);
  assert.equal(s.clock.pending, 0);
  assert.equal(s.storage.length, 1);
});

test('refresh восстанавливает newer attempt B той же ноды; active poll A abort и late ответ игнорируется', async (t) => {
  const s = generationSetup();
  t.after(() => s.controller.dispose());
  const other = randomUUID();
  s.editor = editorReducer(s.editor, { type: 'addNode', nodeType: 'generator', id: other });
  const a = s.generation();
  s.resources.push(a);
  const late = deferred<ReturnType<typeof generationResponse>>();
  let signal: AbortSignal | undefined;
  s.api.get = async (_spaceId, _id, value) => {
    signal = value;
    return late.promise;
  };
  await s.controller.restore();
  s.clock.tick(500);
  assert.equal(signal?.aborted, false);
  const b = s.generation({ status: 'succeeded', imageUrl: '/assets/demo.svg' });
  s.resources.unshift(b);
  s.api.create = async () => {
    throw businessError('GENERATION_IN_PROGRESS');
  };
  await s.controller.start(other, 'success');
  assert.equal(signal?.aborted, true);
  const snapshot = s.controller.getGenerator(s.nodeId);
  late.resolve(generationResponse({ ...a, status: 'failed', failureCode: 'SIMULATED_FAILURE' }));
  await settle();
  assert.equal(s.controller.getGenerator(s.nodeId), snapshot);
  assert.equal(s.controller.getResult(s.resultNodeId), snapshot);
  assert.equal(snapshot.status, 'succeeded');
  assert.equal(s.clock.pending, 0);
});

test('поздний history GET, начатый до нового POST response, не отбирает его result', async (t) => {
  const s = generationSetup();
  t.after(() => s.controller.dispose());
  const other = randomUUID();
  s.editor = editorReducer(s.editor, { type: 'addNode', nodeType: 'generator', id: other });
  const a = s.generation({ status: 'failed', failureCode: 'SIMULATED_FAILURE' });
  s.resources.push(a);
  await s.controller.restore();
  const late = deferred<{ data: typeof s.resources; meta: typeof meta }>();
  s.api.list = async () => late.promise;
  const b = s.generation({ status: 'succeeded', imageUrl: '/assets/demo.svg' });
  s.api.create = async (_space, body) => {
    if (body.nodeId === other) throw businessError('GENERATION_IN_PROGRESS');
    return generationResponse(b, 201);
  };
  const refresh = s.controller.start(other, 'success');
  await settle();
  await s.controller.start(s.nodeId, 'success');
  const snapshot = s.controller.getResult(s.resultNodeId);
  late.resolve({ data: [a], meta });
  await refresh;
  assert.equal(s.controller.getResult(s.resultNodeId), snapshot);
  assert.equal(snapshot.status, 'succeeded');
});

test('ошибка cleanup после success сохраняет прежний ключ; Retry не становится новой попыткой', async (t) => {
  const s = generationSetup();
  t.after(() => s.controller.dispose());
  const result = s.generation({ status: 'succeeded', imageUrl: '/assets/demo.svg' });
  const keys: string[] = [];
  s.api.create = async (_space, _body, key) => {
    keys.push(key);
    return generationResponse(result, 201);
  };
  const remove = s.storage.removeItem;
  s.storage.removeItem = () => {
    throw Error('storage denied');
  };
  await s.controller.restore();
  await s.controller.start(s.nodeId, 'success');
  const view = s.controller.getGenerator(s.nodeId);
  assert.equal(view.status, 'error');
  assert.ok(view.status === 'error' && view.recovery === 'replay');
  assert.equal(s.storage.length, 1);
  s.storage.removeItem = remove;
  await s.controller.retry(s.nodeId);
  assert.deepEqual(keys, [keys[0], keys[0]]);
  assert.equal(s.storage.length, 0);
});

test('tie history error после принятого POST: Retry только GET, без нового ключа', async (t) => {
  const s = generationSetup();
  t.after(() => s.controller.dispose());
  const a = s.generation({ status: 'failed' });
  s.resources.push(a);
  await s.controller.restore();
  const b = s.generation({ createdAt: a.createdAt });
  let posts = 0;
  s.api.create = async () => {
    posts++;
    return generationResponse(b, 202, '1');
  };
  s.api.list = async () => {
    throw networkError();
  };
  await s.controller.start(s.nodeId, 'success');
  const view = s.controller.getGenerator(s.nodeId);
  assert.ok(view.status === 'error' && view.recovery === 'refresh');
  s.api.list = async () => ({ data: [b, a], meta });
  await s.controller.retry(s.nodeId);
  assert.equal(posts, 1);
  assert.equal(s.controller.getGenerator(s.nodeId).status, 'processing');
});

test('dispose controller прекращает processing poll, abort request и suppress late callback', async () => {
  const s = generationSetup();
  s.resources.push(s.generation());
  const late = deferred<ReturnType<typeof generationResponse>>();
  let signal: AbortSignal | undefined;
  s.api.get = async (_space, _id, value) => {
    signal = value;
    return late.promise;
  };
  await s.controller.restore();
  s.clock.tick(500);
  s.controller.dispose();
  assert.equal(signal?.aborted, true);
  const snapshot = s.controller.getGenerator(s.nodeId);
  late.resolve(
    generationResponse({ ...s.resources[0], status: 'succeeded', imageUrl: '/assets/demo.svg' }),
  );
  await settle();
  assert.equal(s.controller.getGenerator(s.nodeId), snapshot);
  assert.equal(s.clock.pending, 0);
});
