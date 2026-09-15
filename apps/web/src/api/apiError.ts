import { isErrorResponse } from './responseSchemas';

export type ResponseMeta = {
  status: number;
  etag: string | null;
  location: string | null;
  retryAfter: string | null;
  requestId: string | null;
};

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'http' | 'invalid-response' | 'request' | 'aborted',
    readonly code: string,
    readonly meta?: ResponseMeta,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'ApiRequestError';
  }
}

export function httpError(meta: ResponseMeta, body: unknown): ApiRequestError {
  const error = isErrorResponse(body) ? body.error : undefined;
  return new ApiRequestError(
    error?.message ?? 'Сервер не выполнил запрос. Попробуйте ещё раз.',
    'http',
    error?.code ?? 'HTTP_ERROR',
    meta,
  );
}

export function invalidResponse(meta: ResponseMeta): ApiRequestError {
  return new ApiRequestError(
    'Ответ сервера не соответствует ожидаемому формату. Повторите загрузку.',
    'invalid-response',
    'INVALID_RESPONSE',
    meta,
  );
}

export function normalizeError(error: unknown, signal?: AbortSignal): ApiRequestError {
  if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
    return new ApiRequestError('Запрос отменён.', 'aborted', 'ABORTED', undefined, error);
  }
  if (error instanceof ApiRequestError) return error;
  return new ApiRequestError(
    'Не удалось связаться с API. Проверьте, что сервер запущен, и повторите загрузку.',
    'network',
    'NETWORK_ERROR',
    undefined,
    error,
  );
}
