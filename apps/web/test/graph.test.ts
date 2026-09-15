import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { canConnect } from '../src/graph/connectionRules';
import {
  createNode,
  fromPersistedGraph,
  MAX_EDGES,
  MAX_NODES,
  MAX_PROMPT_LENGTH,
  toPersistedGraph,
  samePersistedGraph,
} from '../src/graph/graphModel';
import { deleteNodes, editorReducer, initialEditorState } from '../src/graph/graphState';
import { isGraph } from '../src/api/responseSchemas';
import { graphFixture } from './fixtures';

test('все 9 пар типов: только prompt → generator и generator → result', () => {
  const { nodes } = graphFixture();
  for (const source of nodes)
    for (const target of nodes) {
      const expected =
        (source.type === 'prompt' && target.type === 'generator') ||
        (source.type === 'generator' && target.type === 'result');
      assert.equal(canConnect({ source: source.id, target: target.id }, nodes, []), expected);
    }
});

test('правила отклоняют отсутствующие endpoints, неизвестные handles, повторный вход и выход', () => {
  const graph = graphFixture();
  const [p, g, r] = graph.nodes;
  const connect = { source: p.id, target: g.id };
  assert.equal(canConnect(connect, graph.nodes, graph.edges), false);
  assert.equal(canConnect({ ...connect, source: randomUUID() }, graph.nodes, []), false);
  assert.equal(canConnect({ ...connect, target: null }, graph.nodes, []), false);
  assert.equal(canConnect({ ...connect, target: randomUUID() }, graph.nodes, []), false);
  assert.equal(canConnect({ ...connect, sourceHandle: 'fake' }, graph.nodes, []), false);
  assert.equal(canConnect({ ...connect, targetHandle: 'fake' }, graph.nodes, []), false);
  assert.equal(
    canConnect({ ...connect, sourceHandle: null, targetHandle: null }, graph.nodes, []),
    true,
  );
  const anotherResult = createNode('result', randomUUID(), { x: 0, y: 100 });
  assert.equal(
    canConnect(
      { source: g.id, target: anotherResult.id },
      [...graph.nodes, anotherResult],
      graph.edges,
    ),
    false,
  );
  const anotherGenerator = createNode('generator', randomUUID(), { x: 0, y: 200 });
  assert.equal(
    canConnect(
      { source: anotherGenerator.id, target: r.id },
      [...graph.nodes, anotherGenerator],
      graph.edges,
    ),
    false,
  );
  assert.equal(
    canConnect(
      { source: p.id, target: anotherGenerator.id },
      [...graph.nodes, anotherGenerator],
      graph.edges,
    ),
    true,
  );
  assert.equal(
    canConnect(
      connect,
      graph.nodes,
      Array.from({ length: MAX_EDGES }, () => ({ source: 'other', target: 'other' })),
    ),
    false,
  );
});

test('reducer повторно проверяет соединение по последнему state при быстрых событиях', () => {
  const graph = graphFixture();
  const state = initialEditorState({ ...graph, edges: [] });
  const connection = graph.edges[0];
  const next = editorReducer(state, { type: 'connect', connection, id: randomUUID() });
  assert.equal(next.edges.length, 1);
  assert.equal(next.nodes, state.nodes);
  assert.equal(editorReducer(next, { type: 'connect', connection, id: randomUUID() }), next);
  const removed = deleteNodes(state, new Set([connection.target]));
  assert.equal(editorReducer(removed, { type: 'connect', connection, id: randomUUID() }), removed);
});

test('удаление одной или нескольких нод убирает incident edges и сохраняет остальные ссылки', () => {
  const state = initialEditorState(graphFixture());
  const [p, g, r] = state.nodes;
  const next = deleteNodes(state, new Set([p.id]));
  assert.deepEqual(next.nodes, [g, r]);
  assert.equal(next.nodes[0], g);
  assert.deepEqual(next.edges, [state.edges[1]]);
  assert.equal(next.edges[0], state.edges[1]);
  assert.equal(next.viewport, state.viewport);
  assert.equal(next.revision, 1);
  const empty = deleteNodes(state, new Set([p.id, g.id, r.id]));
  assert.equal(empty.nodes.length, 0);
  assert.equal(empty.edges.length, 0);
  assert.equal(deleteNodes(state, new Set(['missing'])), state);
  const viaReactFlow = editorReducer(state, {
    type: 'nodesChanged',
    changes: [{ type: 'remove', id: g.id }],
  });
  assert.equal(viaReactFlow.edges.length, 0);
  assert.deepEqual(viaReactFlow.nodes, [p, r]);
});

