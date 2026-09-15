import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiRequestError } from '../src/api/apiError';
import { createSpaceLoader } from '../src/space/spaceLoader';
import { CURRENT_SPACE_KEY, createCurrentSpaceStorage } from '../src/space/currentSpace';
import { graphFixture, meta, spaceFixture, storageFixture } from './fixtures';

test('одновременные подписчики создают один space, id записан до GET; reload читает тот же space', async () => {
  const space = spaceFixture();
  const graph = graphFixture();
  const store = storageFixture();
  let creates = 0;
  let reads = 0;
  const spaces = {
    create: async () => {
      creates++;
      return { data: space, meta };
    },
    get: async (id: string) => {
      reads++;
      assert.equal(id, space.id);
      return { data: space, meta };
    },
  };
  const graphs = {
    get: async (id: string) => {
      assert.equal(id, space.id);
      assert.deepEqual([...store.values], [[CURRENT_SPACE_KEY, space.id]]);
      return { data: graph, meta };
    },
  };
  const loader = createSpaceLoader(spaces, graphs, store.storage);
  const first = loader.load();
  assert.equal(loader.load(), first);
  await first;
  const reloaded = createSpaceLoader(
    spaces,
    graphs,
    createCurrentSpaceStorage(() => store.raw),
  );
  assert.deepEqual((await reloaded.load()).graph.data, graph);
  assert.equal(creates, 1);
  assert.equal(reads, 1);
});

test('ошибка GET графа сохраняет id, Retry не создаёт другой space', async () => {
  const space = spaceFixture();
  const store = storageFixture();
  let creates = 0;
  let graphReads = 0;
  const loader = createSpaceLoader(
    {
      create: async () => {
        creates++;
        return { data: space, meta };
      },
      get: async () => ({ data: space, meta }),
    },
    {
      get: async () => {
        if (++graphReads === 1) throw new ApiRequestError('Offline', 'network', 'NETWORK_ERROR');
        return { data: graphFixture(), meta };
      },
    },
    store.storage,
  );
  await assert.rejects(loader.load(), { code: 'NETWORK_ERROR' });
  await loader.load();
  assert.equal(creates, 1);
  assert.equal(store.values.get(CURRENT_SPACE_KEY), space.id);
});

test('только SPACE_NOT_FOUND заменяет сохранённый id; network/5xx не создают space', async () => {
  for (const code of ['SPACE_NOT_FOUND', 'NETWORK_ERROR', 'INTERNAL_ERROR']) {
    const old = spaceFixture();
    const replacement = spaceFixture();
    const store = storageFixture(old.id);
    let creates = 0;
    const loader = createSpaceLoader(
      {
        create: async () => {
          creates++;
          return { data: replacement, meta };
        },
        get: async () => {
          throw new ApiRequestError('Failure', code === 'NETWORK_ERROR' ? 'network' : 'http', code);
        },
      },
      { get: async () => ({ data: graphFixture(), meta }) },
      store.storage,
    );
    if (code === 'SPACE_NOT_FOUND') {
      assert.equal((await loader.load()).space.id, replacement.id);
      assert.equal(creates, 1);
    } else {
      await assert.rejects(loader.load(), { code });
      assert.equal(creates, 0);
      assert.equal(store.values.get(CURRENT_SPACE_KEY), old.id);
    }
  }
});

test('некорректный сохранённый id игнорируется; недоступный storage даёт видимое предупреждение', async () => {
  const corrupt = storageFixture('not-a-uuid');
  assert.equal(corrupt.storage.read().id, null);
  const space = spaceFixture();
  let creates = 0;
  const loader = createSpaceLoader(
    {
      create: async () => {
        creates++;
        return { data: space, meta };
      },
      get: async () => ({ data: space, meta }),
    },
    { get: async () => ({ data: graphFixture(), meta }) },
    createCurrentSpaceStorage(() => {
      throw new Error('blocked');
    }),
  );
  assert.ok((await loader.load()).warning);
  await loader.load();
  assert.equal(creates, 1);
});
