import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { apiClient } from '../api/client';
import { createConfigApi } from '../api/configApi';
import { createGenerationsApi } from '../api/generationsApi';
import type { ApiRequestError } from '../api/apiError';
import type { EditorState } from '../graph/graphState';
import {
  createGenerationController,
  type GenerationController,
  type GenerationOverview,
} from './generationController';
import { idleGeneration } from './generationModel';
import { createGenerationRecovery } from './generationRecovery';

const api = createGenerationsApi(apiClient);
const config = createConfigApi(apiClient);
const context = createContext<GenerationController | null>(null);
const loading: GenerationOverview = { status: 'loading', problems: [] };
const subscribeEmpty = () => () => {};

export function GenerationProvider({
  spaceId,
  getGraph,
  flush,
  onGraphChanged,
  children,
}: {
  spaceId: string;
  getGraph: () => EditorState;
  flush: () => Promise<string>;
  onGraphChanged: (error: ApiRequestError) => void;
  children: ReactNode;
}) {
  const [controller, setController] = useState<GenerationController | null>(null);
  useLayoutEffect(() => {
    const current = createGenerationController({
      spaceId,
      api,
      config,
      getGraph,
      flush,
      onGraphChanged,
      recovery: createGenerationRecovery(() => localStorage),
      withLock: async (nodeId, task) =>
        navigator.locks
          ? navigator.locks.request(`canvas-generation:${spaceId}:${nodeId}`, task)
          : task(),
    });
    setController(current);
    void current.restore();
    return () => current.dispose();
  }, [spaceId, getGraph, flush, onGraphChanged]);
  return <context.Provider value={controller}>{children}</context.Provider>;
}

export function useGeneration(nodeId: string, type: 'generator' | 'result') {
  const controller = useContext(context);
  // Подписка читает только snapshot этой ноды. Poll не меняет Graph и чужие snapshots.
  const view = useSyncExternalStore(
    controller?.subscribe ?? subscribeEmpty,
    () =>
      (type === 'generator' ? controller?.getGenerator(nodeId) : controller?.getResult(nodeId)) ??
      idleGeneration,
  );
  return { controller, view };
}

export function useGenerationOverview() {
  const controller = useContext(context);
  const overview = useSyncExternalStore(
    controller?.subscribe ?? subscribeEmpty,
    controller?.getOverview ?? (() => loading),
  );
  return { controller, overview };
}

export function useGenerationReady() {
  const controller = useContext(context);
  return useSyncExternalStore(
    controller?.subscribe ?? subscribeEmpty,
    () => controller?.getOverview().status === 'ready',
  );
}
