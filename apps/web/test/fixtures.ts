import { randomUUID } from 'node:crypto';
import type { GraphData, SpaceData } from '@canvas/contracts';
import type { ResponseMeta } from '../src/api/apiError';
import { CURRENT_SPACE_KEY, createCurrentSpaceStorage } from '../src/space/currentSpace';

export const etag = `"${'a'.repeat(64)}"`;
export const meta: ResponseMeta = {
  status: 200,
  etag,
  location: null,
  retryAfter: null,
  requestId: 'test-request',
};

export function spaceFixture(): SpaceData {
  const id = randomUUID();
  return {
    id,
    title: 'Мой канвас',
    createdAt: '2026-09-12T10:00:00.000Z',
    links: {
      self: { href: `/api/spaces/${id}`, method: 'GET' },
      graph: { href: `/api/spaces/${id}/graph`, method: 'GET' },
    },
  };
}

export function graphFixture(): GraphData {
  const prompt = randomUUID();
  const generator = randomUUID();
  const result = randomUUID();
  return {
    nodes: [
      { id: prompt, type: 'prompt', position: { x: 0, y: 0 }, data: { text: 'Горы' } },
      {
        id: generator,
        type: 'generator',
        position: { x: 320, y: 0 },
        data: { label: 'Генератор' },
      },
      { id: result, type: 'result', position: { x: 640, y: 0 }, data: { label: 'Результат' } },
    ],
    edges: [
      { id: randomUUID(), source: prompt, target: generator },
      { id: randomUUID(), source: generator, target: result },
    ],
    viewport: { x: 25, y: -30, zoom: 0.8 },
  };
}

export function storageFixture(id?: string) {
  const values = new Map<string, string>();
  if (id) values.set(CURRENT_SPACE_KEY, id);
  const raw = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  return { values, raw, storage: createCurrentSpaceStorage(() => raw) };
}

export function jsonResponse(body: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...Object.fromEntries(new Headers(headers)) },
  });
}
