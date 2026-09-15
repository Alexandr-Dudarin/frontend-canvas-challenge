import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GraphData } from '@canvas/contracts';
import { ApiRequestError } from '../src/api/apiError';
import type { GraphApi, GraphResponse } from '../src/api/graphApi';
import { editorReducer, initialEditorState, type EditorAction } from '../src/graph/graphState';
import { toPersistedGraph } from '../src/graph/graphModel';
import { createGraphSaveCoordinator, type ScheduleAfter } from '../src/save/graphSaveCoordinator';
import { etag, graphFixture, meta } from './fixtures';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function clockFixture() {
  let now = 0;
  let nextId = 0;
  const tasks = new Map<number, { at: number; callback: () => void }>();
  const scheduleAfter: ScheduleAfter = (callback, delayMs) => {
    const id = nextId++;
    tasks.set(id, { at: now + delayMs, callback });
    return () => {
      tasks.delete(id);
    };
  };
  return {
    scheduleAfter,
    get pending() {
      return tasks.size;
    },
    tick(ms: number) {
      const until = now + ms;
      for (;;) {
        const next = [...tasks].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        now = next[1].at;
        tasks.delete(next[0]);
        next[1].callback();
      }
      now = until;
    },
  };
}

// Таймеры ручные; микрозадачи дают завершиться цепочке async API/coordinator без реальных пауз.
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
const nextETag = (letter: string) => `"${letter.repeat(64)}"`;
const response = (data: GraphData, value = nextETag('b')): GraphResponse => ({
  data,
  meta: { ...meta, etag: value },
});
const networkError = () => new ApiRequestError('Соединение потеряно.', 'network', 'NETWORK_ERROR');
const conflictError = () =>
  new ApiRequestError('Граф изменился.', 'http', 'GRAPH_VERSION_CONFLICT', {
    ...meta,
    status: 412,
  });

function setup() {
  let editor = initialEditorState(graphFixture());
  const clock = clockFixture();
  let captures = 0;
  const puts: {
    graph: GraphData;
    etag: string;
    signal?: AbortSignal;
    result: ReturnType<typeof deferred<GraphResponse>>;
  }[] = [];
  const gets: { signal?: AbortSignal; result: ReturnType<typeof deferred<GraphResponse>> }[] = [];
  const api: GraphApi = {
    put: async (spaceId, graph, version, signal) => {
      assert.equal(spaceId, 'test-space');
      const result = deferred<GraphResponse>();
      puts.push({ graph, etag: version, signal, result });
      return result.promise;
    },
    get: async (spaceId, signal) => {
      assert.equal(spaceId, 'test-space');
      const result = deferred<GraphResponse>();
      gets.push({ signal, result });
      return result.promise;
    },
  };
  const coordinator = createGraphSaveCoordinator({
    spaceId: 'test-space',
    initialETag: etag,
    initialRevision: 0,
    api,
    scheduleAfter: clock.scheduleAfter,
    captureLatest: () => {
      captures++;
      return { revision: editor.revision, graph: toPersistedGraph(editor) };
    },
    replaceGraph: (graph, revision) => {
      editor = editorReducer(editor, {
        type: 'replaceFromServer',
        state: initialEditorState(graph, revision),
      });
    },
  });
  function dispatch(action: EditorAction) {
    editor = editorReducer(editor, action);
    coordinator.schedule(editor.revision);
  }
  return {
    coordinator,
    clock,
    puts,
    gets,
    dispatch,
    get editor() {
      return editor;
    },
    get captures() {
      return captures;
    },
    edit(text: string) {
      dispatch({ type: 'editPrompt', id: editor.nodes[0].id, text });
    },
    async accept(index: number, version = nextETag('b')) {
      puts[index].result.resolve(response(puts[index].graph, version));
      await settle();
    },
  };
}

test('быстрый ввод <500 ms: serialization откладывается, один PUT latest после quiet', async () => {
  const h = setup();
  h.edit('Г');
  h.clock.tick(300);
  h.edit('Го');
  h.clock.tick(300);
  h.edit('Горы ночью');
  h.clock.tick(499);
  assert.equal(h.captures, 0);
  assert.equal(h.puts.length, 0);
  assert.equal(h.coordinator.getState().status, 'dirty');
  h.clock.tick(1);
  assert.equal(h.captures, 1);
  assert.equal(h.puts.length, 1);
  assert.deepEqual(h.puts[0].graph.nodes[0].data, { text: 'Горы ночью' });
  await h.accept(0);
  assert.equal(h.coordinator.getState().status, 'saved');
  assert.equal(h.coordinator.getState().savedRevision, 3);
});

