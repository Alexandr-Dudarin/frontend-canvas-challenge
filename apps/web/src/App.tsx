import { useEffect, useState } from 'react';
import { type ApiRequestError, normalizeError } from './api/apiError';
import { GraphEditor } from './graph/GraphEditor';
import type { LoadedSpace, SpaceLoader } from './space/spaceLoader';

type State =
  | { status: 'loading' }
  | { status: 'error'; error: ApiRequestError }
  | { status: 'ready'; loaded: LoadedSpace };

export function App({ loader }: { loader: SpaceLoader }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ status: 'loading' });
    void loader.load().then(
      (loaded) => {
        if (active) setState({ status: 'ready', loaded });
      },
      (error: unknown) => {
        if (active) setState({ status: 'error', error: normalizeError(error) });
      },
    );
    // Ушедший подписчик не обновляет UI. Незавершённое создание space сохраняет свой id.
    return () => {
      active = false;
    };
  }, [loader, attempt]);

  return (
    <main className="app-shell">
      <header className="app-heading">
        <div>
          <p className="eyebrow">CANVAS</p>
          <h1>Редактор графа</h1>
        </div>
        {state.status === 'ready' && (
          <span className="space-title">{state.loaded.space.title}</span>
        )}
      </header>
      {state.status === 'loading' && (
        <p className="load-state" role="status">
          Открываем пространство и загружаем граф…
        </p>
      )}
      {state.status === 'error' && (
        <section className="load-state error-state" aria-label="Ошибка загрузки">
          <p role="alert">{state.error.message}</p>
          {state.error.meta?.requestId && (
            <p className="muted">Код запроса: {state.error.meta.requestId}</p>
          )}
          <button type="button" onClick={() => setAttempt((value) => value + 1)}>
            Повторить загрузку
          </button>
        </section>
      )}
      {state.status === 'ready' && (
        <>
          {state.loaded.warning && (
            <p className="draft-notice" role="status">
              {state.loaded.warning}
            </p>
          )}
          <GraphEditor key={state.loaded.space.id} loaded={state.loaded} />
        </>
      )}
    </main>
  );
}