test('редактирование prompt и движение меняют только нужную ноду, без дырок и обхода edges', () => {
  const state = initialEditorState(graphFixture());
  const id = state.nodes[0].id;
  const typed = editorReducer(state, { type: 'editPrompt', id, text: 'Новый текст' });
  assert.deepEqual(typed.nodes[0].data, { text: 'Новый текст' });
  assert.equal(typed.nodes[1], state.nodes[1]);
  assert.equal(typed.nodes[2], state.nodes[2]);
  assert.equal(typed.edges, state.edges);
  assert.equal(editorReducer(typed, { type: 'editPrompt', id, text: 'Новый текст' }), typed);
  const moved = editorReducer(typed, {
    type: 'nodesChanged',
    changes: [{ type: 'position', id, position: { x: 80, y: 120 }, dragging: true }],
  });
  assert.deepEqual(moved.nodes[0].position, { x: 80, y: 120 });
  assert.equal(moved.nodes[1], state.nodes[1]);
  assert.equal(moved.edges, state.edges);
  assert.deepEqual(Object.keys(moved.nodes), ['0', '1', '2']);
  const limited = editorReducer(state, {
    type: 'editPrompt',
    id,
    text: 'a'.repeat(MAX_PROMPT_LENGTH + 1),
  });
  assert.ok(isGraph(toPersistedGraph(limited)));
});

test('измерение и выделение не помечают граф изменённым, viewport хранится отдельно', () => {
  const state = initialEditorState(graphFixture());
  const selected = editorReducer(state, {
    type: 'nodesChanged',
    changes: [
      { type: 'select', id: state.nodes[0].id, selected: true },
      { type: 'dimensions', id: state.nodes[0].id, dimensions: { width: 260, height: 200 } },
    ],
  });
  assert.equal(selected.revision, 0);
  const viewport = { x: 110, y: 90, zoom: 1.5 };
  const moved = editorReducer(selected, { type: 'viewportChanged', viewport });
  assert.equal(moved.nodes, selected.nodes);
  assert.equal(moved.edges, selected.edges);
  assert.deepEqual(toPersistedGraph(moved).viewport, viewport);
  assert.equal(editorReducer(moved, { type: 'viewportChanged', viewport: { ...viewport } }), moved);
});

test('новые ноды имеют валидные UUID/данные; лимит 20 и уникальность соблюдены', () => {
  let state = initialEditorState({ nodes: [], edges: [], viewport: { x: -50, y: 0, zoom: 1 } });
  for (let i = 0; i < MAX_NODES; i++) {
    state = editorReducer(state, {
      type: 'addNode',
      nodeType: (['prompt', 'generator', 'result'] as const)[i % 3],
      id: randomUUID(),
    });
  }
  assert.ok(isGraph(toPersistedGraph(state)));
  assert.equal(new Set(state.nodes.map((node) => node.id)).size, MAX_NODES);
  assert.equal(
    editorReducer(state, { type: 'addNode', nodeType: 'prompt', id: randomUUID() }),
    state,
  );
  const small = initialEditorState(graphFixture());
  assert.equal(
    editorReducer(small, { type: 'addNode', nodeType: 'prompt', id: small.nodes[0].id }),
    small,
  );
});

