import type { GraphData } from '@canvas/contracts';
import { ApiRequestError, invalidResponse, type ResponseMeta } from './apiError';
import type { ApiResponse, HttpClient } from './httpClient';
import { isGraph, isGraphETag } from './responseSchemas';

export type GraphResponse = { data: GraphData; meta: ResponseMeta & { etag: string } };

function withGraphETag(response: ApiResponse<GraphData>): GraphResponse {
  const etag = response.meta.etag;
  if (!isGraphETag(etag)) throw invalidResponse(response.meta);
  return { data: response.data, meta: { ...response.meta, etag } };
}

export function createGraphApi(client: HttpClient) {
  return {
    async get(spaceId: string, signal?: AbortSignal) {
      return withGraphETag(
        await client.request(`/api/spaces/${encodeURIComponent(spaceId)}/graph`, {
          signal,
          validateData: isGraph,
          requiredHeaders: ['etag'],
        }),
      );
    },
    async put(spaceId: string, graph: GraphData, etag: string, signal?: AbortSignal) {
      if (!isGraphETag(etag)) {
        throw new ApiRequestError(
          'Для сохранения нужна подтверждённая версия графа.',
          'request',
          'INVALID_GRAPH_ETAG',
        );
      }
      return withGraphETag(
        await client.request(`/api/spaces/${encodeURIComponent(spaceId)}/graph`, {
          method: 'PUT',
          body: graph,
          headers: { 'If-Match': etag },
          signal,
          validateData: isGraph,
          requiredHeaders: ['etag'],
        }),
      );
    },
  };
}

export type GraphApi = ReturnType<typeof createGraphApi>;
