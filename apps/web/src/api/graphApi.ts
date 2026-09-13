import type { HttpClient } from './httpClient';
import { isGraph } from './responseSchemas';

export function createGraphApi(client: HttpClient) {
  return {
    get(spaceId: string, signal?: AbortSignal) {
      return client.request(`/api/spaces/${encodeURIComponent(spaceId)}/graph`, {
        signal,
        validateData: isGraph,
        requiredHeaders: ['etag'],
      });
    },
  };
}

export type GraphApi = ReturnType<typeof createGraphApi>;