test('serialization перечисляет поля contract и не пропускает служебные/nested поля React Flow', () => {
  const graph = graphFixture();
  const flow = fromPersistedGraph(graph);
  const before = structuredClone(graph);
  Object.assign(flow.nodes[0], {
    selected: true,
    dragging: true,
    measured: { width: 260, height: 200 },
    width: 260,
    parentId: 'ui-only',
  });
  Object.assign(flow.nodes[0].data, { onChange: () => {}, uiOnly: 'extra' });
  Object.assign(flow.nodes[0].position, { z: 1 });
  Object.assign(flow.edges[0], {
    selected: true,
    sourceHandle: 'ui',
    targetHandle: 'ui',
    animated: true,
  });
  Object.assign(flow.viewport, { callback: () => {} });
  const snapshot = toPersistedGraph(flow);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(graph, before);
  assert.ok(isGraph(snapshot));
  assert.notEqual(snapshot.nodes[0].data, flow.nodes[0].data);
  assert.notEqual(snapshot.edges[0], flow.edges[0]);
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), before);
});

test('revision увеличивается только при реальной persisted правке, service-only и no-op её сохраняют', () => {
  const initial = initialEditorState(graphFixture());
  let state = editorReducer(initial, {
    type: 'nodesChanged',
    changes: [
      {
        type: 'position',
        id: initial.nodes[0].id,
        position: { ...initial.nodes[0].position },
        dragging: false,
      },
    ],
  });
  assert.equal(state.revision, 0);
  state = editorReducer(state, {
    type: 'edgesChanged',
    changes: [{ type: 'remove', id: state.edges[0].id }],
  });
  assert.equal(state.revision, 1);
  state = editorReducer(state, {
    type: 'edgesChanged',
    changes: [{ type: 'remove', id: 'missing' }],
  });
  assert.equal(state.revision, 1);
  state = editorReducer(state, { type: 'connect', connection: initial.edges[0], id: randomUUID() });
  assert.equal(state.revision, 2);
  state = editorReducer(state, { type: 'addNode', nodeType: 'result', id: randomUUID() });
  assert.equal(state.revision, 3);
  state = editorReducer(state, { type: 'deleteNodes', ids: new Set([state.nodes[3].id]) });
  assert.equal(state.revision, 4);
  state = editorReducer(state, { type: 'viewportChanged', viewport: { x: 1, y: 2, zoom: 2 } });
  assert.equal(state.revision, 5);
  const replacement = initialEditorState(graphFixture(), 6);
  assert.equal(
    editorReducer(state, { type: 'replaceFromServer', state: replacement }),
    replacement,
  );
});

test('persisted equality сравнивает каждое contract field, игнорирует UI/порядок ключей, учитывает порядок массивов', () => {
  const graph = graphFixture();
  const ui = fromPersistedGraph(graph);
  Object.assign(ui.nodes[0], { selected: true, measured: { width: 100, height: 200 } });
  assert.equal(samePersistedGraph(graph, ui), true);
  const mutations: ((copy: typeof graph) => void)[] = [
    (g) => {
      g.nodes[0].id = randomUUID();
    },
    (g) => {
      g.nodes[1].type = 'result';
    },
    (g) => {
      g.nodes[0].position.x++;
    },
    (g) => {
      g.nodes[0].position.y++;
    },
    (g) => {
      if (g.nodes[0].type === 'prompt') g.nodes[0].data.text += '!';
    },
    (g) => {
      if (g.nodes[1].type !== 'prompt') g.nodes[1].data.label += '!';
    },
    (g) => {
      g.edges[0].id = randomUUID();
    },
    (g) => {
      g.edges[0].source = randomUUID();
    },
    (g) => {
      g.edges[0].target = randomUUID();
    },
    (g) => {
      g.viewport.x++;
    },
    (g) => {
      g.viewport.y++;
    },
    (g) => {
      g.viewport.zoom++;
    },
    (g) => {
      g.nodes.pop();
    },
    (g) => {
      g.edges.pop();
    },
    (g) => {
      g.nodes.reverse();
    },
    (g) => {
      g.edges.reverse();
    },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(graph);
    mutate(copy);
    assert.equal(samePersistedGraph(graph, copy), false);
  }
  assert.equal(
    samePersistedGraph(graph, { viewport: graph.viewport, edges: graph.edges, nodes: graph.nodes }),
    true,
  );
});
