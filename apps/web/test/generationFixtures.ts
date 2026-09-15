import { randomUUID } from 'node:crypto';
import type { GenerationData, GenerationRequest } from '@canvas/contracts';
import { ApiRequestError } from '../src/api/apiError';
import type { GenerationsApi } from '../src/api/generationsApi';
import { createGenerationController } from '../src/generation/generationController';
import { createGenerationRecovery } from '../src/generation/generationRecovery';
import { initialEditorState } from '../src/graph/graphState';
import { etag, graphFixture, meta } from './fixtures';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export async function settle() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}
export function manualClock() {
  let now = 0;
  const tasks = new Set<{ at: number; callback: () => void }>();
  return {
    scheduleAfter(callback: () => void, delay: number) {
      const task = { at: now + delay, callback };
      tasks.add(task);
      return () => {
        tasks.delete(task);
      };
    },
    get pending() {
      return tasks.size;
    },
    tick(ms: number) {
      now += ms;
      for (const task of tasks) {
        if (task.at <= now) {
          tasks.delete(task);
          task.callback();
        }
      }
    },
  };
}
export function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    get length() {
      return values.size;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}
export const generationResponse = (
  data: GenerationData,
  status = 200,
  retryAfter: string | null = null,
) => ({
  data,
  meta: { ...meta, status, retryAfter, location: status === 200 ? null : data.links.self.href },
});
export const networkError = () =>
  new ApiRequestError('Сеть недоступна.', 'network', 'NETWORK_ERROR');
export const businessError = (code: string, status = 409) =>
  new ApiRequestError(code, 'http', code, { ...meta, status });

export function generationSetup() {
  const spaceId = randomUUID();
  let editor = initialEditorState(graphFixture());
  const nodeId = editor.nodes[1].id;
  const resultNodeId = editor.nodes[2].id;
  const storage = memoryStorage();
  const recovery = createGenerationRecovery(() => storage);
  const clock = manualClock();
  const calls: { body: GenerationRequest; key: string }[] = [];
  const conflicts: ApiRequestError[] = [];
  const events: string[] = [];
  const resources: GenerationData[] = [];
  let serial = 0;
  function generation(overrides: Partial<GenerationData> = {}): GenerationData {
    const id = randomUUID();
    return {
      id,
      spaceId,
      nodeId,
      resultNodeId,
      prompt: 'Горы',
      graphETag: etag,
      scenario: 'success',
      status: 'processing',
      createdAt: new Date(Date.UTC(2026, 8, 14) + serial++).toISOString(),
      imageUrl: null,
      failureCode: null,
      links: { self: { href: `/api/spaces/${spaceId}/generations/${id}`, method: 'GET' } },
      ...overrides,
    };
  }
  const api: GenerationsApi = {
    list: async () => ({ data: resources, meta }),
    create: async (_spaceId, body, key) => {
      events.push('POST');
      calls.push({ body, key });
      const data = generation({ ...body });
      resources.unshift(data);
      return generationResponse(data, 202, '1');
    },
    get: async (_spaceId, id) => generationResponse(resources.find((item) => item.id === id)!),
  };
  const options = {
    spaceId,
    api,
    recovery,
    getGraph: () => editor,
    flush: async () => {
      events.push('flush');
      return etag;
    },
    onGraphChanged: (error: ApiRequestError) => {
      conflicts.push(error);
    },
    newKey: randomUUID,
    scheduleAfter: clock.scheduleAfter,
    config: {
      get: async () => ({
        data: {
          debounceMs: 500,
          pollIntervalMs: 500,
          generationDelayMs: 1500,
          maxNodes: 20,
          maxEdges: 20,
          nodeTypes: ['prompt', 'generator', 'result'],
          links: {},
        },
        meta,
      }),
    },
  };
  const controller = createGenerationController(options);
  return {
    spaceId,
    nodeId,
    resultNodeId,
    storage,
    recovery,
    clock,
    calls,
    conflicts,
    events,
    resources,
    generation,
    api,
    options,
    controller,
    get editor() {
      return editor;
    },
    set editor(value) {
      editor = value;
    },
  };
}
