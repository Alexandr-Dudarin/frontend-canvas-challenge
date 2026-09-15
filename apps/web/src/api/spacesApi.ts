import type { SpaceInput } from '@canvas/contracts';
import type { Static } from '@sinclair/typebox';
import type { HttpClient } from './httpClient';
import { isSpace } from './responseSchemas';

export function createSpacesApi(client: HttpClient) {
  return {
    create(body: Static<typeof SpaceInput>, signal?: AbortSignal) {
      return client.request('/api/spaces', {
        method: 'POST',
        body,
        signal,
        validateData: isSpace,
        requiredHeaders: ['location'],
      });
    },
    get(spaceId: string, signal?: AbortSignal) {
      return client.request(`/api/spaces/${encodeURIComponent(spaceId)}`, {
        signal,
        validateData: isSpace,
      });
    },
  };
}

export type SpacesApi = ReturnType<typeof createSpacesApi>;