test('drag-like burst: один PUT; одинаковая position и dragging-only не продлевают debounce', async () => {
  const h = setup();
  const id = h.editor.nodes[0].id;
  for (let x = 1; x <= 30; x++) {
    h.dispatch({
      type: 'nodesChanged',
      changes: [{ type: 'position', id, position: { x, y: 10 }, dragging: true }],
    });
    h.clock.tick(10);
  }
  const revision = h.editor.revision;
  h.dispatch({
    type: 'nodesChanged',
    changes: [{ type: 'position', id, position: { x: 30, y: 10 }, dragging: false }],
  });
  assert.equal(h.editor.revision, revision);
  h.clock.tick(489);
  assert.equal(h.captures, 0);
  h.clock.tick(1);
  assert.equal(h.puts.length, 1);
  assert.deepEqual(h.puts[0].graph.nodes[0].position, { x: 30, y: 10 });
  await h.accept(0);
});

test('selection, dimensions, dragging-only, service replace и no-op remove не вызывают PUT', () => {
  const h = setup();
  const id = h.editor.nodes[0].id;
  h.dispatch({
    type: 'nodesChanged',
    changes: [
      { type: 'select', id, selected: true },
      { type: 'dimensions', id, dimensions: { width: 260, height: 200 } },
      { type: 'position', id, dragging: true },
      { type: 'remove', id: 'missing' },
    ],
  });
  h.dispatch({
    type: 'nodesChanged',
    changes: [{ type: 'replace', id, item: { ...h.editor.nodes[0], selected: false } }],
  });
  h.dispatch({
    type: 'edgesChanged',
    changes: [{ type: 'select', id: h.editor.edges[0].id, selected: true }],
  });
  h.clock.tick(2000);
  assert.equal(h.editor.revision, 0);
  assert.equal(h.puts.length, 0);
  assert.equal(h.captures, 0);
});

test('in-flight snapshot неизменен, очередь хранит latest; PUT не перекрываются, ETag A → B → C', async () => {
  const h = setup();
  h.edit('Первый');
  h.clock.tick(500);
  const attempted = structuredClone(h.puts[0].graph);
  h.edit('Второй');
  h.clock.tick(500);
  h.edit('Последний');
  h.clock.tick(500);
  assert.equal(h.puts.length, 1);
  assert.deepEqual(h.puts[0].graph, attempted);
  assert.equal(h.puts[0].etag, etag);
  const local = h.editor;
  await h.accept(0, nextETag('b'));
  assert.equal(h.editor, local);
  assert.equal(h.puts.length, 2);
  assert.deepEqual(h.puts[1].graph.nodes[0].data, { text: 'Последний' });
  assert.equal(h.puts[1].etag, nextETag('b'));
  assert.equal(h.coordinator.getState().savedRevision, 1);
  assert.equal(h.coordinator.getState().revision, 3);
  assert.equal(h.coordinator.getState().status, 'saving');
  await h.accept(1, nextETag('c'));
  assert.equal(h.coordinator.getState().etag, nextETag('c'));
  assert.equal(h.coordinator.getState().savedRevision, 3);
  assert.equal(h.coordinator.getState().status, 'saved');
});

test('old response до нового debounce оставляет dirty и не откатывает local graph', async () => {
  const h = setup();
  h.edit('Снимок');
  h.clock.tick(500);
  h.edit('Новая правка');
  const local = h.editor;
  await h.accept(0);
  assert.equal(h.editor, local);
  assert.equal(h.coordinator.getState().status, 'dirty');
  assert.equal(h.coordinator.getState().savedRevision, 1);
  h.clock.tick(500);
  await h.accept(1);
  assert.equal(h.coordinator.getState().status, 'saved');
});

test('flush отменяет debounce, повторный flush одной revision делит PUT и ждёт confirmation', async () => {
  const h = setup();
  h.edit('Сразу сохранить');
  let resolved = false;
  const first = h.coordinator.flush().then((tag) => {
    resolved = true;
    return tag;
  });
  const second = h.coordinator.flush();
  assert.equal(h.clock.pending, 0);
  assert.equal(h.puts.length, 1);
  assert.equal(h.captures, 1);
  await settle();
  assert.equal(resolved, false);
  await h.accept(0);
  assert.equal(await first, nextETag('b'));
  assert.equal(await second, nextETag('b'));
  assert.equal(await h.coordinator.flush(), nextETag('b'));
  assert.equal(h.puts.length, 1);
});

