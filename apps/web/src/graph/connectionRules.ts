import type { GraphData } from '@canvas/contracts';
import { MAX_EDGES } from './graphModel';

export type ConnectionCandidate = {
  source: string | null;
  target: string | null;
  sourceHandle?: string | null;
  targetHandle?: string | null;
};

export function canConnect(
  connection: ConnectionCandidate,
  nodes: readonly Pick<GraphData['nodes'][number], 'id' | 'type'>[],
  edges: readonly Pick<GraphData['edges'][number], 'source' | 'target'>[],
): boolean {
  if (
    !connection.source ||
    !connection.target ||
    connection.sourceHandle != null ||
    connection.targetHandle != null ||
    edges.length >= MAX_EDGES
  )
    return false;

  let sourceType: GraphData['nodes'][number]['type'] | undefined;
  let targetType: GraphData['nodes'][number]['type'] | undefined;
  // Два id ищем за один проход без временного индекса для графа максимум из 20 нод.
  for (const node of nodes) {
    if (node.id === connection.source) sourceType = node.type;
    if (node.id === connection.target) targetType = node.type;
    if (sourceType && targetType) break;
  }
  if (!(
    (sourceType === 'prompt' && targetType === 'generator') ||
    (sourceType === 'generator' && targetType === 'result')
  ))
    return false;

  for (const edge of edges) {
    if (edge.target === connection.target) return false;
    if (sourceType === 'generator' && edge.source === connection.source) return false;
  }
  return true;
}
