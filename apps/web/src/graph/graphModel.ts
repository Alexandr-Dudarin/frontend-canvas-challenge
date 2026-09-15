import { Graph, Node as NodeSchema, type GraphData, type NodeData } from '@canvas/contracts';
import type { CoordinateExtent, Edge, Node } from '@xyflow/react';

export type PromptNode = Node<Extract<NodeData, { type: 'prompt' }>['data'], 'prompt'>;
export type GeneratorNode = Node<Extract<NodeData, { type: 'generator' }>['data'], 'generator'>;
export type ResultNode = Node<Extract<NodeData, { type: 'result' }>['data'], 'result'>;
export type CanvasNode = PromptNode | GeneratorNode | ResultNode;
export type CanvasGraph = {
  nodes: CanvasNode[];
  edges: Edge[];
  viewport: GraphData['viewport'];
};

// Значения взяты из официальных схем, а не из отдельной копии ограничений API.
export const MAX_NODES = Graph.properties.nodes.maxItems!;
export const MAX_EDGES = Graph.properties.edges.maxItems!;
export const MAX_PROMPT_LENGTH = NodeSchema.anyOf[0].properties.data.properties.text.maxLength!;
export const MIN_ZOOM = Graph.properties.viewport.properties.zoom.minimum!;
export const MAX_ZOOM = Graph.properties.viewport.properties.zoom.maximum!;
const positionSchema = NodeSchema.anyOf[0].properties.position.properties;
export const NODE_EXTENT: CoordinateExtent = [
  [positionSchema.x.minimum!, positionSchema.y.minimum!],
  [positionSchema.x.maximum!, positionSchema.y.maximum!],
];
export const NODE_TITLES = { prompt: 'Текст', generator: 'Генератор', result: 'Результат' };

function persistedNode(node: CanvasNode): NodeData {
  const position = { x: node.position.x, y: node.position.y };
  switch (node.type) {
    case 'prompt':
      return { id: node.id, type: node.type, position, data: { text: node.data.text } };
    case 'generator':
    case 'result':
      return { id: node.id, type: node.type, position, data: { label: node.data.label } };
  }
}

// Явный список полей исключает selected, measured, handles, callbacks и другие поля UI.
// Снимок создаётся по запросу; ввод и перетаскивание его не вызывают.
export function toPersistedGraph(graph: CanvasGraph): GraphData {
  return {
    nodes: graph.nodes.map(persistedNode),
    edges: graph.edges.map((edge) => ({ id: edge.id, source: edge.source, target: edge.target })),
    viewport: { x: graph.viewport.x, y: graph.viewport.y, zoom: graph.viewport.zoom },
  };
}

export function fromPersistedGraph(graph: GraphData): CanvasGraph {
  // Отделяем редактируемые объекты от ресурса, полученного через API.
  return toPersistedGraph(graph);
}

export function samePersistedNode(a: NodeData, b: NodeData): boolean {
  if (
    a.id !== b.id ||
    a.type !== b.type ||
    a.position.x !== b.position.x ||
    a.position.y !== b.position.y
  )
    return false;
  if (a.type === 'prompt' && b.type === 'prompt') return a.data.text === b.data.text;
  return a.type !== 'prompt' && b.type !== 'prompt' && a.data.label === b.data.label;
}

export function samePersistedEdge(
  a: GraphData['edges'][number],
  b: GraphData['edges'][number],
): boolean {
  return a.id === b.id && a.source === b.source && a.target === b.target;
}

// Только аварийная сверка после неизвестного PUT. Порядок массивов — часть представления.
// O(N + E), без stringify, сортировки и промежуточных коллекций.
export function samePersistedGraph(a: GraphData, b: GraphData): boolean {
  if (
    a.nodes.length !== b.nodes.length ||
    a.edges.length !== b.edges.length ||
    a.viewport.x !== b.viewport.x ||
    a.viewport.y !== b.viewport.y ||
    a.viewport.zoom !== b.viewport.zoom
  )
    return false;
  for (let i = 0; i < a.nodes.length; i++)
    if (!samePersistedNode(a.nodes[i], b.nodes[i])) return false;
  for (let i = 0; i < a.edges.length; i++)
    if (!samePersistedEdge(a.edges[i], b.edges[i])) return false;
  return true;
}

export function createNode(
  type: NodeData['type'],
  id: string,
  position: NodeData['position'],
): CanvasNode {
  if (type === 'prompt') return { id, type, position, data: { text: '' } };
  return { id, type, position, data: { label: NODE_TITLES[type] } };
}
