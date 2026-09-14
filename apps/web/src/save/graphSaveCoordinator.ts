import type { GraphData } from '@canvas/contracts';
import { ApiRequestError, normalizeError } from '../api/apiError';
import type { GraphApi } from '../api/graphApi';
import { samePersistedGraph } from '../graph/graphModel';

export type GraphSnapshot = Readonly<{ revision: number; graph: GraphData }>;
type Operation = 'put' | 'reconcile' | 'reload';
type Problem =
  | { status: 'error'; error: ApiRequestError; recovery: Operation }
  | { status: 'conflict'; error: ApiRequestError };
export type SaveState = {
  revision: number;
  savedRevision: number;
  etag: string;
} & ({ status: 'dirty' | 'saved' } | { status: 'saving'; operation: Operation } | Problem);

type Request = { operation: Operation; controller: AbortController };
type Waiter = { revision: number; resolve: (etag: string) => void; reject: (error: Error) => void };
export type ScheduleAfter = (callback: () => void, delayMs: number) => () => void;
const scheduleAfter: ScheduleAfter = (callback, delayMs) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

export function createGraphSaveCoordinator(options: {
  spaceId: string;
  initialETag: string;
  initialRevision: number;
  api: GraphApi;
  // Возвращает отдельный persisted snapshot, не объекты редактируемого React Flow state.
  captureLatest: () => GraphSnapshot;
  replaceGraph: (graph: GraphData, revision: number) => void;
  scheduleAfter?: ScheduleAfter;
}) {
  let revision = options.initialRevision;
  let savedRevision = revision;
  let etag = options.initialETag;
  let queued: GraphSnapshot | null = null;
  let attempted: GraphSnapshot | null = null;
  let active: Request | null = null;
  let problem: Problem | null = null;
  let cancelTimer: (() => void) | undefined;
  let disposed = false;
  let waiters: Waiter[] = [];
  const listeners = new Set<() => void>();
  let state: SaveState = { status: 'saved', revision, savedRevision, etag };

  function publish() {
    state = {
      revision,
      savedRevision,
      etag,
      ...(problem ??
        (active
          ? { status: 'saving', operation: active.operation }
          : { status: revision > savedRevision ? 'dirty' : 'saved' })),
    };
    for (const listener of listeners) listener();
  }
  function cancelDebounce() {
    cancelTimer?.();
    cancelTimer = undefined;
  }
  function rejectWaiters(error: Error) {
    for (const waiter of waiters) waiter.reject(error);
    waiters = [];
  }
  function fail(next: Problem) {
    cancelDebounce();
    problem = next;
    rejectWaiters(next.error);
  }
  function isCurrent(request: Request) {
    return !disposed && active === request;
  }
  function begin(operation: Operation): Request {
    const request = { operation, controller: new AbortController() };
    active = request;
    publish();
    return request;
  }
  function finish(request: Request) {
    if (!isCurrent(request)) return;
    active = null;
    publish();
    pump();
  }
  function confirm(snapshot: GraphSnapshot, confirmedETag: string) {
    // Ответ подтверждает только отправленный снимок. Текущий local graph не заменяем.
    etag = confirmedETag;
    savedRevision = snapshot.revision;
    attempted = null;
    if (queued && queued.revision <= savedRevision) queued = null;
    const remaining: Waiter[] = [];
    for (const waiter of waiters) {
      if (waiter.revision <= savedRevision) waiter.resolve(etag);
      else remaining.push(waiter);
    }
    waiters = remaining;
  }

  async function reconcile(snapshot: GraphSnapshot, request: Request) {
    request.operation = 'reconcile';
    publish();
    try {
      const response = await options.api.get(options.spaceId, request.controller.signal);
      if (!isCurrent(request)) return;
      if (samePersistedGraph(response.data, snapshot.graph)) {
        confirm(snapshot, response.meta.etag);
      } else {
        fail({
          status: 'conflict',
          error: new ApiRequestError(
            'Серверный граф отличается от отправленного снимка. Локальные правки сохранены в редакторе; автосохранение остановлено.',
            'request',
            'GRAPH_RECONCILIATION_CONFLICT',
          ),
        });
      }
    } catch (error) {
      if (isCurrent(request))
        fail({ status: 'error', error: normalizeError(error), recovery: 'reconcile' });
    }
  }

  async function save(snapshot: GraphSnapshot, request: Request) {
    try {
      const response = await options.api.put(
        options.spaceId,
        snapshot.graph,
        etag,
        request.controller.signal,
      );
      if (isCurrent(request)) confirm(snapshot, response.meta.etag);
    } catch (cause) {
      if (!isCurrent(request)) return;
      const error = normalizeError(cause);
      const status = error.meta?.status;
      if (error.kind === 'http' && status === 412) {
        fail({ status: 'conflict', error });
      } else if (
        error.kind === 'request' ||
        (error.kind === 'http' &&
          status !== undefined &&
          status >= 400 &&
          status < 500 &&
          status !== 408)
      ) {
        attempted = null;
        fail({ status: 'error', error, recovery: 'put' });
      } else {
        // Network, 5xx, timeout или повреждённый success могли возникнуть уже после commit.
        // Только один GET для сверки; при его сбое дальнейший Retry тоже начинает с GET.
        await reconcile(snapshot, request);
      }
    } finally {
      finish(request);
    }
  }

  function pump() {
    if (disposed || active || problem || !queued) return;
    const snapshot = queued;
    queued = null;
    if (snapshot.revision <= savedRevision) return;
    attempted = snapshot;
    const request = begin('put');
    void save(snapshot, request);
  }
  function enqueueLatest() {
    if (revision <= savedRevision) return;
    // Повторный flush той же revision не копирует граф и не создаёт второй PUT.
    if (attempted?.revision !== revision && queued?.revision !== revision) {
      queued = options.captureLatest();
    }
    pump();
  }

  function schedule(nextRevision: number) {
    if (disposed || nextRevision <= revision) return;
    revision = nextRevision;
    cancelDebounce();
    if (!problem && active?.operation !== 'reload') {
      cancelTimer = (options.scheduleAfter ?? scheduleAfter)(() => {
        cancelTimer = undefined;
        enqueueLatest();
      }, 500);
    }
    publish();
  }

  function flush(): Promise<string> {
    if (disposed) return Promise.reject(cancelled());
    if (problem) return Promise.reject(problem.error);
    if (active?.operation === 'reload')
      return Promise.reject(
        new ApiRequestError(
          'Дождитесь загрузки серверной версии.',
          'request',
          'GRAPH_RELOAD_IN_PROGRESS',
        ),
      );
    cancelDebounce();
    if (revision <= savedRevision) return Promise.resolve(etag);
    const completion = new Promise<string>((resolve, reject) => {
      waiters.push({ revision, resolve, reject });
    });
    enqueueLatest();
    return completion;
  }

  function retry() {
    if (disposed || active || problem?.status !== 'error') return;
    const recovery = problem.recovery;
    if (recovery === 'reload') {
      reloadServer();
      return;
    }
    problem = null;
    if (recovery === 'reconcile' && attempted) {
      const request = begin('reconcile');
      void reconcile(attempted, request).finally(() => finish(request));
    }
    // Retry сохраняет latest через тот же flush; неизвестный PUT сначала ждёт GET.
    // Ошибка уже отражена в SaveState, UI-команде не нужен отдельный rejected Promise.
    void flush().catch(() => {});
  }

  function reloadServer() {
    if (disposed || active || !problem) return;
    cancelDebounce();
    const atStart = revision;
    problem = null;
    const request = begin('reload');
    void (async () => {
      try {
        const response = await options.api.get(options.spaceId, request.controller.signal);
        if (!isCurrent(request)) return;
        if (revision !== atStart) {
          fail({
            status: 'conflict',
            error: new ApiRequestError(
              'Пока загружался граф, появились новые локальные правки. Нажмите «Загрузить версию с сервера» ещё раз, если хотите заменить их.',
              'request',
              'GRAPH_EDITED_DURING_RELOAD',
            ),
          });
          return;
        }
        // Новая baseline монотонна: отложенный effect со старой revision её не отменит.
        const nextRevision = revision + 1;
        options.replaceGraph(response.data, nextRevision);
        revision = savedRevision = nextRevision;
        etag = response.meta.etag;
        queued = attempted = null;
      } catch (error) {
        if (isCurrent(request))
          fail({ status: 'error', error: normalizeError(error), recovery: 'reload' });
      } finally {
        finish(request);
      }
    })();
  }

  function cancelled() {
    return new ApiRequestError(
      'Сохранение остановлено при закрытии редактора.',
      'aborted',
      'SAVE_CANCELLED',
    );
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    cancelDebounce();
    active?.controller.abort();
    active = null;
    queued = attempted = null;
    rejectWaiters(cancelled());
    listeners.clear();
  }

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    schedule,
    flush,
    retry,
    reloadServer,
    reportConflict(error: ApiRequestError) {
      if (disposed) return;
      // GRAPH_CHANGED может прийти от generation, даже когда local Graph считается saved.
      fail({ status: 'conflict', error });
      publish();
    },
    dispose,
  };
}

export type GraphSaveCoordinator = ReturnType<typeof createGraphSaveCoordinator>;
