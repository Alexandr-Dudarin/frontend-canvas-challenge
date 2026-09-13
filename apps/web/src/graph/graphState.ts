import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';
import type { GraphData, NodeData } from '@canvas/contracts';
import { canConnect, type ConnectionCandidate } from './connectionRules';
import {
  createNode,
  fromPersistedGraph,
  MAX_NODES,
  MAX_PROMPT_LENGTH,
  NODE_EXTENT,
  samePersistedNode,
  samePersistedEdge,
  type CanvasGraph,
  type CanvasNode,
} from './graphModel';

export type EditorState = CanvasGraph & { revision: number };
export type EditorAction =
  | { type: 'replaceFromServer'; state: EditorState }
  | { type: 'nodesChanged'; changes: NodeChange<CanvasNode>[] }
  | { type: 'edgesChanged'; changes: EdgeChange[] }
  | { type: 'addNode'; nodeType: NodeData['type']; id: string }
  | { type: 'deleteNodes'; ids: ReadonlySet<string> }
  | { type: 'editPrompt'; id: string; text: string }
  | { type: 'connect'; connection: ConnectionCandidate; id: string }
  | { type: 'viewportChanged'; viewport: GraphData['viewport'] };

export function initialEditorState(graph: GraphData, revision = 0): EditorState {
  return { ...fromPersistedGraph(graph), revision };
}

function withoutIncidentEdges(edges: CanvasGraph['edges'], ids: ReadonlySet<string>) {
  if (!ids.size) return edges;
  const remaining = edges.filter((edge) => !ids.has(edge.source) && !ids.has(edge.target));
  return remaining.length === edges.length ? edges : remaining;
}

export function deleteNodes(state: EditorState, ids: ReadonlySet<string>): EditorState {
  const nodes = state.nodes.filter((node) => !ids.has(node.id));
  const edges = withoutIncidentEdges(state.edges, ids);
  if (nodes.length === state.nodes.length && edges === state.edges) return state;
  return { ...state, nodes, edges, revision: state.revision + 1 };
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'replaceFromServer':
      return action.state;
    case 'nodesChanged': {
      if (!action.changes.length) return state;
      let removed: Set<string> | undefined;
      let changed = false;
      for (const change of action.changes) {
        if (change.type === 'remove') (removed ??= new Set()).add(change.id);
        if (
          change.type === 'add' ||
          change.type === 'replace' ||
          change.type === 'remove' ||
          (change.type === 'position' && change.position)
        )
          changed = true;
      }
      const nodes = applyNodeChanges(action.changes, state.nodes);
      const edges = removed ? withoutIncidentEdges(state.edges, removed) : state.edges;
      // Проверяем только кандидатов на постоянную правку; service-only события не сравнивают граф.
      const persistedChange =
        changed &&
        (nodes.length !== state.nodes.length ||
          nodes.some(
            (node, index) =>
              node !== state.nodes[index] && !samePersistedNode(node, state.nodes[index]),
          ));
      return {
        ...state,
        nodes,
        edges,
        revision: state.revision + (persistedChange || edges !== state.edges ? 1 : 0),
      };
    }
    case 'edgesChanged': {
      if (!action.changes.length) return state;
      const edges = applyEdgeChanges(action.changes, state.edges);
      const persistedChange =
        action.changes.some((change) => change.type !== 'select') &&
        (edges.length !== state.edges.length ||
          edges.some(
            (edge, index) =>
              edge !== state.edges[index] && !samePersistedEdge(edge, state.edges[index]),
          ));
      return { ...state, edges, revision: state.revision + (persistedChange ? 1 : 0) };
    }
    case 'addNode': {
      if (state.nodes.length >= MAX_NODES || state.nodes.some((n) => n.id === action.id))
        return state;
      const offset = state.nodes.length % 6;
      const position = {
        x: Math.max(
          NODE_EXTENT[0][0],
          Math.min(
            NODE_EXTENT[1][0],
            (40 - state.viewport.x) / state.viewport.zoom + (offset % 3) * 300,
          ),
        ),
        y: Math.max(
          NODE_EXTENT[0][1],
          Math.min(
            NODE_EXTENT[1][1],
            (40 - state.viewport.y) / state.viewport.zoom + Math.floor(offset / 3) * 260,
          ),
        ),
      };
      return {
        ...state,
        nodes: [...state.nodes, createNode(action.nodeType, action.id, position)],
        revision: state.revision + 1,
      };
    }
    case 'deleteNodes':
      return deleteNodes(state, action.ids);
    case 'editPrompt': {
      const index = state.nodes.findIndex((node) => node.id === action.id);
      const node = state.nodes[index];
      const text = action.text.slice(0, MAX_PROMPT_LENGTH);
      if (!node || node.type !== 'prompt' || node.data.text === text) return state;
      // Один поиск, одна копия массива; остальные node objects и все edges сохраняют ссылки.
      const nodes = state.nodes.slice();
      nodes[index] = { ...node, data: { text } };
      return { ...state, nodes, revision: state.revision + 1 };
    }
    case 'connect':
      // Повторная проверка использует текущее состояние reducer, даже при двух быстрых событиях.
      if (
        !canConnect(action.connection, state.nodes, state.edges) ||
        state.edges.some((edge) => edge.id === action.id)
      )
        return state;
      return {
        ...state,
        edges: [
          ...state.edges,
          {
            id: action.id,
            source: action.connection.source!,
            target: action.connection.target!,
          },
        ],
        revision: state.revision + 1,
      };
    case 'viewportChanged':
      if (
        state.viewport.x === action.viewport.x &&
        state.viewport.y === action.viewport.y &&
        state.viewport.zoom === action.viewport.zoom
      )
        return state;
      return { ...state, viewport: action.viewport, revision: state.revision + 1 };
  }
}
