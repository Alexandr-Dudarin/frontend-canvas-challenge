import type { GenerationData, GenerationRequest } from '@canvas/contracts';
import { ApiRequestError, normalizeError } from '../api/apiError';
import type { createConfigApi } from '../api/configApi';
import type { GenerationsApi } from '../api/generationsApi';
import type { EditorState } from '../graph/graphState';
import {
  generationErrorRecovery,
  idleGeneration,
  indexGenerations,
  type GenerationView,
} from './generationModel';
import { startGenerationPolling, type ScheduleAfter } from './generationPolling';
import type { GenerationRecovery, PendingGeneration } from './generationRecovery';

type Request = { controller: AbortController };
type Problem = { nodeId: string; view: Extract<GenerationView, { status: 'error' }> };
export type GenerationOverview = {
  status: 'loading' | 'ready' | 'error';
  error?: ApiRequestError;
  problems: Problem[];
};

export function createGenerationController(options: {
  spaceId: string;
  api: GenerationsApi;
  config: ReturnType<typeof createConfigApi>;
  recovery: GenerationRecovery;
  getGraph: () => EditorState;
  flush: () => Promise<string>;
  onGraphChanged: (error: ApiRequestError) => void;
  newKey?: () => string;
  // Web Locks сериализует создание для одной ноды между вкладками; разные ноды независимы.
  withLock?: (nodeId: string, task: () => Promise<void>) => Promise<void>;
  scheduleAfter?: ScheduleAfter;
  now?: () => number;
}) {
  const byGenerator = new Map<string, string>();
  const byResult = new Map<string, string>();
  const records = new Map<string, GenerationView>();
  const actions = new Map<string, GenerationView>();
  const requests = new Map<string, Request>();
  const polls = new Map<string, ReturnType<typeof startGenerationPolling>>();
  const known = new Set<string>();
  const acceptedAt = new Map<string, number>();
  const listeners = new Set<() => void>();
  let clock = 0;
  let fallbackMs = 500;
  let disposed = false;
  let loading: AbortController | undefined;
  let overview: GenerationOverview = { status: 'loading', problems: [] };

  function publish(actionsChanged = false) {
    if (actionsChanged) {
      const problems: Problem[] = [];
      for (const [nodeId, view] of actions) {
        if (view.status === 'error') problems.push({ nodeId, view });
      }
      overview = { ...overview, problems };
    }
    for (const listener of listeners) listener();
  }
  function current(nodeId: string, request: Request) {
    return !disposed && requests.get(nodeId) === request;
  }
  function getRecord(id: string | undefined) {
    const view = id ? records.get(id) : undefined;
    return view && 'generation' in view ? view.generation : undefined;
  }
  function updateRecord(generation: GenerationData) {
    const previous = getRecord(generation.id);
    // Повтор processing не меняет ссылки и не перерисовывает ноды. Terminal не откатываем.
    if (previous && previous.status !== 'processing' && generation.status === 'processing') return;
    if (
      previous?.status === generation.status &&
      previous.imageUrl === generation.imageUrl &&
      previous.failureCode === generation.failureCode &&
      records.get(generation.id)?.status !== 'error'
    )
      return;
    records.set(generation.id, { status: generation.status, generation });
  }
  function owned(generation: GenerationData) {
    return (
      byGenerator.get(generation.nodeId) === generation.id ||
      byResult.get(generation.resultNodeId) === generation.id
    );
  }
  function prunePolls() {
    for (const [id, poll] of polls) {
      const generation = getRecord(id);
      if (!generation || !owned(generation) || generation.status !== 'processing') {
        poll.stop();
        polls.delete(id);
      }
    }
  }
  function watch(generation: GenerationData, retryAfter: string | null = null, location?: string) {
    if (
      disposed ||
      generation.status !== 'processing' ||
      !owned(generation) ||
      polls.has(generation.id)
    )
      return;
    const poll = startGenerationPolling({
      initial: generation,
      retryAfter,
      fallbackMs,
      scheduleAfter: options.scheduleAfter,
      now: options.now,
      read: (signal) => options.api.get(options.spaceId, generation.id, signal, location),
      onData(data) {
        if (disposed || polls.get(generation.id) !== poll || !owned(generation)) return;
        updateRecord(data);
        if (data.status !== 'processing') polls.delete(data.id);
        publish();
      },
      onError(error) {
        if (disposed || polls.get(generation.id) !== poll || !owned(generation)) return;
        polls.delete(generation.id);
        records.set(generation.id, {
          status: 'error',
          error,
          recovery: 'poll',
          generation: getRecord(generation.id) ?? generation,
        });
        publish();
      },
    });
    polls.set(generation.id, poll);
  }
  function accept(generation: GenerationData) {
    let ambiguous = false;
    if (!known.has(generation.id)) {
      acceptedAt.set(generation.id, ++clock);
      for (const [owners, nodeId] of [
        [byGenerator, generation.nodeId],
        [byResult, generation.resultNodeId],
      ] as const) {
        const previous = getRecord(owners.get(nodeId));
        if (!previous || generation.createdAt > previous.createdAt)
          owners.set(nodeId, generation.id);
        else if (generation.createdAt === previous.createdAt) ambiguous = true;
      }
    }
    known.add(generation.id);
    updateRecord(generation);
    prunePolls();
    return ambiguous;
  }
  function mergeHistory(data: GenerationData[], startedAt: number) {
    const indexed = indexGenerations(data, known);
    for (const [owners, incoming] of [
      [byGenerator, indexed.byGenerator],
      [byResult, indexed.byResult],
    ] as const) {
      for (const [nodeId, generation] of incoming) {
        const previousId = owners.get(nodeId);
        // GET, начатый до нового POST response, не отнимает у новой попытки её result.
        if (previousId && (acceptedAt.get(previousId) ?? 0) > startedAt) continue;
        owners.set(nodeId, generation.id);
        updateRecord(generation);
      }
    }
    prunePolls();
    for (const owners of [byGenerator, byResult]) {
      for (const id of owners.values()) {
        const generation = getRecord(id);
        if (generation) watch(generation);
      }
    }
  }
  async function refreshHistory(signal: AbortSignal) {
    const startedAt = clock;
    const response = await options.api.list(options.spaceId, signal);
    if (disposed || signal.aborted) return;
    mergeHistory(response.data, startedAt);
    publish();
  }
  function requireGenerator(nodeId: string) {
    if (options.getGraph().nodes.find((node) => node.id === nodeId)?.type !== 'generator')
      throw new ApiRequestError(
        'Выберите существующий генератор.',
        'request',
        'GENERATOR_REQUIRED',
      );
  }
  async function prepare(
    nodeId: string,
    scenario: GenerationRequest['scenario'],
    request: Request,
  ) {
    requireGenerator(nodeId);
    let revision: number;
    let graphETag: string;
    do {
      revision = options.getGraph().revision;
      graphETag = await options.flush();
      if (!current(nodeId, request)) return null;
      requireGenerator(nodeId);
      // flush подтверждает target на момент вызова. Новые правки во время ожидания тоже ждём.
    } while (options.getGraph().revision !== revision);
    const operation: PendingGeneration = Object.freeze({
      version: 1,
      spaceId: options.spaceId,
      body: Object.freeze({ nodeId, graphETag, scenario }),
      key: (options.newKey ?? (() => crypto.randomUUID()))(),
      blocked: false,
    });
    options.recovery.save(operation);
    return operation;
  }

  async function run(nodeId: string, scenario?: GenerationRequest['scenario']) {
    if (disposed || overview.status !== 'ready' || requests.has(nodeId)) return;
    const view = getGenerator(nodeId);
    if (
      scenario &&
      (view.status === 'processing' ||
        (view.status === 'error' && view.recovery !== 'new' && view.recovery !== 'replay'))
    )
      return;
    // Синхронный lock ставится до первого await, в том числе до Web Locks/flush.
    const request = { controller: new AbortController() };
    requests.set(nodeId, request);
    actions.set(nodeId, { status: scenario ? 'flushing' : 'creating' });
    publish(true);
    const task = async () => {
      if (!current(nodeId, request)) return;
      let operation: PendingGeneration | null = null;
      let accepted = false;
      let refreshing = false;
      try {
        operation = options.recovery.read(options.spaceId, nodeId);
        if (operation?.blocked)
          throw new ApiRequestError(
            'Ключ конфликтует с данными сервера.',
            'request',
            'IDEMPOTENCY_CONFLICT',
          );
        if (!operation && scenario) operation = await prepare(nodeId, scenario, request);
        if (!current(nodeId, request)) return;
        if (!operation) {
          actions.delete(nodeId);
          return;
        }
        actions.set(nodeId, { status: 'creating' });
        publish(true);
        const response = await options.api.create(
          options.spaceId,
          operation.body,
          operation.key,
          request.controller.signal,
        );
        if (!current(nodeId, request)) return;
        accepted = true;
        const ambiguous = accept(response.data);
        // Replay может уточнить серверную паузу уже восстановленного processing resource.
        polls.get(response.data.id)?.stop();
        polls.delete(response.data.id);
        watch(response.data, response.meta.retryAfter, response.meta.location ?? undefined);
        options.recovery.remove(operation);
        operation = null;
        actions.delete(nodeId);
        // При одинаковых createdAt порядок знает список API, а не время прихода POST response.
        if (ambiguous) {
          refreshing = true;
          await refreshHistory(request.controller.signal);
        }
      } catch (cause) {
        if (!current(nodeId, request)) return;
        const error = normalizeError(cause);
        let recovery = accepted
          ? operation
            ? ('replay' as const)
            : ('refresh' as const)
          : operation
            ? generationErrorRecovery(error)
            : ('new' as const);
        if (error.code === 'IDEMPOTENCY_CONFLICT') recovery = 'blocked';
        try {
          if (operation && recovery === 'blocked')
            options.recovery.save({ ...operation, blocked: true });
          else if (operation && recovery !== 'replay') options.recovery.remove(operation);
        } catch {
          // Не смогли очистить metadata — сначала повторяем исходную операцию, не выдаём новый key.
          if (recovery !== 'blocked') recovery = 'replay';
        }
        actions.set(nodeId, { status: 'error', error, recovery });
        if (error.code === 'GRAPH_CHANGED') options.onGraphChanged(error);
        if (recovery === 'refresh' && !refreshing) {
          try {
            await refreshHistory(request.controller.signal);
            if (current(nodeId, request) && byGenerator.has(nodeId)) actions.delete(nodeId);
          } catch (refreshError) {
            if (current(nodeId, request))
              actions.set(nodeId, {
                status: 'error',
                error: normalizeError(refreshError),
                recovery: 'refresh',
              });
          }
        }
      }
    };
    try {
      await (options.withLock ? options.withLock(nodeId, task) : task());
    } catch (error) {
      if (current(nodeId, request))
        actions.set(nodeId, { status: 'error', error: normalizeError(error), recovery: 'replay' });
    } finally {
      if (current(nodeId, request)) {
        requests.delete(nodeId);
        publish(true);
      }
    }
  }

  async function restore() {
    if (disposed || loading || overview.status === 'ready') return;
    const controller = new AbortController();
    loading = controller;
    overview = { status: 'loading', problems: [] };
    publish();
    try {
      const pending = options.recovery.list(options.spaceId);
      const [history, config] = await Promise.all([
        options.api.list(options.spaceId, controller.signal),
        options.config.get(controller.signal),
      ]);
      if (disposed || loading !== controller) return;
      fallbackMs = config.data.pollIntervalMs;
      mergeHistory(history.data, clock);
      overview = { status: 'ready', problems: [] };
      publish();
      // Только сохранённые операции replay; reload сам по себе не создаёт новую logical generation.
      await Promise.all(pending.map((operation) => run(operation.body.nodeId)));
    } catch (error) {
      if (!disposed && loading === controller) {
        overview = { status: 'error', error: normalizeError(error), problems: [] };
        publish();
      }
    } finally {
      controller.abort();
      if (loading === controller) loading = undefined;
    }
  }
  async function retry(nodeId: string) {
    if (disposed || requests.has(nodeId)) return;
    const view = getGenerator(nodeId);
    if (view.status !== 'error') return;
    if (view.recovery === 'replay') {
      await run(nodeId);
      return;
    }
    if (view.recovery === 'poll' && view.generation) {
      retryPoll(view.generation.id);
    } else if (view.recovery === 'refresh') {
      const request = { controller: new AbortController() };
      requests.set(nodeId, request);
      actions.set(nodeId, { status: 'creating' });
      publish(true);
      try {
        await refreshHistory(request.controller.signal);
        if (current(nodeId, request)) actions.delete(nodeId);
      } catch (error) {
        if (current(nodeId, request))
          actions.set(nodeId, {
            status: 'error',
            error: normalizeError(error),
            recovery: 'refresh',
          });
      } finally {
        if (current(nodeId, request)) {
          requests.delete(nodeId);
          publish(true);
        }
      }
    }
  }
  function retryPoll(id: string) {
    const view = records.get(id);
    if (disposed || view?.status !== 'error' || view.recovery !== 'poll' || !view.generation)
      return;
    updateRecord(view.generation);
    watch(view.generation);
    publish();
  }
  function getGenerator(nodeId: string): GenerationView {
    return actions.get(nodeId) ?? records.get(byGenerator.get(nodeId) ?? '') ?? idleGeneration;
  }
  function dispose() {
    disposed = true;
    loading?.abort();
    for (const request of requests.values()) request.controller.abort();
    for (const poll of polls.values()) poll.stop();
    requests.clear();
    polls.clear();
    listeners.clear();
  }
  return {
    restore,
    start: run,
    retry,
    retryPoll,
    dispose,
    getGenerator,
    getResult: (nodeId: string): GenerationView =>
      records.get(byResult.get(nodeId) ?? '') ?? idleGeneration,
    getOverview: () => overview,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export type GenerationController = ReturnType<typeof createGenerationController>;