test('flush во время PUT ждёт current + latest queued и возвращает ETag подтверждённой target revision', async () => {
  const h = setup();
  h.edit('Один');
  h.clock.tick(500);
  h.edit('Два');
  let done = false;
  const completion = h.coordinator.flush().then((tag) => {
    done = true;
    return tag;
  });
  assert.equal(h.puts.length, 1);
  await h.accept(0);
  assert.equal(done, false);
  assert.equal(h.puts[1].etag, nextETag('b'));
  await h.accept(1, nextETag('c'));
  assert.equal(await completion, nextETag('c'));
});

test('412: flush rejected, draft сохранён, edits/Retry не запускают автоматический PUT', async () => {
  const h = setup();
  h.edit('Мой draft');
  const rejected = assert.rejects(h.coordinator.flush(), { code: 'GRAPH_VERSION_CONFLICT' });
  const local = h.editor;
  h.puts[0].result.reject(conflictError());
  await rejected;
  await settle();
  assert.equal(h.editor, local);
  assert.equal(h.coordinator.getState().status, 'conflict');
  h.edit('Ещё локальная правка');
  h.clock.tick(10000);
  h.coordinator.retry();
  await assert.rejects(h.coordinator.flush(), { code: 'GRAPH_VERSION_CONFLICT' });
  assert.equal(h.puts.length, 1);
  assert.equal(h.gets.length, 0);
});

test('explicit reload-server заменяет graph/new ETag и baseline; следующий PUT использует новую версию', async () => {
  const h = setup();
  h.edit('Локально');
  h.clock.tick(500);
  h.puts[0].result.reject(conflictError());
  await settle();
  h.coordinator.reloadServer();
  h.coordinator.reloadServer();
  assert.equal(h.gets.length, 1);
  const server = graphFixture();
  h.gets[0].result.resolve(response(server, nextETag('d')));
  await settle();
  assert.deepEqual(toPersistedGraph(h.editor), server);
  assert.equal(h.coordinator.getState().savedRevision, h.editor.revision);
  assert.equal(h.coordinator.getState().status, 'saved');
  h.coordinator.schedule(h.editor.revision);
  h.clock.tick(1000);
  assert.equal(h.puts.length, 1);
  h.edit('После загрузки');
  h.clock.tick(500);
  assert.equal(h.puts[1].etag, nextETag('d'));
  await h.accept(1);
});

test('правки во время explicit reload не затираются поздним GET', async () => {
  const h = setup();
  h.edit('Локально');
  h.clock.tick(500);
  h.puts[0].result.reject(conflictError());
  await settle();
  h.coordinator.reloadServer();
  h.edit('Введено во время GET');
  const local = h.editor;
  h.gets[0].result.resolve(response(graphFixture()));
  await settle();
  assert.equal(h.editor, local);
  assert.equal(h.coordinator.getState().status, 'conflict');
  h.clock.tick(1000);
  assert.equal(h.puts.length, 1);
});

test('lost PUT + GET same: commit accepted, newer queued сохраняется с GET ETag', async () => {
  const h = setup();
  h.edit('Уже на сервере');
  h.clock.tick(500);
  h.edit('Новее');
  h.clock.tick(500);
  h.puts[0].result.reject(networkError());
  await settle();
  assert.equal(h.gets.length, 1);
  assert.equal(h.puts.length, 1);
  h.gets[0].result.resolve(response(h.puts[0].graph, nextETag('c')));
  await settle();
  assert.equal(h.puts.length, 2);
  assert.equal(h.puts[1].etag, nextETag('c'));
  assert.equal(h.coordinator.getState().savedRevision, 1);
  await h.accept(1, nextETag('d'));
  assert.equal(h.coordinator.getState().status, 'saved');
});

test('lost PUT + GET different: explicit conflict, без blind replay и потери draft', async () => {
  const h = setup();
  h.edit('Мой draft');
  h.clock.tick(500);
  h.puts[0].result.reject(networkError());
  await settle();
  const local = h.editor;
  h.gets[0].result.resolve(response(graphFixture()));
  await settle();
  assert.equal(h.coordinator.getState().status, 'conflict');
  assert.equal(h.editor, local);
  assert.equal(h.coordinator.getState().savedRevision, 0);
  h.clock.tick(10000);
  assert.equal(h.puts.length, 1);
});

