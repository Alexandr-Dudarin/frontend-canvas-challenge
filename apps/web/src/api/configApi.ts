import { invalidResponse } from './apiError';
import type { HttpClient } from './httpClient';
import { isConfig } from './responseSchemas';

export function createConfigApi(client: HttpClient) {
  return {
    async get(signal?: AbortSignal) {
      const response = await client.request('/api/config', { signal, validateData: isConfig });
      if (response.data.pollIntervalMs <= 0) throw invalidResponse(response.meta);
      return response;
    },
  };
}
