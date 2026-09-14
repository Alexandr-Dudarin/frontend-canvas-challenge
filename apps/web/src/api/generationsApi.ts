import type { GenerationData, GenerationRequest } from '@canvas/contracts';
import { ApiRequestError, invalidResponse } from './apiError';
import type { ApiResponse, HttpClient } from './httpClient';
import {
  isGeneration,
  isGenerationInput,
  isGenerations,
  isIdempotencyKey,
} from './responseSchemas';

const collection = (spaceId: string) => `/api/spaces/${encodeURIComponent(spaceId)}/generations`;
const resource = (spaceId: string, id: string) =>
  `${collection(spaceId)}/${encodeURIComponent(id)}`;

function checkResource(response: ApiResponse<GenerationData>, spaceId: string, id?: string) {
  const { data, meta } = response;
  if (
    data.spaceId !== spaceId ||
    (id !== undefined && data.id !== id) ||
    (data.status === 'succeeded' &&
      (!data.imageUrl || !data.imageUrl.startsWith('/') || data.imageUrl.startsWith('//'))) ||
    (meta.location !== null && meta.location !== resource(spaceId, data.id))
  )
    throw invalidResponse(meta);
  return response;
}

export function createGenerationsApi(client: HttpClient) {
  return {
    async list(spaceId: string, signal?: AbortSignal) {
      const response = await client.request(collection(spaceId), {
        signal,
        validateData: isGenerations,
      });
      for (const data of response.data) checkResource({ data, meta: response.meta }, spaceId);
      return response;
    },
    async get(spaceId: string, id: string, signal?: AbortSignal, location?: string) {
      const path = resource(spaceId, id);
      if (location !== undefined && location !== path)
        throw new ApiRequestError(
          'Адрес generation не соответствует её id.',
          'request',
          'INVALID_GENERATION_LOCATION',
        );
      return checkResource(
        await client.request(location ?? path, { signal, validateData: isGeneration }),
        spaceId,
        id,
      );
    },
    async create(spaceId: string, body: GenerationRequest, key: string, signal?: AbortSignal) {
      if (!isGenerationInput(body) || !isIdempotencyKey(key))
        throw new ApiRequestError(
          'Некорректные данные запуска.',
          'request',
          'INVALID_GENERATION_INPUT',
        );
      const response = checkResource(
        await client.request(collection(spaceId), {
          method: 'POST',
          body,
          headers: { 'Idempotency-Key': key },
          signal,
          validateData: isGeneration,
        }),
        spaceId,
      );
      const { data, meta } = response;
      if (
        data.nodeId !== body.nodeId ||
        data.graphETag !== body.graphETag ||
        data.scenario !== body.scenario ||
        ![200, 201, 202].includes(meta.status) ||
        (meta.status !== 200 && !meta.location) ||
        (meta.status === 202) !== (data.status === 'processing')
      )
        throw invalidResponse(meta);
      return response;
    },
  };
}

export type GenerationsApi = ReturnType<typeof createGenerationsApi>;
