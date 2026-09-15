import { useCallback, useLayoutEffect, useRef, useState, type Dispatch } from 'react';
import { apiClient } from '../api/client';
import type { ApiRequestError } from '../api/apiError';
import { createGraphApi } from '../api/graphApi';
import { toPersistedGraph } from '../graph/graphModel';
import { initialEditorState, type EditorAction, type EditorState } from '../graph/graphState';
import {
  createGraphSaveCoordinator,
  type GraphSaveCoordinator,
  type SaveState,
} from './graphSaveCoordinator';

const graphApi = createGraphApi(apiClient);

export function useGraphAutosave(
  spaceId: string,
  initialETag: string,
  state: EditorState,
  dispatch: Dispatch<EditorAction>,
) {
  const latest = useRef(state);
  const coordinator = useRef<GraphSaveCoordinator | null>(null);
  const [save, setSave] = useState<SaveState>({
    status: 'saved',
    revision: 0,
    savedRevision: 0,
    etag: initialETag,
  });

  // Ref обновляется после commit, до таймеров/событий. Render не сериализует Graph.
  useLayoutEffect(() => {
    latest.current = state;
  }, [state]);
  useLayoutEffect(() => {
    const current = createGraphSaveCoordinator({
      spaceId,
      initialETag,
      initialRevision: 0,
      api: graphApi,
      captureLatest: () => ({
        revision: latest.current.revision,
        graph: toPersistedGraph(latest.current),
      }),
      replaceGraph: (graph, revision) => {
        const replacement = initialEditorState(graph, revision);
        latest.current = replacement;
        dispatch({ type: 'replaceFromServer', state: replacement });
      },
    });
    coordinator.current = current;
    const unsubscribe = current.subscribe(() => setSave(current.getState()));
    setSave(current.getState());
    current.schedule(latest.current.revision);
    return () => {
      unsubscribe();
      current.dispose();
      coordinator.current = null;
    };
  }, [spaceId, initialETag, dispatch]);
  useLayoutEffect(() => {
    coordinator.current?.schedule(state.revision);
  }, [state.revision]);

  const flush = useCallback(() => {
    if (!coordinator.current) return Promise.reject(new Error('Редактор ещё не открыт.'));
    return coordinator.current.flush();
  }, []);
  const retry = useCallback(() => coordinator.current?.retry(), []);
  const reloadServer = useCallback(() => coordinator.current?.reloadServer(), []);
  const reportConflict = useCallback(
    (error: ApiRequestError) => coordinator.current?.reportConflict(error),
    [],
  );
  return { save, flush, retry, reloadServer, reportConflict };
}