test('reconciliation GET failure: Retry начинает с GET, сохраняет attempted и правки из error state', async () => {
  const h = setup();
  h.edit('Attempted');
  const rejected = assert.rejects(h.coordinator.flush(), { code: 'NETWORK_ERROR' });
  h.puts[0].result.reject(networkError());
  await settle();
  h.gets[0].result.reject(networkError());
  await rejected;
  await settle();
  assert.equal(h.coordinator.getState().status, 'error');
  h.edit('Введено при error');
  h.clock.tick(10000);
  assert.equal(h.captures, 1);
  h.coordinator.retry();
  h.coordinator.retry();
  assert.equal(h.gets.length, 2);
  assert.equal(h.puts.length, 1);
  h.gets[1].result.resolve(response(h.puts[0].graph, nextETag('c')));
  await settle();
  assert.equal(h.puts[1].etag, nextETag('c'));
  assert.deepEqual(h.puts[1].graph.nodes[0].data, { text: 'Введено при error' });
  await h.accept(1);
  assert.equal(h.coordinator.getState().status, 'saved');
});

test('5xx, 408 и invalid-response после PUT также требуют reconciliation', async () => {
  for (const error of [
    new ApiRequestError('Server', 'http', 'INTERNAL_ERROR', { ...meta, status: 500 }),
    new ApiRequestError('Timeout', 'http', 'HTTP_ERROR', { ...meta, status: 408 }),
    new ApiRequestError('JSON', 'invalid-response', 'INVALID_RESPONSE', meta),
  ]) {
    const h = setup();
    h.edit('Текст');
    h.clock.tick(500);
    h.puts[0].result.reject(error);
    await settle();
    assert.equal(h.gets.length, 1);
    h.gets[0].result.resolve(response(h.puts[0].graph));
    await settle();
    assert.equal(h.coordinator.getState().status, 'saved');
  }
});

test('definite 422: no auto retry; explicit Retry отправляет исправленный latest graph', async () => {
  const h = setup();
  h.edit('Отклонённый');
  h.clock.tick(500);
  h.puts[0].result.reject(
    new ApiRequestError('Invalid', 'http', 'INVALID_GRAPH', { ...meta, status: 422 }),
  );
  await settle();
  h.edit('Исправленный');
  h.clock.tick(500);
  assert.equal(h.gets.length, 0);
  assert.equal(h.puts.length, 1);
  h.coordinator.retry();
  assert.equal(h.puts[1].etag, etag);
  assert.deepEqual(h.puts[1].graph.nodes[0].data, { text: 'Исправленный' });
  await h.accept(1);
  assert.equal(h.coordinator.getState().status, 'saved');
});

test('reload GET failure оставляет draft, его Retry повторяет GET', async () => {
  const h = setup();
  h.edit('Local');
  h.clock.tick(500);
  h.puts[0].result.reject(conflictError());
  await settle();
  const local = h.editor;
  h.coordinator.reloadServer();
  h.gets[0].result.reject(networkError());
  await settle();
  assert.equal(h.editor, local);
  assert.equal(h.coordinator.getState().status, 'error');
  h.coordinator.retry();
  assert.equal(h.gets.length, 2);
  assert.equal(h.puts.length, 1);
  h.gets[1].result.resolve(response(graphFixture()));
  await settle();
  assert.equal(h.coordinator.getState().status, 'saved');
});

test('dispose отменяет debounce/request, отклоняет flush и игнорирует поздний response', async () => {
  const pending = setup();
  pending.edit('Не отправлять');
  pending.coordinator.dispose();
  pending.clock.tick(1000);
  assert.equal(pending.puts.length, 0);
  const h = setup();
  h.edit('In-flight');
  const rejected = assert.rejects(h.coordinator.flush(), { code: 'SAVE_CANCELLED' });
  h.coordinator.dispose();
  await rejected;
  assert.equal(h.puts[0].signal?.aborted, true);
  await h.accept(0);
  assert.equal(h.coordinator.getState().savedRevision, 0);
  assert.equal(h.gets.length, 0);
  await assert.rejects(h.coordinator.flush(), { code: 'SAVE_CANCELLED' });
});

test('dispose во время reload не заменяет редактор поздним GET', async () => {
  const h = setup();
  h.edit('Local');
  h.clock.tick(500);
  h.puts[0].result.reject(conflictError());
  await settle();
  h.coordinator.reloadServer();
  const local = h.editor;
  h.coordinator.dispose();
  assert.equal(h.gets[0].signal?.aborted, true);
  h.gets[0].result.resolve(response(graphFixture()));
  await settle();
  assert.equal(h.editor, local);
});
