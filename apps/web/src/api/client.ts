import { createHttpClient } from './httpClient';

export const apiClient = createHttpClient(
  import.meta.env.VITE_API_BASE_URL?.trim() || 'http://localhost:4001',
);
