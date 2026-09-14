import type { GenerationData } from '@canvas/contracts';
import type { ApiRequestError } from '../api/apiError';

export type GenerationView =
  | { status: 'idle' | 'flushing' | 'creating' }
  | { status: GenerationData['status']; generation: GenerationData }
  | {
      status: 'error';
      error: ApiRequestError;
      recovery: 'new' | 'replay' | 'poll' | 'refresh' | 'blocked';
      generation?: GenerationData;
    };
export const idleGeneration: GenerationView = { status: 'idle' };

export function indexGenerations(generations: GenerationData[], known = new Set<string>()) {
  const byGenerator = new Map<string, GenerationData>();
  const byResult = new Map<string, GenerationData>();
  // API выдаёт новые записи первыми. Первый владелец каждого id и есть latest attempt.
  for (const generation of generations) {
    known.add(generation.id);
    if (!byGenerator.has(generation.nodeId)) byGenerator.set(generation.nodeId, generation);
    if (!byResult.has(generation.resultNodeId)) byResult.set(generation.resultNodeId, generation);
  }
  return { byGenerator, byResult, known };
}

export function generationErrorRecovery(
  error: ApiRequestError,
): 'new' | 'replay' | 'refresh' | 'blocked' {
  if (error.code === 'IDEMPOTENCY_CONFLICT') return 'blocked';
  if (error.code === 'GENERATION_IN_PROGRESS') return 'refresh';
  if (
    error.kind === 'request' ||
    (error.kind === 'http' &&
      error.meta &&
      error.meta.status >= 400 &&
      error.meta.status < 500 &&
      error.meta.status !== 408)
  )
    return 'new';
  return 'replay';
}

export function generationErrorMessage(error: ApiRequestError) {
  switch (error.code) {
    case 'GRAPH_CHANGED':
      return 'Граф на сервере изменился. Разрешите конфликт сохранения перед новым запуском.';
    case 'GENERATION_IN_PROGRESS':
      return 'У генератора уже есть незавершённая попытка. Загрузите её состояние.';
    case 'IDEMPOTENCY_CONFLICT':
      return 'Ключ связан с другим запросом. Операция заблокирована; body и key сохранены для разбора, новый ключ автоматически не создаётся.';
    case 'GENERATOR_REQUIRED':
      return 'Нужна существующая нода генератора.';
    case 'INCOMPLETE_CHAIN':
      return 'Соедините непустой текст, генератор и результат.';
    default:
      return error.message;
  }
}
