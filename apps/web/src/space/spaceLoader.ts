import type { SpaceData } from '@canvas/contracts';
import { ApiRequestError } from '../api/apiError';
import type { GraphApi } from '../api/graphApi';
import type { SpacesApi } from '../api/spacesApi';
import type { CurrentSpaceStorage } from './currentSpace';

export function createSpaceLoader(
  spacesApi: SpacesApi,
  graphApi: Pick<GraphApi, 'get'>,
  storage: CurrentSpaceStorage,
) {
  let currentId: string | null = null;
  let inFlight: Promise<LoadedSpace> | null = null;

  async function open() {
    const saved = storage.read();
    currentId ??= saved.id;
    let warning = saved.warning;
    let space: SpaceData | undefined;
    if (currentId) {
      try {
        space = (await spacesApi.get(currentId)).data;
      } catch (error) {
        if (!(error instanceof ApiRequestError) || error.code !== 'SPACE_NOT_FOUND') throw error;
        currentId = null;
      }
    }
    if (!space) {
      space = (await spacesApi.create({ title: 'Мой канвас' })).data;
      // Запоминаем id до GET графа: ошибка чтения не должна создавать ещё одно пространство.
      currentId = space.id;
      warning = storage.write(space.id) ?? warning;
    }
    const graph = await graphApi.get(space.id);
    return { space, graph, warning };
  }

  type LoadedSpace = Awaited<ReturnType<typeof open>>;
  return {
    load(): Promise<LoadedSpace> {
      // StrictMode может повторить effect. Оба подписчика ждут одну операцию создания.
      // POST не отменяем при cleanup: сохраняем полученный id даже после ухода со страницы.
      if (!inFlight) {
        inFlight = open().finally(() => {
          inFlight = null;
        });
      }
      return inFlight;
    },
  };
}

export type SpaceLoader = ReturnType<typeof createSpaceLoader>;
export type LoadedSpace = Awaited<ReturnType<SpaceLoader['load']>>;
